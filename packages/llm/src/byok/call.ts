// BYOK calls (V3-33): the router hook (routeByok) and the check call of a saved key (checkByokKey). The key is
// decrypted by the resolver just before the request and lives only in this call's stack; errors are reduced to codes
// (no provider body, header or URL with the key ever goes into an error, a log or llm_calls).
import { randomUUID } from "node:crypto";
import { requestKey } from "../fixtures.js";
import { chatCall, LiveCallError } from "../providers.js";
import { HIGH_REASONING, type Registry, type RouteDef } from "../registry.js";
import type {
  CallType,
  LlmMode,
  LlmResult,
  LlmUsage,
  RouteInput,
  RouteOutput,
  UsageRecord,
  UsageSink,
} from "../types.js";
import { byokFetch } from "./net.js";
import { type ByokBody, byokDecision, hostViolation } from "./policy.js";

/** What the org's own key serves this call with; built by the platform (apps/platform-api/src/byok). */
export interface ByokRoute {
  /** platform.byok_keys.id — for the outcome report only. */
  keyId: string;
  /** Provider id of providers.json. */
  providerId: string;
  /** The model name as the provider or the gateway expects it. */
  model: string;
  /** Normalized base URL (direct provider URL or the user's gateway), already checked by byokBaseUrl. */
  baseUrl: string;
  body: ByokBody;
  /** false → «не проверена нами». */
  verified: boolean;
  /** Decrypts the key (envelope, OpenBao Transit) at call time; never kept by the router. */
  apiKey(): Promise<string>;
}

/** Outcome of a BYOK attempt: the platform keeps last_used_at / last_error_code of the key. */
export interface ByokOutcome {
  ok: boolean;
  /** LiveCallError code, BYOK_KEY_UNAVAILABLE or BYOK_URL_NOT_ALLOWED; null on success. */
  errorCode: string | null;
}

/** RouterOptions.byok: the org's own key for a call, or null (flag off, no consent, no active checked key). */
export interface ByokResolver {
  resolve(orgId: string, callType: CallType): Promise<ByokRoute | null>;
  /** Must not throw; called once per BYOK attempt. */
  report?(keyId: string, outcome: ByokOutcome): void | Promise<void>;
  /** HTTP of the calls; default byokFetch() (guarded DNS). Tests pass byokFetch({allowPrivateNetwork: true}). */
  fetch?: typeof globalThis.fetch;
  /** Tests and local stands only: the base URL may be a loopback or private host. */
  allowPrivateNetwork?: boolean;
}

/** Usage record id parts of BYOK attempts: provider `byok:<provider>`, model `byok:<model>`. */
export const BYOK_PREFIX = "byok:";

const MAX_BYOK_ATTEMPTS = 2;
const BYOK_BACKOFF_MS = 1000;
/** The longest Retry-After a BYOK attempt waits, ms (the router's MAX_RETRY_AFTER_MS, V3-18). */
const BYOK_MAX_RETRY_AFTER_MS = 30_000;

let sharedFetch: typeof globalThis.fetch | undefined;
/** The guarded fetch of the process (one undici agent for every BYOK call). */
const defaultByokFetch = (): typeof globalThis.fetch => {
  if (!sharedFetch) sharedFetch = byokFetch();
  return sharedFetch;
};

export interface RouteByokArgs {
  resolver: ByokResolver;
  input: RouteInput;
  callType: CallType;
  route: RouteDef;
  reg: Registry;
  sink: UsageSink;
  policyVersion: string;
  mode: LlmMode;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Aborted when the org policy starts forbidding calls outside RF (ruOnly, region) — the router repeats on T0. */
  policySignal: AbortSignal;
}

/**
 * The router hook: the call on the org's own key when the policy allows it (byokDecision) and the org has a usable key.
 * null → the call goes on along the platform chain as usual (no key, refused by policy, or the key failed — that
 * attempt is journaled with its error code and the key's outcome is reported).
 */
export async function routeByok(a: RouteByokArgs): Promise<RouteOutput | null> {
  const { input, callType, route } = a;
  if (a.mode !== "live") return null;
  const d = byokDecision(
    {
      callType,
      messages: input.messages,
      ...(input.containsPiiHint !== undefined ? { containsPiiHint: input.containsPiiHint } : {}),
      ...(input.orgPolicy !== undefined ? { orgPolicy: input.orgPolicy } : {}),
    },
    a.reg,
  );
  if (!d.ok) return null;
  let r: ByokRoute | null;
  try {
    r = await a.resolver.resolve(input.ctx.orgId, callType);
  } catch {
    return null;
  }
  if (!r) return null;

  const messages = d.messages;
  const key = requestKey({
    callType,
    modelId: `${BYOK_PREFIX}${r.model}`,
    messages,
    ...(input.tools ? { tools: input.tools } : {}),
    temperature: route.temperature,
    maxTokens: route.maxTokens,
    ...(input.ctx.runId ? { runId: input.ctx.runId } : {}),
    ...(input.ctx.systemId ? { systemId: input.ctx.systemId } : {}),
  });
  const write = async (
    fields: Pick<UsageRecord, "attempt" | "status" | "errorCode" | "latencyMs"> & {
      usage?: LlmUsage;
      toolCalls?: number;
    },
  ) => {
    const usage = fields.usage ?? { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    const rec: UsageRecord = {
      id: randomUUID(),
      runId: input.ctx.runId ?? null,
      orgId: input.ctx.orgId,
      systemId: input.ctx.systemId ?? null,
      step: input.ctx.step ?? null,
      callType,
      agentRole: route.role,
      // Outside the platform's RF contour, scrubbed (db.yaml#llm_calls: tier = 'T0' or scrubbed).
      tier: "T1",
      provider: `${BYOK_PREFIX}${r.providerId}`,
      modelId: `${BYOK_PREFIX}${r.model}`,
      attempt: fields.attempt,
      status: fields.status,
      errorCode: fields.errorCode,
      routeReason: d.decision.reason,
      fallbackFrom: null,
      policyVersion: a.policyVersion,
      scrubbed: true,
      piiCategoriesCount: { ...d.decision.dlp.counts },
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
      toolCalls: fields.toolCalls ?? 0,
      latencyMs: fields.latencyMs,
      ttftMs: null,
      // D77 (14б): the model part on the user's key is not charged from the balance.
      costRub: 0,
      creditsMilli: 0,
      billable: false,
      mode: a.mode,
      requestHash: key,
      createdAt: new Date(a.now()).toISOString(),
      byok: true,
    };
    await a.sink.write(rec);
  };
  const report = async (outcome: ByokOutcome) => {
    try {
      await a.resolver.report?.(r.keyId, outcome);
    } catch {
      // The journal of the key never breaks a model call.
    }
  };

  // Defence in depth: the resolver hands over a checked URL; a private host is refused here too.
  let host: string;
  try {
    host = new URL(r.baseUrl).hostname;
  } catch {
    host = "";
  }
  if (!host || hostViolation(host, { allowPrivateNetwork: a.resolver.allowPrivateNetwork === true })) {
    await write({ attempt: 0, status: "error", errorCode: "BYOK_URL_NOT_ALLOWED", latencyMs: 0 });
    await report({ ok: false, errorCode: "BYOK_URL_NOT_ALLOWED" });
    return null;
  }

  let apiKey: string;
  try {
    apiKey = await r.apiKey();
  } catch {
    await write({ attempt: 0, status: "error", errorCode: "BYOK_KEY_UNAVAILABLE", latencyMs: 0 });
    await report({ ok: false, errorCode: "BYOK_KEY_UNAVAILABLE" });
    return null;
  }
  const doFetch = a.resolver.fetch ?? defaultByokFetch();
  let lastCode: string | null = null;
  for (let attempt = 1; attempt <= MAX_BYOK_ATTEMPTS; attempt++) {
    const started = a.now();
    const signals = [
      AbortSignal.timeout(route.timeoutMs),
      a.policySignal,
      ...(input.signal ? [input.signal] : []),
    ];
    try {
      const out: { result: LlmResult; usage: LlmUsage } = await chatCall({
        bodyProfile: r.body === "openai" ? "byok" : r.body,
        baseURL: r.baseUrl,
        apiKey,
        modelName: r.model,
        messages,
        ...(input.tools ? { tools: input.tools } : {}),
        toolChoice: input.toolChoice ?? "auto",
        temperature: route.temperature,
        maxTokens: route.maxTokens,
        signal: AbortSignal.any(signals),
        fetch: doFetch,
        reasoning: HIGH_REASONING.has(callType) ? "high" : "low",
      });
      await write({
        attempt,
        status: "ok",
        errorCode: null,
        latencyMs: a.now() - started,
        usage: out.usage,
        toolCalls: out.result.toolCalls.length,
      });
      await report({ ok: true, errorCode: null });
      return {
        tier: "T1",
        model: `${BYOK_PREFIX}${r.model}`,
        result: out.result,
        usage: out.usage,
        creditsCharged: 0,
        creditsMilli: 0,
        routeReason: d.decision.reason,
        scrubbed: true,
        ruFallback: false,
        byok: true,
      };
    } catch (e) {
      const err = e instanceof LiveCallError ? e : new LiveCallError("NETWORK");
      const aborted = err.code === "ABORTED" || a.policySignal.aborted;
      lastCode = a.policySignal.aborted && !input.signal?.aborted ? "POLICY_CHANGED" : err.code;
      await write({
        attempt,
        status: err.code === "TIMEOUT" ? "timeout" : aborted ? "aborted" : "error",
        errorCode: lastCode,
        latencyMs: a.now() - started,
      });
      if (
        aborted ||
        !err.retryable ||
        err.code === "PROVIDER_BALANCE_EXHAUSTED" ||
        attempt === MAX_BYOK_ATTEMPTS ||
        // V3-18: a Retry-After past the cap is not waited for — the platform chain takes the call.
        (err.retryAfterMs !== null && err.retryAfterMs > BYOK_MAX_RETRY_AFTER_MS)
      )
        break;
      try {
        await a.sleep(err.retryAfterMs ?? BYOK_BACKOFF_MS);
      } catch {
        // The run was cancelled during the pause.
        lastCode = "ABORTED";
        break;
      }
    }
  }
  if (lastCode !== "POLICY_CHANGED" && lastCode !== "ABORTED")
    await report({ ok: false, errorCode: lastCode });
  return null;
}

// ---------------------------------------------------------------- check call

export type ByokCheckCode =
  | "KEY_INVALID"
  | "NO_BALANCE"
  | "RATE_LIMITED"
  | "REGION_BLOCKED"
  | "MODEL_NOT_FOUND"
  | "UNREACHABLE"
  | "PROVIDER_ERROR";

export type ByokCheck = { ok: true } | { ok: false; code: ByokCheckCode };

export interface ByokCheckInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const REGION_RE =
  /unsupported[_ ]country|country, region,? or territory|not available in your (country|region)|region (is )?not supported/i;
const BALANCE_RE =
  /insufficient[_ ](balance|funds|quota)|billing|payment required|recharge|no resource package|\b1113\b/i;

function codeOf(status: number, text: string): ByokCheckCode {
  if (REGION_RE.test(text)) return "REGION_BLOCKED";
  if (status === 402 || ((status === 429 || status === 403) && BALANCE_RE.test(text))) return "NO_BALANCE";
  if (status === 401 || status === 403) return "KEY_INVALID";
  if (status === 429) return "RATE_LIMITED";
  if (status === 404 || ((status === 400 || status === 422) && /model/i.test(text))) return "MODEL_NOT_FOUND";
  return "PROVIDER_ERROR";
}

/**
 * The check of a saved key: GET <base>/models (no tokens spent); when the list does not name the model or the
 * endpoint has no list, one tiny chat completion («ping», ≤ 16 tokens) to that model. Nothing of the answer is kept
 * but the verdict code.
 */
export async function checkByokKey(i: ByokCheckInput): Promise<ByokCheck> {
  const doFetch = i.fetch ?? defaultByokFetch();
  const timeoutMs = i.timeoutMs ?? 20_000;
  const headers = { authorization: `Bearer ${i.apiKey}`, accept: "application/json" };
  const request = async (
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; text: string } | null> => {
    try {
      const res = await doFetch(`${i.baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = (await res.text().catch(() => "")).slice(0, 4000);
      return { status: res.status, text };
    } catch {
      return null;
    }
  };
  const list = await request("/models", { method: "GET", headers });
  if (!list) return { ok: false, code: "UNREACHABLE" };
  if (list.status >= 200 && list.status < 300) {
    try {
      const ids = ((JSON.parse(list.text) as { data?: { id?: unknown }[] }).data ?? []).map((m) => m.id);
      if (ids.includes(i.model)) return { ok: true };
    } catch {
      // Not a list: the ping decides.
    }
  } else if (list.status !== 404 && list.status !== 405) {
    return { ok: false, code: list.status >= 500 ? "PROVIDER_ERROR" : codeOf(list.status, list.text) };
  }
  const ping = await request("/chat/completions", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model: i.model, messages: [{ role: "user", content: "ping" }], max_tokens: 16 }),
  });
  if (!ping) return { ok: false, code: "UNREACHABLE" };
  if (ping.status >= 200 && ping.status < 300) return { ok: true };
  return { ok: false, code: ping.status >= 500 ? "PROVIDER_ERROR" : codeOf(ping.status, ping.text) };
}
