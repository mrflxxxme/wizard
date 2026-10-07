// Model registry: a typed mirror of specs/agents/models.yaml (#providers, #models, #routes, #week0_decision).
// test/registry.test.ts checks it line by line against the YAML.
import { createHash } from "node:crypto";
import type { CallType, OrgPolicy, Tier } from "./types.js";

export type ProviderId = "cloudru" | "yandex" | "zai" | "moonshot" | "deepseek";

export interface ProviderDef {
  id: ProviderId;
  tier: Tier;
  baseUrlEnv: string;
  defaultBaseUrl: string;
  apiKeyEnv: string;
  folderEnv?: string;
  requiredHeaders?: Record<string, string>;
  enabled: boolean;
  termsCheckedAt?: string;
}

export interface ModelDef {
  id: string;
  provider: ProviderId;
  providerModel: string;
  tier: Tier;
  placement: "internal" | "external";
  context: number;
  /** ₽ per 1M tokens incl. VAT. */
  price: { input: number; cached: number; output: number };
  enabled: boolean;
}

export interface RouteDef {
  role: string;
  defaultTier: Tier;
  chain: Partial<Record<Tier, string[]>>;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

export interface Registry {
  providers: Record<ProviderId, ProviderDef>;
  models: ModelDef[];
  routes: Record<CallType, RouteDef>;
  /** models.yaml#week0_decision.switch — the single build-tier parameter (product.yaml#decisions.D2_w0_fallback). */
  buildDefaultTier: Tier;
  rubPerCredit: number;
  piiVersion: string;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  cloudru: {
    id: "cloudru",
    tier: "T0",
    baseUrlEnv: "CLOUDRU_BASE_URL",
    defaultBaseUrl: "https://foundation-models.api.cloud.ru/v1",
    apiKeyEnv: "CLOUDRU_API_KEY",
    enabled: true,
  },
  yandex: {
    id: "yandex",
    tier: "T0",
    baseUrlEnv: "YANDEX_BASE_URL",
    defaultBaseUrl: "https://llm.api.cloud.yandex.net/v1",
    apiKeyEnv: "YANDEX_API_KEY",
    folderEnv: "YANDEX_FOLDER_ID",
    requiredHeaders: { "x-data-logging-enabled": "false" },
    enabled: true,
  },
  zai: {
    id: "zai",
    tier: "T1",
    baseUrlEnv: "ZAI_BASE_URL",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    enabled: true,
    termsCheckedAt: "2026-09-30",
  },
  moonshot: {
    id: "moonshot",
    tier: "T1",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    defaultBaseUrl: "",
    apiKeyEnv: "MOONSHOT_API_KEY",
    enabled: false,
    termsCheckedAt: "2026-09-30",
  },
  // Eval challenger only (models.yaml#providers.deepseek): its models are enabled=false and in no route chain.
  deepseek: {
    id: "deepseek",
    tier: "T1",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    enabled: true,
    termsCheckedAt: "2026-10-01",
  },
};

const m = (
  id: string,
  provider: ProviderId,
  providerModel: string,
  tier: Tier,
  placement: ModelDef["placement"],
  context: number,
  input: number,
  cached: number,
  output: number,
  enabled = true,
): ModelDef => ({
  id,
  provider,
  providerModel,
  tier,
  placement,
  context,
  price: { input, cached, output },
  enabled,
});

export const MODELS: ModelDef[] = [
  m("kimi-k2.6", "cloudru", "moonshotai/Kimi-K2.6", "T0", "internal", 262000, 175.68, 175.68, 725.9),
  m("deepseek-v4-pro", "cloudru", "deepseek-ai/DeepSeek-V4-Pro", "T0", "internal", 1000000, 183, 183, 732),
  m("glm-5.1", "cloudru", "zai-org/GLM-5.1", "T0", "internal", 202000, 198.86, 198.86, 829.6),
  m("qwen3-coder-next", "cloudru", "Qwen/Qwen3-Coder-Next", "T0", "internal", 262000, 122, 122, 244),
  m("gpt-oss-120b", "cloudru", "openai/gpt-oss-120b", "T0", "internal", 131000, 15.86, 15.86, 61),
  m(
    "gigachat-3.5",
    "cloudru",
    "ai-sage/GigaChat3.5-432B-A28B",
    "T0",
    "internal",
    262000,
    96.22,
    96.22,
    288.6,
  ),
  m("yandex-qwen3-235b", "yandex", "qwen3-235b-a22b-fp8/latest", "T0", "internal", 262000, 500, 500, 500),
  m(
    "yandex-deepseek-v4-flash",
    "yandex",
    "deepseek-v4-flash/latest",
    "T0",
    "internal",
    1000000,
    300,
    75,
    500,
  ),
  m("glm-5.3", "zai", "glm-5.3", "T1", "external", 200000, 162, 30, 510),
  m("kimi-k3", "moonshot", "kimi-k3", "T1", "external", 256000, 348, 34.8, 1739, false),
  m(
    "deepseek-v4.1-flash",
    "deepseek",
    "deepseek-flash",
    "T1",
    "external",
    1000000,
    34.77,
    0.7,
    139.08,
    false,
  ),
  m(
    "deepseek-v4-pro-0813",
    "deepseek",
    "deepseek-v4-pro",
    "T1",
    "external",
    1000000,
    152.99,
    5.1,
    458.96,
    false,
  ),
];

const r = (
  role: string,
  defaultTier: Tier,
  chain: Partial<Record<Tier, string[]>>,
  temperature: number,
  maxTokens: number,
  timeoutMs: number,
): RouteDef => ({ role, defaultTier, chain, temperature, maxTokens, timeoutMs });

const ORCH_T0 = ["glm-5.1", "kimi-k2.6", "deepseek-v4-pro", "yandex-qwen3-235b"];
const CODE_T0 = ["deepseek-v4-pro", "glm-5.1", "kimi-k2.6", "qwen3-coder-next"];

/**
 * Call types where zai models reason with effort high (D75, founder 2026-10-06): the card and the brief/template choice
 * of the v1 pipeline and the beta v2 system planner (B2-20); every other call reasons low — 2–3× faster and cheaper
 * (models.yaml#call_policy.thinking).
 */
export const HIGH_REASONING: ReadonlySet<CallType> = new Set<CallType>(["card", "plan", "system_plan"]);

export const ROUTES: Record<CallType, RouteDef> = {
  interview: r("orchestrator", "T1", { T1: ["glm-5.3"], T0: ORCH_T0 }, 0.3, 4000, 180000),
  card: r("orchestrator", "T1", { T1: ["glm-5.3"], T0: ORCH_T0 }, 0.2, 8000, 300000),
  plan: r(
    "builder",
    "T1",
    { T1: ["glm-5.3"], T0: ["glm-5.1", "deepseek-v4-pro", "kimi-k2.6"] },
    0.2,
    4000,
    480000,
  ),
  system_plan: r(
    "planner",
    "T1",
    { T1: ["glm-5.3"], T0: ["glm-5.1", "deepseek-v4-pro", "kimi-k2.6"] },
    0.2,
    8000,
    300000,
  ),
  // B2-21: the builder v2 stages over an approved system plan (agents/builder.yaml#v2): section texts and the design.
  build_texts: r(
    "copywriter",
    "T1",
    { T1: ["glm-5.3"], T0: ["glm-5.1", "kimi-k2.6", "deepseek-v4-pro"] },
    0.4,
    4000,
    180000,
  ),
  build_design: r(
    "designer",
    "T1",
    { T1: ["glm-5.3"], T0: ["glm-5.1", "kimi-k2.6", "deepseek-v4-pro"] },
    0.3,
    1500,
    120000,
  ),
  build_ops: r(
    "builder",
    "T1",
    { T1: ["glm-5.3"], T0: ["glm-5.1", "deepseek-v4-pro", "kimi-k2.6"] },
    0.1,
    8000,
    420000,
  ),
  build_code: r("builder", "T1", { T1: ["glm-5.3"], T0: CODE_T0 }, 0.1, 16000, 480000),
  fix: r("builder", "T1", { T1: ["glm-5.3"], T0: CODE_T0 }, 0.1, 12000, 480000),
  qa_generate: r(
    "qa",
    "T1",
    { T1: ["glm-5.3"], T0: ["glm-5.1", "kimi-k2.6", "deepseek-v4-pro"] },
    0.2,
    8000,
    300000,
  ),
  qa_explain: r("qa", "T1", { T1: ["glm-5.3"], T0: ["glm-5.1", "kimi-k2.6"] }, 0.1, 2000, 90000),
  audit: r("auditor", "T0", { T0: ["gigachat-3.5", "gpt-oss-120b", "kimi-k2.6"] }, 0.1, 8000, 240000),
  import_mapping: r("importer", "T1", { T1: ["glm-5.3"], T0: ["kimi-k2.6", "glm-5.1"] }, 0.0, 4000, 120000),
  runtime_ai_extract: r(
    "runtime",
    "T0",
    { T0: ["gpt-oss-120b", "gigachat-3.5", "yandex-deepseek-v4-flash"] },
    0.0,
    1000,
    30000,
  ),
  runtime_ai_generate: r(
    "runtime",
    "T0",
    { T0: ["gigachat-3.5", "kimi-k2.6", "yandex-qwen3-235b"] },
    0.7,
    2000,
    30000,
  ),
  support: r("support", "T0", { T0: ["kimi-k2.6", "glm-5.1", "deepseek-v4-pro"] }, 0.2, 4000, 120000),
};

/** models.yaml#pii_forbidden_for_T1 */
export const PII_FORBIDDEN_FOR_T1 = {
  always: ["runtime_ai_extract", "runtime_ai_generate", "support"] as readonly CallType[],
  conditional: ["import_mapping"] as readonly CallType[],
};

/** models.yaml#week0_decision.state: t1_default=true until the week-0 eval report. */
export const DEFAULT_BUILD_TIER: Tier = "T1";

/** Env name of the build-tier parameter (models.yaml#week0_decision.switch). */
export const BUILD_TIER_ENV = "WIZARD_BUILD_DEFAULT_TIER";

/** Build tier from env WIZARD_BUILD_DEFAULT_TIER (T0|T1); unset or empty → DEFAULT_BUILD_TIER, anything else throws. */
export function buildDefaultTierFromEnv(env: Record<string, string | undefined> = process.env): Tier {
  const v = env[BUILD_TIER_ENV]?.trim();
  if (!v) return DEFAULT_BUILD_TIER;
  if (v === "T0" || v === "T1") return v;
  throw new Error(`${BUILD_TIER_ENV} must be T0 or T1, got ${v}`);
}

/** The single build-tier source: overrides.buildDefaultTier, else env (buildDefaultTierFromEnv). */
export function createRegistry(
  overrides: Partial<Pick<Registry, "buildDefaultTier">> = {},
  env: Record<string, string | undefined> = process.env,
): Registry {
  return {
    providers: PROVIDERS,
    models: MODELS,
    routes: ROUTES,
    buildDefaultTier: overrides.buildDefaultTier ?? buildDefaultTierFromEnv(env),
    rubPerCredit: 5,
    piiVersion: "@wizard/pii@0.0.0",
  };
}

/** User-facing label of the RF build contour (platform-screens.yaml S1/S3, F2). */
export const RU_BUILD_LABEL = "модели в РФ";
const MODEL_LABELS: Record<string, string> = { "glm-5.3": "GLM-5.3" };

/**
 * api.yaml#OrgSettings.buildModelLabel: the build model by default for an org — RU_BUILD_LABEL when ruOnly,
 * t1Restricted (anything but false, as in decideTier) or buildDefaultTier=T0; otherwise the first T1 model of build_ops.
 */
export function buildModelLabel(reg: Registry, policy: OrgPolicy | null | undefined): string {
  if (policy?.ruOnly === true || policy?.t1Restricted !== false || reg.buildDefaultTier !== "T1")
    return RU_BUILD_LABEL;
  const id = reg.routes.build_ops.chain.T1?.[0];
  return id ? (MODEL_LABELS[id] ?? id) : RU_BUILD_LABEL;
}

export function getModel(reg: Registry, id: string): ModelDef {
  const model = reg.models.find((x) => x.id === id);
  if (!model) throw new Error(`unknown model id ${id}`);
  return model;
}

/** models.yaml#usage_record.policyVersion: hash of the registry + pii version. */
export function policyVersion(reg: Registry): string {
  const h = createHash("sha256");
  h.update(JSON.stringify({ p: reg.providers, m: reg.models, r: reg.routes, t: reg.buildDefaultTier }));
  h.update(reg.piiVersion);
  return h.digest("hex").slice(0, 16);
}
