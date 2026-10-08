// V3-16 (builder-v3.md C7): v3 routes, the gateway allowlist (D18), the own OpenAI-compatible server (vLLM, D77 (13))
// and prompt-cache accounting. Live mode runs against the local stub only (no external network).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  ALLOWED_PROVIDERS,
  baseUrlViolation,
  CALL_TYPES,
  type CallType,
  CLOUDRU_INTERNAL_MODELS,
  cachedInputTokens,
  costRub,
  createRegistry,
  createRouter,
  getModel,
  isWesternClosedModel,
  LlmError,
  type LlmMessage,
  type LlmTool,
  MemoryUsageSink,
  MODELS,
  type ModelDef,
  modelFamily,
  modelViolation,
  OPENAI_COMPAT_ENV,
  openAiCompatFromEnv,
  PROVIDERS,
  providerBaseUrl,
  type Registry,
  ROUTES,
  type RouterOptions,
  WESTERN_API_HOSTS,
} from "../src/index.js";
import { okText, okToolCall, type Responder, type Stub, startStub } from "./stub-server.js";

const YAML = readFileSync(new URL("../../../specs/agents/models.yaml", import.meta.url), "utf8");
const OPEN = { ruOnly: false, t1Restricted: false };
const RU_ONLY = { ruOnly: true, t1Restricted: false };
const ctx = { orgId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-0000000000aa" };
const TOOLS: LlmTool[] = [
  {
    name: "submit_page",
    description: "Submit the page",
    parameters: { type: "object", properties: { tsx: { type: "string" } }, required: ["tsx"] },
  },
];
const msgs = (text: string): LlmMessage[] => [
  { role: "system", content: "You are the Wizard v3 builder." },
  { role: "user", content: text },
];

const V3: readonly CallType[] = [
  "interview_v3",
  "brief_extract",
  "art_direction",
  "page_compose",
  "signature_section",
  "critic_visual",
  "techreview",
  "research",
];
/** Models added by V3-16 as probe candidates; yandex-deepseek-v4-flash is new to page code. */
const PROBES = new Set(["qwen3.6-35b", "glm-5.3-flash", "glm-4.6v"]);
const PROBE_NOTE = "после пробы на русском (ступень 2, журнал трат V3-01)";
const model = (id: string): ModelDef => {
  const found = MODELS.find((x) => x.id === id);
  if (!found) throw new Error(id);
  return found;
};

describe("v3 routes (models.yaml#routes, builder-v3.md C7)", () => {
  test("every v3 call type is routed; default tiers as decided", () => {
    for (const ct of V3) expect(CALL_TYPES).toContain(ct);
    const tiers = Object.fromEntries(V3.map((ct) => [ct, ROUTES[ct].defaultTier]));
    expect(tiers).toEqual({
      interview_v3: "T1",
      brief_extract: "T0",
      art_direction: "T1",
      page_compose: "T1",
      signature_section: "T1",
      critic_visual: "T1",
      techreview: "T0",
      research: "T0",
    });
  });

  test("art director and signature sections on GLM: glm-5.3 on T1, GLM first on T0", () => {
    for (const ct of ["art_direction", "signature_section"] as const) {
      expect(ROUTES[ct].chain.T1?.[0]).toBe("glm-5.3");
      expect(modelFamily(model(ROUTES[ct].chain.T0?.[0] as string))).toBe("glm");
    }
  });

  test("probe candidates only at the tails, with the probe note in models.yaml; heads were verified before", () => {
    for (const ct of CALL_TYPES) {
      for (const [tier, ids] of Object.entries(ROUTES[ct].chain)) {
        const firstProbe = ids.findIndex((id) => PROBES.has(id));
        if (firstProbe < 0) continue;
        // After the first probe model there is no verified model in the same tier chain.
        expect(
          ids.slice(firstProbe).every((id) => PROBES.has(id)),
          `${ct}.${tier}`,
        ).toBe(true);
        // critic_visual on T1 has no verified vision model at all (vision on T1 waits for D62, M2-28).
        if (!(ct === "critic_visual" && tier === "T1"))
          expect(firstProbe, `${ct}.${tier}`).toBeGreaterThan(0);
      }
    }
    for (const id of PROBES) {
      const line = YAML.split("\n").find((l) => l.includes(`{ id: ${id},`)) ?? "";
      expect(line, id).toContain(PROBE_NOTE);
    }
    const page = ROUTES.page_compose.chain.T0 ?? [];
    expect(page.at(-1)).toBe("yandex-deepseek-v4-flash");
    expect(YAML.split("\n").find((l) => l.includes("  page_compose:"))).toContain(PROBE_NOTE);
  });

  test("page code is cheaper than the art director; research and brief extraction start on cheap T0 models", () => {
    const head = (ct: CallType, tier: "T0" | "T1") => model(ROUTES[ct].chain[tier]?.[0] as string);
    expect(head("page_compose", "T0").price.input).toBeLessThan(head("art_direction", "T0").price.input);
    expect(head("page_compose", "T0").price.output).toBeLessThan(head("art_direction", "T0").price.output);
    for (const ct of ["research", "brief_extract"] as const) {
      expect(ROUTES[ct].chain.T1).toBeUndefined();
      expect(head(ct, "T0").price.input).toBeLessThanOrEqual(100);
    }
  });

  test("critic_visual: vision models only", () => {
    for (const ids of Object.values(ROUTES.critic_visual.chain))
      for (const id of ids) expect(model(id).vision, id).toBe(true);
  });

  test("techreview: reviewer of another family than the builder heads, with ≥ 2 such models in the chain", () => {
    const builder = new Set<string>();
    for (const ct of ["art_direction", "signature_section", "page_compose"] as const)
      for (const ids of Object.values(ROUTES[ct].chain)) builder.add(modelFamily(model(ids[0] as string)));
    const chain = (ROUTES.techreview.chain.T0 ?? []).map(model);
    expect(builder.has(modelFamily(chain[0] as ModelDef))).toBe(false);
    expect(chain.filter((x) => !builder.has(modelFamily(x))).length).toBeGreaterThanOrEqual(2);
  });

  test("modelFamily", () => {
    const fam = (id: string) => modelFamily(model(id));
    expect(["glm-5.3", "glm-5.1", "glm-5.3-flash", "glm-4.6v"].map(fam)).toEqual([
      "glm",
      "glm",
      "glm",
      "glm",
    ]);
    expect(["kimi-k2.6", "deepseek-v4-pro", "yandex-deepseek-v4-flash", "qwen3-coder-next"].map(fam)).toEqual(
      ["kimi", "deepseek", "deepseek", "qwen"],
    );
    expect(["gpt-oss-120b", "gigachat-3.5", "yandex-qwen3-235b"].map(fam)).toEqual([
      "gpt-oss",
      "gigachat",
      "qwen",
    ]);
  });
});

describe("gateway allowlist (models.yaml#gateway_allowlist, D18)", () => {
  test("western API hosts and their resellers are refused; RF and private hosts are not", () => {
    for (const url of [
      "https://api.openai.com/v1",
      "https://my-org.openai.azure.com/openai",
      "https://api.anthropic.com/v1",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "https://us-central1-aiplatform.googleapis.com/v1",
      "https://api.x.ai/v1",
      "https://openrouter.ai/api/v1",
      "https://ai-gateway.vercel.sh/v1",
      "https://bedrock-runtime.us-east-1.amazonaws.com",
    ])
      expect(baseUrlViolation(url), url).toBe("western_host");
    for (const url of [
      "https://foundation-models.api.cloud.ru/v1",
      "https://llm.api.cloud.yandex.net/v1",
      "https://api.z.ai/api/paas/v4",
      "https://api.deepseek.com",
      "http://vllm.internal:8000/v1",
      "http://127.0.0.1:8000/v1",
    ])
      expect(baseUrlViolation(url), url).toBeNull();
    expect(baseUrlViolation("")).toBe("bad_base_url");
    expect(baseUrlViolation("ftp://example.ru")).toBe("bad_base_url");
  });

  test("closed western models by name (the Cloud.ru catalog sells them); open weights pass", () => {
    for (const name of [
      "openai/gpt-5.5",
      "openai/gpt-4.1-mini",
      "openai/gpt-5.2-codex",
      "openai/chatgpt-4o-latest",
      "openai/o3-deep-research",
      "openai/text-embedding-3-large",
      "anthropic/claude-opus-4.8",
      "google/gemini-3.1-pro-preview",
      "google/gemini-embedding-001",
      "x-ai/grok-4",
      "gpt-4o",
      "claude-sonnet-4.6",
    ])
      expect(isWesternClosedModel(name), name).toBe(true);
    for (const name of [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "openai/whisper-large-v3",
      "google/gemma-3-27b-it",
      "moonshotai/Kimi-K2.6",
      "zai-org/GLM-5.1",
      "ai-sage/GigaChat3.5-432B-A28B",
      "yandexgpt/latest",
      "qwen3-235b-a22b-fp8/latest",
      "MiniMaxAI/MiniMax-M3",
      "glm-4.6v",
    ])
      expect(isWesternClosedModel(name), name).toBe(false);
  });

  test("Cloud.ru: only internal models; partner models are refused even if marked internal", () => {
    const cloudru = PROVIDERS.cloudru;
    const url = cloudru.defaultBaseUrl;
    for (const providerModel of [
      "deepseek-ai/DeepSeek-V4-Flash",
      "zai-org/GLM-5.2",
      "xiaomi/mimo-v2.5-pro",
      "qwen/qwen3-vl-235b-a22b-instruct",
      "z-ai/glm-4.6v",
    ])
      expect(modelViolation(cloudru, { providerModel, placement: "internal" }, url), providerModel).toBe(
        "cloudru_not_internal",
      );
    expect(modelViolation(cloudru, { providerModel: "openai/gpt-5", placement: "internal" }, url)).toBe(
      "western_model",
    );
    expect(
      modelViolation(cloudru, { providerModel: "moonshotai/Kimi-K2.6", placement: "external" }, url),
    ).toBe("cloudru_not_internal");
    expect(
      modelViolation(
        { id: "openai" as never },
        { providerModel: "gpt-oss-120b", placement: "internal" },
        url,
      ),
    ).toBe("unknown_provider");
  });

  test("every registry model passes at its provider's default URL (moonshot is disabled and has none)", () => {
    for (const x of MODELS) {
      const p = PROVIDERS[x.provider];
      if (!p.defaultBaseUrl) {
        expect(x.enabled, x.id).toBe(false);
        continue;
      }
      expect(modelViolation(p, x, p.defaultBaseUrl), x.id).toBeNull();
    }
  });

  test("models.yaml mirrors the allowlist constants", () => {
    const flow = (re: RegExp) =>
      (YAML.match(re)?.[1] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    expect(flow(/gateway_allowlist:[\s\S]*?\n {2}providers: \[([^\]]*)\]/)).toEqual([...ALLOWED_PROVIDERS]);
    expect(flow(/\n {2}western_hosts: \[([^\]]*)\]/)).toEqual([...WESTERN_API_HOSTS]);
    expect(flow(/internal_models:[^\n]*\n\s+\[([^\]]*)\]/)).toEqual([...CLOUDRU_INTERNAL_MODELS]);
  });
});

let stub: Stub;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.requests.length = 0;
  stub.respond.zai = okToolCall;
  stub.respond.cloudru = okToolCall;
  stub.respond.yandex = okToolCall;
  stub.respond.vllm = okToolCall;
});

function mk(extra: Partial<RouterOptions> = {}) {
  const sink = new MemoryUsageSink();
  const router = createRouter({ mode: "live", env: stub.env(), sink, sleep: async () => {}, ...extra });
  return { router, sink };
}
const providersHit = () => [...new Set(stub.requests.map((r) => r.provider))];

describe("gateway allowlist in the router (routing_algorithm 8a)", () => {
  test("a Cloud.ru base URL pointed at OpenAI: nothing is sent there, the chain goes on to Yandex", async () => {
    const { router, sink } = mk({ env: stub.env({ CLOUDRU_BASE_URL: "https://api.openai.com/v1" }) });
    const out = await router.route({
      callType: "interview_v3",
      messages: msgs("Нужен сайт пекарни"),
      orgPolicy: RU_ONLY,
      ctx,
    });
    expect(out.model).toBe("yandex-qwen3-235b");
    expect(providersHit()).toEqual(["yandex"]);
    const refused = sink.records.filter((r) => r.errorCode === "MODEL_NOT_ALLOWED");
    expect(refused.map((r) => r.modelId)).toEqual(["glm-5.1", "kimi-k2.6", "deepseek-v4-pro"]);
    for (const r of refused)
      expect([r.status, r.attempt, r.billable, r.costRub]).toEqual(["error", 0, false, 0]);
  });

  test("a Z.ai base URL pointed at xAI: the T1 call falls back to T0 without a request", async () => {
    const { router } = mk({ env: stub.env({ ZAI_BASE_URL: "https://api.x.ai/v1" }) });
    const out = await router.route({
      callType: "art_direction",
      messages: msgs("Пекарня у дома"),
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model, out.ruFallback]).toEqual(["T0", "glm-5.1", true]);
    expect(providersHit()).toEqual(["cloudru"]);
  });

  test("a closed western model slipped into the registry is never called, in live and fixture alike", async () => {
    const base = createRegistry({ buildDefaultTier: "T1" }, {});
    const bad: ModelDef = { ...getModel(base, "kimi-k2.6"), id: "gpt-5.5", providerModel: "openai/gpt-5.5" };
    const reg: Registry = {
      ...base,
      models: [...base.models, bad],
      routes: {
        ...base.routes,
        research: { ...base.routes.research, chain: { T0: ["gpt-5.5", "gpt-oss-120b"] } },
      },
    };
    const { router, sink } = mk({ registry: reg });
    const out = await router.route({
      callType: "research",
      messages: msgs("Цены на хлеб"),
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.model).toBe("gpt-oss-120b");
    expect(stub.requests.map((r) => r.body.model)).toEqual(["openai/gpt-oss-120b"]);
    expect(sink.records[0]).toMatchObject({ modelId: "gpt-5.5", errorCode: "MODEL_NOT_ALLOWED" });
  });
});

describe("own OpenAI-compatible server (vLLM): one setting connects it", () => {
  const VLLM = "Qwen/Qwen3-Coder-30B-A3B-Instruct";
  const compatEnv = (extra: Record<string, string> = {}) =>
    stub.env({
      [PROVIDERS.openai_compatible.baseUrlEnv]: `${stub.url}/vllm/v1`,
      [OPENAI_COMPAT_ENV.models]: VLLM,
      ...extra,
    });

  test("unset → nothing changes; set → T0 provider, compat:<name> models at price 0", () => {
    expect(openAiCompatFromEnv({})).toBeNull();
    expect(createRegistry({}, {}).providers.openai_compatible.enabled).toBe(false);
    const reg = createRegistry({}, compatEnv());
    expect(reg.providers.openai_compatible).toMatchObject({ enabled: true, tier: "T0" });
    expect(getModel(reg, `compat:${VLLM}`)).toMatchObject({
      provider: "openai_compatible",
      providerModel: VLLM,
      tier: "T0",
      placement: "internal",
      price: { input: 0, cached: 0, output: 0 },
      enabled: true,
    });
    // Without ROUTES the server is the last T0 reserve of every route; the static registry is untouched.
    for (const ct of CALL_TYPES) expect(reg.routes[ct].chain.T0?.at(-1)).toBe(`compat:${VLLM}`);
    expect(ROUTES.research.chain.T0).toEqual(["gpt-oss-120b", "gigachat-3.5", "kimi-k2.6"]);
  });

  test("ROUTES puts it first: the call reaches the server, no key → no Authorization, thinking off with tools", async () => {
    const env = compatEnv({ [OPENAI_COMPAT_ENV.routes]: "research,brief_extract" });
    const { router, sink } = mk({ env });
    const out = await router.route({
      callType: "research",
      messages: msgs("Факты о пекарнях"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model]).toEqual(["T0", `compat:${VLLM}`]);
    const req = stub.requests[0];
    expect([req?.provider, req?.path, req?.body.model]).toEqual(["vllm", "/vllm/v1/chat/completions", VLLM]);
    expect(req?.headers.authorization).toBeUndefined();
    expect(req?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(sink.records[0]).toMatchObject({
      provider: "openai_compatible",
      tier: "T0",
      scrubbed: false,
      costRub: 0,
    });
    expect(createRegistry({}, env).routes.page_compose.chain.T0?.[0]).toBe("kimi-k2.6");
  });

  test("with a key: Bearer; as the reserve it serves a T0 call when Cloud.ru is unavailable", async () => {
    const env = compatEnv({ [PROVIDERS.openai_compatible.apiKeyEnv]: "test-vllm", CLOUDRU_API_KEY: "" });
    const { router } = mk({ env });
    const out = await router.route({
      callType: "support",
      messages: msgs("Почему не сохраняется запись?"),
      ctx,
    });
    expect(out.model).toBe(`compat:${VLLM}`);
    expect(stub.requests.map((r) => r.provider)).toEqual(["vllm"]);
    expect(stub.requests[0]?.headers.authorization).toBe("Bearer test-vllm");
  });

  test("western host, closed model, empty or unknown lists → refused at start", () => {
    const err = (env: Record<string, string>) => {
      try {
        openAiCompatFromEnv(env);
      } catch (e) {
        return e instanceof LlmError ? e.code : "Error";
      }
      return null;
    };
    const base = PROVIDERS.openai_compatible.baseUrlEnv;
    expect(err({ [base]: "https://api.openai.com/v1", [OPENAI_COMPAT_ENV.models]: VLLM })).toBe(
      "MODEL_NOT_ALLOWED",
    );
    expect(err({ [base]: "https://openrouter.ai/api/v1", [OPENAI_COMPAT_ENV.models]: VLLM })).toBe(
      "MODEL_NOT_ALLOWED",
    );
    expect(err({ [base]: "http://vllm.internal/v1", [OPENAI_COMPAT_ENV.models]: `${VLLM}, gpt-5.5` })).toBe(
      "MODEL_NOT_ALLOWED",
    );
    expect(err({ [base]: "http://vllm.internal/v1" })).toBe("Error");
    expect(
      err({
        [base]: "http://vllm.internal/v1",
        [OPENAI_COMPAT_ENV.models]: VLLM,
        [OPENAI_COMPAT_ENV.routes]: "chat",
      }),
    ).toBe("Error");
    expect(
      err({ [base]: "http://vllm.internal/v1", [OPENAI_COMPAT_ENV.models]: "openai/gpt-oss-120b" }),
    ).toBeNull();
  });
});

describe("prompt cache: cached input is journaled and billed at the cache price (credits.cost_rub)", () => {
  const usageReply =
    (usage: Record<string, unknown>): Responder =>
    (req) => {
      const r = okText(req);
      return { ...r, body: { ...(r.body as Record<string, unknown>), usage } };
    };

  test("cachedInputTokens: SDK value, DeepSeek prompt_cache_hit_tokens, Kimi top-level cached_tokens, clamped", () => {
    expect(cachedInputTokens(1000, 400, undefined)).toBe(400);
    expect(cachedInputTokens(1000, 0, { prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300 })).toBe(
      700,
    );
    expect(cachedInputTokens(1000, undefined, { cached_tokens: 250 })).toBe(250);
    expect(cachedInputTokens(100, 400, undefined)).toBe(100);
    expect(cachedInputTokens(100, undefined, { cached_tokens: "x" })).toBe(0);
    expect(cachedInputTokens(100, Number.NaN, null)).toBe(0);
  });

  test("Z.ai (prompt_tokens_details.cached_tokens): glm-5.3 bills cached input at 30 ₽ instead of 162 ₽", async () => {
    const { router, sink } = mk();
    await router.route({
      callType: "page_compose",
      messages: msgs("Страница меню"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    const rec = sink.records[0];
    expect(rec).toMatchObject({
      modelId: "glm-5.3",
      inputTokens: 1000,
      cachedTokens: 400,
      outputTokens: 200,
    });
    expect(rec?.costRub).toBe(0.2112); // (600 × 162 + 400 × 30 + 200 × 510) / 1e6
    expect(rec?.costRub).toBeLessThan(
      costRub(model("glm-5.3").price, { inputTokens: 1000, cachedTokens: 0, outputTokens: 200 }),
    );
  });

  test("DeepSeek-style usage without prompt_tokens_details: hits are read and billed at the cache price", async () => {
    stub.respond.yandex = usageReply({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
    });
    const base = createRegistry({}, {});
    const reg: Registry = {
      ...base,
      routes: {
        ...base.routes,
        research: { ...base.routes.research, chain: { T0: ["yandex-deepseek-v4-flash"] } },
      },
    };
    const { router, sink } = mk({ registry: reg });
    await router.route({ callType: "research", messages: msgs("Факты о нише"), orgPolicy: OPEN, ctx });
    expect(sink.records[0]).toMatchObject({ provider: "yandex", cachedTokens: 700 });
    expect(sink.records[0]?.costRub).toBe(0.2425); // (300 × 300 + 700 × 75 + 200 × 500) / 1e6
  });

  test("Cloud.ru internal: cached tokens are journaled, but the tariff has no cache discount", async () => {
    stub.respond.cloudru = usageReply({
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
      cached_tokens: 600,
    });
    const { router, sink } = mk();
    await router.route({ callType: "research", messages: msgs("Факты о нише"), orgPolicy: OPEN, ctx });
    const rec = sink.records[0];
    expect(rec).toMatchObject({ modelId: "gpt-oss-120b", cachedTokens: 600 });
    expect(rec?.costRub).toBe(
      costRub(model("gpt-oss-120b").price, { inputTokens: 1000, cachedTokens: 0, outputTokens: 200 }),
    );
  });

  test("cache prices: providers without a cache discount have cached = input; caching providers ≤ input", () => {
    for (const x of MODELS) {
      if (PROVIDERS[x.provider].promptCache === "none") expect(x.price.cached, x.id).toBe(x.price.input);
      else expect(x.price.cached, x.id).toBeLessThanOrEqual(x.price.input);
    }
    for (const id of [
      "glm-5.3",
      "glm-5.3-flash",
      "glm-4.6v",
      "yandex-deepseek-v4-flash",
      "deepseek-v4.1-flash",
    ])
      expect(model(id).price.cached, id).toBeLessThan(model(id).price.input);
  });
});

describe("v3 data boundary: PII and images", () => {
  const BRIEF =
    "Пекарня «Колос». Владелец Иванов Пётр Сергеевич, телефон +7 916 123-45-67, почта kolos.owner@example.ru.";
  const CANARIES = ["Иванов Пётр Сергеевич", "+7 916 123-45-67", "9161234567", "kolos.owner@example.ru"];

  test("art direction, pages, signature sections and a text critic go to T1 only scrubbed", async () => {
    const { router } = mk();
    for (const callType of ["art_direction", "page_compose", "signature_section", "critic_visual"] as const) {
      const out = await router.route({ callType, messages: msgs(BRIEF), tools: TOOLS, orgPolicy: OPEN, ctx });
      expect([out.tier, out.scrubbed], callType).toEqual(["T1", true]);
    }
    const t1 = stub.requests.filter((r) => r.provider === "zai");
    expect(t1.length).toBe(4);
    for (const r of t1) for (const c of CANARIES) expect(r.raw).not.toContain(c);
  });

  test("interview_v3 and brief_extract with PII stay in RF; research and techreview are T0 by route", async () => {
    const { router, sink } = mk();
    for (const callType of ["interview_v3", "brief_extract", "research", "techreview"] as const)
      await router.route({ callType, messages: msgs(BRIEF), orgPolicy: OPEN, ctx });
    expect(stub.requests.filter((r) => r.provider === "zai")).toEqual([]);
    expect(sink.records.map((r) => [r.callType, r.tier, r.routeReason])).toEqual([
      ["interview_v3", "T0", "pii_detected_interview"],
      ["brief_extract", "T0", "pii_detected_interview"],
      ["research", "T0", "default_T0"],
      ["techreview", "T0", "default_T0"],
    ]);
  });

  test("critic with screenshots: T0 vision model until D62 masking (D45)", async () => {
    const { router } = mk();
    const out = await router.route({
      callType: "critic_visual",
      messages: [
        { role: "system", content: "Critique the screenshot." },
        { role: "user", content: "Экран 390", attachments: [{ mime: "image/png", data: "iVBORw0KGgo=" }] },
      ],
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model]).toEqual(["T0", "kimi-k2.6"]);
    expect(providersHit()).toEqual(["cloudru"]);
  });

  test("avoidFamilies: the reviewer skips the builder's families; none left → LLM_UNAVAILABLE", async () => {
    const { router } = mk();
    const out = await router.route({
      callType: "techreview",
      messages: msgs("Ревью кода"),
      avoidFamilies: ["deepseek", "glm"],
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.model).toBe("gpt-oss-120b");
    await expect(
      router.route({
        callType: "techreview",
        messages: msgs("Ревью кода"),
        avoidFamilies: ["deepseek", "gpt-oss", "gigachat", "kimi"],
        orgPolicy: OPEN,
        ctx,
      }),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
  });

  test("providerBaseUrl: env override first, else the default", () => {
    expect(providerBaseUrl(PROVIDERS.zai, {})).toBe("https://api.z.ai/api/paas/v4");
    expect(providerBaseUrl(PROVIDERS.zai, { ZAI_BASE_URL: "http://x/zai" })).toBe("http://x/zai");
  });
});
