// Public types of @wizard/llm (architecture.yaml#interfaces.llm_call, specs/agents/models.yaml).
import type { Kind } from "@wizard/pii";

export const CALL_TYPES = [
  "interview",
  "card",
  "plan",
  "system_plan",
  "build_texts",
  "build_design",
  "build_custom",
  "build_ops",
  "build_code",
  "fix",
  "qa_generate",
  "qa_explain",
  "audit",
  "import_mapping",
  "runtime_ai_extract",
  "runtime_ai_generate",
  "support",
  // V3-16 (builder-v3.md C7): stages of the v3 pipeline.
  "interview_v3",
  "brief_extract",
  "art_direction",
  "page_compose",
  "signature_section",
  "critic_visual",
  "techreview",
  "research",
] as const;
export type CallType = (typeof CALL_TYPES)[number];
/** AI actions of systems (M3-02): T0 only. */
export type RuntimeAiCallType = "runtime_ai_extract" | "runtime_ai_generate";

export type Tier = "T0" | "T1";
export type LlmMode = "fixture" | "live" | "record";

export const ROUTE_REASONS = [
  "policy_ru_only",
  "policy_region_restricted",
  "callType_forbidden_T1",
  "pii_hint",
  "pii_high_risk",
  "pii_detected_interview",
  "default_T1",
  "default_T0",
  "fallback_circuit_open",
  "fallback_error",
] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * Image or PDF of a multimodal call (M3-02: file fields of runtime AI actions). Base64 bytes; such a call is T0 only
 * (models.yaml#credits.runtime_ai «мультимодальные вызовы — T0 only»): decideTier and the router guard enforce it.
 */
export interface LlmAttachment {
  mime: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  /** Base64 of the file bytes. */
  data: string;
  name?: string;
}

/** Chat message in a provider-neutral shape. reasoning_content is never part of it (models.yaml#call_policy.thinking). */
export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; attachments?: LlmAttachment[] }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; toolName: string; content: unknown };

/** Tool definition; `parameters` is a JSON Schema (agents generate it with z.toJSONSchema). */
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OrgPolicy {
  ruOnly?: boolean;
  /** Anything but an explicit `false` (missing, null, undefined) means restricted — fail-safe T0. */
  t1Restricted?: boolean | null;
}

export interface RouteContext {
  orgId: string;
  runId?: string;
  systemId?: string;
  step?: string;
  budget?: { capCredits: number; spentCredits: number };
}

export interface RouteInput {
  callType: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  toolChoice?: "auto" | "required";
  containsPiiHint?: boolean;
  /** Missing policy = not loaded → fail-safe T0 (models.yaml#routing_algorithm 2a). */
  orgPolicy?: OrgPolicy | null;
  /**
   * Model families (modelFamily) the chain must skip: the reviewer of a run is of another family than its builder
   * (techreview, audit). Nothing left → LLM_UNAVAILABLE.
   */
  avoidFamilies?: readonly string[];
  ctx: RouteContext;
  signal?: AbortSignal;
}

export interface LlmResult {
  text?: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface LlmUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface RouteOutput {
  tier: Tier;
  /** Model id from models.yaml#models. */
  model: string;
  result: LlmResult;
  /** Usage of the successful attempt. */
  usage: LlmUsage;
  /** Credits of all billable attempts of this call (creditsMilli / 1000). */
  creditsCharged: number;
  creditsMilli: number;
  routeReason: RouteReason;
  scrubbed: boolean;
  /** The call fell back from T1 to T0 (workflows.yaml step_finished.ruFallback). */
  ruFallback: boolean;
}

export type PiiCounts = Partial<Record<Kind, number>>;

/** models.yaml#usage_record — one record per HTTP attempt; never contains prompt or response text. */
export interface UsageRecord {
  id: string;
  runId: string | null;
  orgId: string;
  systemId: string | null;
  step: string | null;
  callType: CallType;
  agentRole: string;
  tier: Tier;
  provider: string;
  modelId: string;
  attempt: number;
  status: "ok" | "error" | "timeout" | "circuit_open" | "aborted";
  errorCode: string | null;
  routeReason: RouteReason;
  fallbackFrom: string | null;
  policyVersion: string;
  scrubbed: boolean;
  piiCategoriesCount: PiiCounts;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  toolCalls: number;
  latencyMs: number;
  ttftMs: number | null;
  costRub: number;
  creditsMilli: number;
  billable: boolean;
  mode: LlmMode;
  requestHash: string;
  createdAt: string;
}

export interface UsageSink {
  write(record: UsageRecord): void | Promise<void>;
}

/** Internal journal event (never sent to the user's SSE). */
export type LlmEvent = {
  type: "model_switched";
  fromModel: string;
  toModel: string;
  reason: "fallback_circuit_open" | "fallback_error";
};
