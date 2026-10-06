// Deterministic routing policy: models.yaml#routing_algorithm steps 1–7, constraints of data-boundary.yaml#routing.
import { KIND_INFO, type Kind, scrubJson } from "@wizard/pii";
import { LlmError } from "./errors.js";
import { PII_FORBIDDEN_FOR_T1, type Registry } from "./registry.js";
import {
  CALL_TYPES,
  type CallType,
  type LlmMessage,
  type OrgPolicy,
  type PiiCounts,
  type RouteReason,
  type Tier,
  type ToolCall,
} from "./types.js";

export interface Dlp {
  counts: PiiCounts;
  total: number;
  highRisk: boolean;
}

export interface PolicyDecision {
  tier: Tier;
  reason: RouteReason;
  dlp: Dlp;
  /** Messages after pii scrub (one numbering across the whole call). Always computed: fixture keys use it for any tier. */
  scrubbedMessages: LlmMessage[];
}

export function isCallType(v: string): v is CallType {
  return (CALL_TYPES as readonly string[]).includes(v);
}

/** A multimodal call: some user message carries an image or a PDF (M3-02). */
export function hasAttachments(messages: readonly LlmMessage[]): boolean {
  return messages.some((m) => m.role === "user" && (m.attachments?.length ?? 0) > 0);
}

/**
 * Hard guard of the T0-only calls (data-boundary.yaml#call_types: runtime_ai_*, support; multimodal calls of
 * models.yaml#credits.runtime_ai). The router checks it before every attempt, whatever the policy decided.
 */
export function t1Forbidden(callType: CallType, messages: readonly LlmMessage[]): boolean {
  return PII_FORBIDDEN_FOR_T1.always.includes(callType) || hasAttachments(messages);
}

/** Throws T1_FORBIDDEN when a T1 model is about to receive a T0-only call. */
export function assertTierAllowed(callType: CallType, tier: Tier, messages: readonly LlmMessage[]): void {
  if (tier === "T1" && t1Forbidden(callType, messages))
    throw new LlmError("T1_FORBIDDEN", "Этот вызов модели разрешён только на моделях в РФ.", { callType });
}

type Part = { c: unknown; a?: unknown[] };

/** Scrubs only user-carried payload (content, tool-call args); structural fields stay untouched. */
export function scrubMessagesForT1(messages: readonly LlmMessage[]): { messages: LlmMessage[]; dlp: Dlp } {
  const parts: Part[] = messages.map((msg) =>
    msg.role === "assistant" && msg.toolCalls
      ? { c: msg.content, a: msg.toolCalls.map((t) => t.args) }
      : { c: msg.content },
  );
  const res = scrubJson(parts);
  const out = messages.map((msg, i): LlmMessage => {
    const p = res.value[i] as Part;
    if (msg.role === "tool") return { ...msg, content: p.c };
    if (msg.role === "assistant") {
      const toolCalls = msg.toolCalls?.map((t, j): ToolCall => ({ ...t, args: p.a?.[j] }));
      return toolCalls ? { ...msg, content: String(p.c), toolCalls } : { ...msg, content: String(p.c) };
    }
    return { ...msg, content: String(p.c) };
  });
  let total = 0;
  let highRisk = res.strongIds;
  for (const [kind, n] of Object.entries(res.counts) as [Kind, number][]) {
    total += n;
    const info = KIND_INFO[kind];
    if (info.strong || info.category === "special" || info.category === "biometric") highRisk = true;
  }
  return { messages: out, dlp: { counts: res.counts, total, highRisk } };
}

export interface DecideInput {
  callType: CallType;
  messages: readonly LlmMessage[];
  containsPiiHint?: boolean;
  orgPolicy?: OrgPolicy | null;
}

export function decideTier(input: DecideInput, reg: Registry): PolicyDecision {
  let scrubbed: { messages: LlmMessage[]; dlp: Dlp };
  try {
    scrubbed = scrubMessagesForT1(input.messages);
  } catch {
    // Step 9: detector failure → T0. Nothing leaves RF, so the unscrubbed messages are kept.
    return {
      tier: "T0",
      reason: "pii_high_risk",
      dlp: { counts: {}, total: 0, highRisk: true },
      scrubbedMessages: [...input.messages],
    };
  }
  const { dlp } = scrubbed;
  const t0 = (reason: RouteReason): PolicyDecision => ({
    tier: "T0",
    reason,
    dlp,
    scrubbedMessages: scrubbed.messages,
  });
  const policy = input.orgPolicy;
  const ct = input.callType;
  if (policy?.ruOnly === true) return t0("policy_ru_only");
  if (policy?.t1Restricted !== false) return t0("policy_region_restricted");
  if (PII_FORBIDDEN_FOR_T1.always.includes(ct)) return t0("callType_forbidden_T1");
  // Images and PDFs cannot be scrubbed: a multimodal call is T0 whatever its callType (M3-02).
  if (hasAttachments(input.messages)) return t0("pii_hint");
  if (
    PII_FORBIDDEN_FOR_T1.conditional.includes(ct) &&
    !(input.containsPiiHint === false && dlp.total === 0)
  ) {
    return t0("callType_forbidden_T1");
  }
  if (input.containsPiiHint === true) return t0("pii_hint");
  if (dlp.highRisk) return t0("pii_high_risk");
  if (ct === "interview" && dlp.total > 0) return t0("pii_detected_interview");
  const route = reg.routes[ct];
  const tier: Tier = route.defaultTier === "T1" && reg.buildDefaultTier === "T1" ? "T1" : "T0";
  return tier === "T1"
    ? { tier, reason: "default_T1", dlp, scrubbedMessages: scrubbed.messages }
    : t0("default_T0");
}

const TOKEN_RE = /tok_[a-z_]+_[A-Z2-7]{16}/;

/** true → the messages carry reversible PII tokens (data-boundary.yaml#tokenization). */
export function containsTokens(messages: readonly LlmMessage[]): boolean {
  return TOKEN_RE.test(JSON.stringify(messages));
}

/** data-boundary.yaml#tokenization.guard: reversible tokens never go to T1. */
export function assertNoTokens(messages: readonly LlmMessage[]): void {
  if (containsTokens(messages)) {
    throw new LlmError(
      "PII_TOKEN_IN_T1_PAYLOAD",
      "Запрос содержит токены персональных данных и не может быть отправлен.",
    );
  }
}
