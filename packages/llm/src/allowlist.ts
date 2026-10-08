// Gateway model allowlist (models.yaml#gateway_allowlist, product.yaml#decisions.D18_western_models): platform keys
// never reach the APIs of Anthropic, OpenAI, Google or xAI, nor their closed models resold by intermediaries (the
// Cloud.ru FM catalog sells GPT, Claude and Gemini as partner models). Open weights of these vendors served in RF
// (gpt-oss, whisper, gemma) stay allowed: the check looks at the provider, the host and the model, not at a prefix.
import type { ModelDef, ProviderDef, ProviderId } from "./registry.js";

export type AllowlistViolation =
  | "unknown_provider"
  | "bad_base_url"
  | "western_host"
  | "western_model"
  | "cloudru_not_internal";

/** Providers the gateway may call with platform keys. */
export const ALLOWED_PROVIDERS: readonly ProviderId[] = [
  "cloudru",
  "yandex",
  "zai",
  "moonshot",
  "deepseek",
  "openai_compatible",
];

/** Hosts (suffix match) of western model APIs and of the resellers of their models. */
export const WESTERN_API_HOSTS: readonly string[] = [
  "openai.com",
  "openai.azure.com",
  "anthropic.com",
  "claude.ai",
  "googleapis.com",
  "google.com",
  "x.ai",
  "grok.com",
  "openrouter.ai",
  "vercel.sh",
  "amazonaws.com",
];

/** Closed models of Anthropic, OpenAI, Google and xAI by name; gpt-oss, whisper and gemma do not match. */
export const WESTERN_CLOSED_MODEL_RE =
  /(?:^|[/:_\s-])(?:claude|gemini|imagen|grok|chatgpt|dall-e|sora|gpt-(?!oss)|o[1-9](?=$|[-_])|text-embedding-3)|^(?:anthropic|x-ai|xai)\//i;

/**
 * Cloud.ru FM models with placement «Внутренняя» (catalog snapshot 2026-10-08, models.yaml#providers.cloudru.internal_models).
 * Everything else in that catalog is a partner model proxied outside RF (GLM-5.2, DeepSeek-V4-Flash, MiMo-V2.5-Pro,
 * Qwen3-VL, GLM-4.6V, Claude, GPT, Gemini…) and is refused.
 */
export const CLOUDRU_INTERNAL_MODELS: readonly string[] = [
  "ai-sage/GigaChat3-10B-A1.8B",
  "ai-sage/GigaChat3.5-432B-A28B",
  "deepseek-ai/DeepSeek-V4-Pro",
  "GigaChat/GigaChat-2-Max",
  "MiniMaxAI/MiniMax-M2.5",
  "MiniMaxAI/MiniMax-M3",
  "moonshotai/Kimi-K2.6",
  "openai/gpt-oss-120b",
  "Qwen/Qwen3-Coder-Next",
  "Qwen/Qwen3.5-397B-A17B",
  "Qwen/Qwen3.6-35B-A3B",
  "zai-org/GLM-4.7",
  "zai-org/GLM-5.1",
];

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** null → the base URL may be called; otherwise why not. */
export function baseUrlViolation(baseUrl: string): AllowlistViolation | null {
  const host = hostOf(baseUrl);
  if (!host) return "bad_base_url";
  return WESTERN_API_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? "western_host" : null;
}

/** true → a closed model of Anthropic, OpenAI, Google or xAI (whatever provider serves it). */
export function isWesternClosedModel(providerModel: string): boolean {
  return WESTERN_CLOSED_MODEL_RE.test(providerModel);
}

/** null → the gateway may send this model to this provider at this base URL with platform keys. */
export function modelViolation(
  provider: Pick<ProviderDef, "id">,
  model: Pick<ModelDef, "providerModel" | "placement">,
  baseUrl: string,
): AllowlistViolation | null {
  if (!ALLOWED_PROVIDERS.includes(provider.id)) return "unknown_provider";
  const url = baseUrlViolation(baseUrl);
  if (url) return url;
  if (isWesternClosedModel(model.providerModel)) return "western_model";
  if (
    provider.id === "cloudru" &&
    (model.placement !== "internal" || !CLOUDRU_INTERNAL_MODELS.includes(model.providerModel))
  )
    return "cloudru_not_internal";
  return null;
}
