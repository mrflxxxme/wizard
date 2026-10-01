// Live calls through AI SDK 7 + @ai-sdk/openai-compatible (models.yaml#call_policy). Keys come only from env.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText, jsonSchema, type ModelMessage, type ToolSet, tool } from "ai";
import type { ModelDef, ProviderDef } from "./registry.js";
import type { LlmMessage, LlmResult, LlmTool, LlmUsage } from "./types.js";

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
  | "ABORTED";

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

/** Body rewrite applied to every outgoing request (models.yaml#call_policy.thinking, #structured_output). */
export function transformBody(
  providerId: ProviderDef["id"],
  body: Record<string, unknown>,
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
  } else if (Array.isArray(out.tools) && out.tools.length > 0) {
    delete out.reasoning_effort;
    delete out.enable_thinking;
    if (providerId === "zai") out.thinking = { type: "disabled" };
    else delete out.thinking;
    if (providerId === "cloudru") out.chat_template_kwargs = { enable_thinking: false };
    else delete out.chat_template_kwargs;
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
}

export async function liveCall(i: LiveCallInput): Promise<{ result: LlmResult; usage: LlmUsage }> {
  const apiKey = i.env[i.provider.apiKeyEnv];
  if (!apiKey) throw new LiveCallError("NO_API_KEY");
  const baseURL = i.env[i.provider.baseUrlEnv] || i.provider.defaultBaseUrl;
  const client = createOpenAICompatible({
    name: i.provider.id,
    baseURL,
    apiKey,
    ...(i.provider.requiredHeaders ? { headers: i.provider.requiredHeaders } : {}),
    ...(i.fetch ? { fetch: i.fetch } : {}),
    includeUsage: true,
    supportsStructuredOutputs: false,
    transformRequestBody: (body) => transformBody(i.provider.id, body),
  });
  const folder = i.provider.folderEnv ? i.env[i.provider.folderEnv] : undefined;
  const modelName = folder ? `gpt://${folder}/${i.model.providerModel}` : i.model.providerModel;
  const tools: ToolSet | undefined = i.tools?.length
    ? Object.fromEntries(
        i.tools.map((t) => [
          t.name,
          tool({ description: t.description, inputSchema: jsonSchema(t.parameters) }),
        ]),
      )
    : undefined;
  try {
    const res = await generateText({
      model: client.chatModel(modelName),
      messages: toModelMessages(i.messages),
      allowSystemInMessages: true,
      ...(tools ? { tools, toolChoice: i.toolChoice } : {}),
      temperature: i.temperature,
      maxOutputTokens: i.maxTokens,
      maxRetries: 0,
      abortSignal: i.signal,
    });
    const toolCalls = res.toolCalls.map((c) => ({ id: c.toolCallId, name: c.toolName, args: c.input }));
    if (!res.text && toolCalls.length === 0) throw new LiveCallError("EMPTY_RESPONSE");
    const result: LlmResult = { toolCalls, finishReason: String(res.finishReason) };
    if (res.text) result.text = res.text;
    return {
      result,
      usage: {
        inputTokens: res.usage.inputTokens ?? 0,
        cachedTokens: res.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        outputTokens: res.usage.outputTokens ?? 0,
      },
    };
  } catch (e) {
    throw classify(e, i.signal);
  }
}

function classify(e: unknown, signal: AbortSignal): LiveCallError {
  if (e instanceof LiveCallError) return e;
  if (APICallError.isInstance(e)) {
    const s = e.statusCode ?? 0;
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
