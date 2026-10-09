// Live calls through AI SDK 7 + @ai-sdk/openai-compatible (models.yaml#call_policy). Keys come only from env.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  APICallError,
  generateText,
  jsonSchema,
  type LanguageModelUsage,
  type ModelMessage,
  ToolChoiceViolationError,
  type ToolSet,
  tool,
} from "ai";
import { Agent, fetch as undiciFetch } from "undici";
import { modelViolation } from "./allowlist.js";
import type { ModelDef, ProviderDef } from "./registry.js";
import type { LlmMessage, LlmResult, LlmTool, LlmUsage } from "./types.js";
import { cachedInputTokens } from "./usage.js";

export type Env = Record<string, string | undefined>;

export type LiveErrorCode =
  | "NO_API_KEY"
  | "HTTP_429"
  | "HTTP_5xx"
  | "HTTP_400"
  | "HTTP_401"
  | "HTTP_403"
  | "HTTP_4xx"
  | "CONTEXT_TOO_LONG"
  | "TIMEOUT"
  | "NETWORK"
  | "EMPTY_RESPONSE"
  | "ABORTED"
  /** The provider account ran out of money (models.yaml#fallback_rules, D76): never retried, the provider is skipped. */
  | "PROVIDER_BALANCE_EXHAUSTED"
  /** Gateway allowlist (models.yaml#gateway_allowlist, D18): nothing was sent. */
  | "MODEL_NOT_ALLOWED";

const RETRYABLE: ReadonlySet<LiveErrorCode> = new Set([
  "HTTP_429",
  "HTTP_5xx",
  "TIMEOUT",
  "NETWORK",
  "EMPTY_RESPONSE",
]);

export class LiveCallError extends Error {
  readonly code: LiveErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: LiveErrorCode, retryAfterMs: number | null = null) {
    super(code);
    this.name = "LiveCallError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

/** Extra output tokens for the reasoning of zai models (reasoning_effort high); billed only as used. */
export const ZAI_REASONING_HEADROOM = 8192;

/** Body rewrite applied to every outgoing request (models.yaml#call_policy.thinking, #structured_output). */
export function transformBody(
  providerId: ProviderDef["id"] | "byok",
  body: Record<string, unknown>,
  reasoning: "low" | "high" = "high",
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  delete out.response_format;
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map((msg) => {
      if (msg === null || typeof msg !== "object") return msg;
      const { reasoning_content: _r, reasoning: _s, ...rest } = msg as Record<string, unknown>;
      return rest;
    });
  }
  if (providerId === "deepseek") {
    // DeepSeek thinks by default; with tools it then requires reasoning_content back, which we strip above → 400
    // on the second turn. So thinking is off for every DeepSeek call, with or without tools.
    delete out.reasoning_effort;
    delete out.enable_thinking;
    delete out.chat_template_kwargs;
    out.thinking = { type: "disabled" };
  } else if (providerId === "zai") {
    // glm-5.3 always thinks: `thinking: {type: "disabled"}` is a 400 («cannot be disabled; please use low, high, or
    // max», pilot eval 2026-10-05). Effort high only where the route asks for it (D75: card and brief), low elsewhere;
    // reasoning_content is still not sent back.
    delete out.thinking;
    delete out.enable_thinking;
    delete out.chat_template_kwargs;
    out.reasoning_effort = reasoning;
    // Reasoning tokens count against max_tokens: without headroom a short answer budget is spent on thinking alone
    // (finish=length, empty text — the 30-token probe on the pilot server).
    if (typeof out.max_tokens === "number") out.max_tokens += ZAI_REASONING_HEADROOM;
  } else if (Array.isArray(out.tools) && out.tools.length > 0) {
    delete out.reasoning_effort;
    delete out.enable_thinking;
    delete out.thinking;
    // Cloud.ru FM and own vLLM servers take the chat template switch of reasoning models (Qwen3, GLM).
    if (providerId === "cloudru" || providerId === "openai_compatible")
      out.chat_template_kwargs = { enable_thinking: false };
    else delete out.chat_template_kwargs;
    // Guided decoding of Cloud.ru models (gigachat-3.5) rejects JSON Schema keys it has not implemented: «Grammar
    // error: Unimplemented keys: ["propertyNames"]» (shape probe 2026-10-09). The answer is checked by our schema anyway.
    out.tools = out.tools.map((t) => withoutSchemaKeys(t, UNSUPPORTED_SCHEMA_KEYS));
  }
  return out;
}

/** JSON Schema keys the T0 providers' guided decoding does not implement (dropped from tool schemas). */
const UNSUPPORTED_SCHEMA_KEYS: ReadonlySet<string> = new Set(["propertyNames"]);

/** Schema keys whose value maps names to schemas (a name there is never a keyword). */
const SCHEMA_MAPS: ReadonlySet<string> = new Set(["properties", "patternProperties", "$defs", "definitions"]);

/**
 * A deep copy of `v` without the given keywords inside any `parameters` schema (a tool definition keeps its own keys,
 * a property that happens to be named like a keyword stays).
 */
function withoutSchemaKeys(v: unknown, keys: ReadonlySet<string>, inSchema = false, names = false): unknown {
  if (Array.isArray(v)) return v.map((x) => withoutSchemaKeys(x, keys, inSchema));
  if (v === null || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (inSchema && !names && keys.has(k)) continue;
    const schema = inSchema || k === "parameters";
    out[k] = withoutSchemaKeys(x, keys, schema, schema && !names && SCHEMA_MAPS.has(k));
  }
  return out;
}

function toModelMessages(messages: readonly LlmMessage[]): ModelMessage[] {
  return messages.map((msg): ModelMessage => {
    switch (msg.role) {
      case "system":
        return { role: "system", content: msg.content };
      case "user":
        if (!msg.attachments?.length) return { role: "user", content: msg.content };
        // Images go out as image_url, PDFs as file parts (@ai-sdk/openai-compatible); T0 only (policy.ts).
        return {
          role: "user",
          content: [
            { type: "text" as const, text: msg.content },
            ...msg.attachments.map((a) => ({
              type: "file" as const,
              data: a.data,
              mediaType: a.mime,
              ...(a.name ? { filename: a.name } : {}),
            })),
          ],
        };
      case "assistant": {
        if (!msg.toolCalls?.length) return { role: "assistant", content: msg.content };
        const text = msg.content ? [{ type: "text" as const, text: msg.content }] : [];
        return {
          role: "assistant",
          content: [
            ...text,
            ...msg.toolCalls.map((t) => ({
              type: "tool-call" as const,
              toolCallId: t.id,
              toolName: t.name,
              input: t.args,
            })),
          ],
        };
      }
      default:
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: msg.toolCallId,
              toolName: msg.toolName,
              output:
                typeof msg.content === "string"
                  ? { type: "text", value: msg.content }
                  : { type: "json", value: (msg.content ?? null) as never },
            },
          ],
        };
    }
  });
}

export interface LiveCallInput {
  provider: ProviderDef;
  model: ModelDef;
  messages: readonly LlmMessage[];
  tools?: readonly LlmTool[];
  toolChoice: "auto" | "required";
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  env: Env;
  fetch?: typeof globalThis.fetch;
  /** Reasoning effort of models that always think (zai); default high. */
  reasoning?: "low" | "high";
}

/**
 * HTTP of the model calls. Node's fetch waits at most 300 s for response headers (undici headersTimeout): a
 * non-streaming call of a reasoning model answers only when the whole output is ready, so long calls broke at
 * exactly 300 s as NETWORK and fell back to a model without the prompt cache (D67 eval 06.10.2026: max 301.7 s on
 * fix, build_ops and plan; 46 fallback fix calls cost as much as 200 cached ones). The limit of a call is the route's
 * timeout_ms through the AbortSignal; the agent only must not cut it earlier.
 */
export const LLM_HTTP_TIMEOUT_MS = 15 * 60_000;

/** fetch over an undici agent with the given header/body timeouts (default LLM_HTTP_TIMEOUT_MS). */
export function llmFetch(timeoutMs = LLM_HTTP_TIMEOUT_MS): typeof globalThis.fetch {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  return ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as typeof globalThis.fetch;
}

let sharedFetch: typeof globalThis.fetch | undefined;
const defaultFetch = () => {
  sharedFetch ??= llmFetch();
  return sharedFetch;
};

/** The base URL a provider is called at: env override, else the default. */
export function providerBaseUrl(provider: ProviderDef, env: Env): string {
  return env[provider.baseUrlEnv] || provider.defaultBaseUrl;
}

export async function liveCall(i: LiveCallInput): Promise<{ result: LlmResult; usage: LlmUsage }> {
  const baseURL = providerBaseUrl(i.provider, i.env);
  // The router checks the allowlist first; this is the last line before the socket.
  if (modelViolation(i.provider, i.model, baseURL)) throw new LiveCallError("MODEL_NOT_ALLOWED");
  const apiKey = i.env[i.provider.apiKeyEnv];
  if (!apiKey && !i.provider.apiKeyOptional) throw new LiveCallError("NO_API_KEY");
  const folder = i.provider.folderEnv ? i.env[i.provider.folderEnv] : undefined;
  return chatCall({
    bodyProfile: i.provider.id,
    baseURL,
    ...(apiKey ? { apiKey } : {}),
    ...(i.provider.requiredHeaders ? { headers: i.provider.requiredHeaders } : {}),
    modelName: folder ? `gpt://${folder}/${i.model.providerModel}` : i.model.providerModel,
    messages: i.messages,
    ...(i.tools ? { tools: i.tools } : {}),
    toolChoice: i.toolChoice,
    temperature: i.temperature,
    maxTokens: i.maxTokens,
    signal: i.signal,
    ...(i.fetch ? { fetch: i.fetch } : {}),
    ...(i.reasoning ? { reasoning: i.reasoning } : {}),
  });
}

/** One chat completion at an OpenAI-compatible endpoint; the caller has already chosen the URL and the key. */
export interface ChatCallInput {
  /** Which request-body rules apply (transformBody); "byok" — the generic ones. */
  bodyProfile: ProviderDef["id"] | "byok";
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  modelName: string;
  messages: readonly LlmMessage[];
  tools?: readonly LlmTool[];
  toolChoice: "auto" | "required";
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  reasoning?: "low" | "high";
}

/**
 * The HTTP call shared by platform providers (liveCall) and the users' own keys (byok/call.ts). Errors are reduced to a
 * LiveCallError code: provider bodies, headers and the key never travel further (data-boundary.yaml#storage_of_content).
 */
export async function chatCall(i: ChatCallInput): Promise<{ result: LlmResult; usage: LlmUsage }> {
  const client = createOpenAICompatible({
    name: i.bodyProfile,
    baseURL: i.baseURL,
    ...(i.apiKey ? { apiKey: i.apiKey } : {}),
    ...(i.headers ? { headers: i.headers } : {}),
    fetch: i.fetch ?? defaultFetch(),
    includeUsage: true,
    supportsStructuredOutputs: false,
    transformRequestBody: (body) => transformBody(i.bodyProfile, body, i.reasoning ?? "high"),
  });
  const tools: ToolSet | undefined = i.tools?.length
    ? Object.fromEntries(
        i.tools.map((t) => [
          t.name,
          tool({ description: t.description, inputSchema: jsonSchema(t.parameters) }),
        ]),
      )
    : undefined;
  // The usage of the model call as the SDK reported it before its own checks (a tool-choice violation throws after).
  let callUsage: { usage: LanguageModelUsage; raw: unknown } | null = null;
  try {
    const res = await generateText({
      model: client.chatModel(i.modelName),
      messages: toModelMessages(i.messages),
      allowSystemInMessages: true,
      ...(tools ? { tools, toolChoice: i.toolChoice } : {}),
      temperature: i.temperature,
      maxOutputTokens: i.maxTokens,
      maxRetries: 0,
      abortSignal: i.signal,
      onLanguageModelCallEnd: (e) => {
        callUsage = { usage: e.usage, raw: e.usage.raw };
      },
    });
    const toolCalls = res.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, args: c.input }));
    if (!res.text && toolCalls.length === 0) throw new LiveCallError("EMPTY_RESPONSE");
    const result: LlmResult = { toolCalls, finishReason: String(res.finishReason) };
    if (res.text) result.text = res.text;
    const inputTokens = res.usage.inputTokens ?? 0;
    return {
      result,
      usage: {
        inputTokens,
        // The raw usage of the (single) step: providers that report the cache outside prompt_tokens_details.
        cachedTokens: cachedInputTokens(
          inputTokens,
          res.usage.inputTokenDetails?.cacheReadTokens,
          res.steps.at(-1)?.usage.raw,
        ),
        outputTokens: res.usage.outputTokens ?? 0,
      },
    };
  } catch (e) {
    // toolChoice required, the model answered with text: an answer (billed by the provider), not a network error —
    // the caller decides (callTool: NO_TOOL_CALL repair or textArgs). AI SDK 7 throws it after the call has ended.
    const answered = callUsage as { usage: LanguageModelUsage; raw: unknown } | null;
    if (ToolChoiceViolationError.isInstance(e) && answered) {
      const text = e.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("")
        .trim();
      if (!text) throw new LiveCallError("EMPTY_RESPONSE");
      const inputTokens = answered.usage.inputTokens ?? 0;
      return {
        result: { toolCalls: [], text, finishReason: String(e.finishReason) },
        usage: {
          inputTokens,
          cachedTokens: cachedInputTokens(
            inputTokens,
            answered.usage.inputTokenDetails?.cacheReadTokens,
            answered.raw,
          ),
          outputTokens: answered.usage.outputTokens ?? 0,
        },
      };
    }
    throw classify(e, i.signal);
  }
}

/**
 * Balance errors of the providers (models.yaml#fallback_rules): Z.ai answers 429 with code 1113 «Insufficient balance or
 * no resource package» (06.10.2026); any 402 Payment Required; a 403/429 whose text names the balance, funds or billing
 * (Cloud.ru and OpenAI-compatible gateways: insufficient_quota, «недостаточно средств»). A plain rate limit is not one.
 */
const BALANCE_RE =
  /\b1113\b|insufficient[ _](balance|funds|quota)|no resource package|balance (is )?(exhausted|insufficient|not enough)|not enough (balance|funds)|payment required|billing|recharge|недостаточно средств|баланс|задолженност/i;

/** true → the HTTP answer means «no money on the account», not overload. */
export function isBalanceError(status: number, text: string): boolean {
  if (status === 402) return true;
  return (status === 429 || status === 403) && BALANCE_RE.test(text);
}

function classify(e: unknown, signal: AbortSignal): LiveCallError {
  if (e instanceof LiveCallError) return e;
  if (APICallError.isInstance(e)) {
    const s = e.statusCode ?? 0;
    if (isBalanceError(s, `${e.message} ${e.responseBody ?? ""}`))
      return new LiveCallError("PROVIDER_BALANCE_EXHAUSTED");
    const ra = Number(e.responseHeaders?.["retry-after"]);
    const retryAfterMs = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : null;
    if (s === 429) return new LiveCallError("HTTP_429", retryAfterMs);
    if (s >= 500) return new LiveCallError("HTTP_5xx", retryAfterMs);
    if (s === 400 && /context|too long|maximum.*tokens/i.test(e.message)) {
      return new LiveCallError("CONTEXT_TOO_LONG");
    }
    if (s === 400 || s === 401 || s === 403) return new LiveCallError(`HTTP_${s}`);
    if (s >= 400) return new LiveCallError("HTTP_4xx");
    return new LiveCallError("NETWORK");
  }
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    const timeout = reason instanceof Error && reason.name === "TimeoutError";
    return new LiveCallError(timeout ? "TIMEOUT" : "ABORTED");
  }
  return new LiveCallError("NETWORK");
}
