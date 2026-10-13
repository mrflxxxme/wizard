// V4-05 (D79 (3), (5); plan v4 §3): the role route, two candidates of different families and a judge of another one,
// build stages without scrub, the signal filter, runtime only in RF, Kimi K3 temperature, empty balances skipped and
// Ollama Cloud only for benchmarks. Local HTTP stub only.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  CALL_TYPES,
  type CallType,
  createRegistry,
  createRouter,
  decideTier,
  getModel,
  isBuildCallType,
  type LlmMessage,
  MemoryUsageSink,
  modelFamily,
  modelFamilyOf,
  ollamaFromEnv,
  PROVIDERS,
  ROUTES,
  type RouterOptions,
} from "../src/index.js";
import { okToolCall, type Responder, type Stub, startStub } from "./stub-server.js";

const OPEN = { ruOnly: false, t1Restricted: false };
const ctx = { orgId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-0000000000cc" };
const msgs = (text: string): LlmMessage[] => [
  { role: "system", content: "You are the Wizard builder." },
  { role: "user", content: text },
];
const T1_RF_CANARY =
  "Организатор Иванов Пётр Сергеевич, +7 916 123-45-67, kolos.owner@example.ru, диагноз — диабет.";
const SIGNALS = {
  passport: "Паспорт владельца 4510 123456.",
  snils: "СНИЛС 112-233-445 95.",
  card: "Карта 4111 1111 1111 1111.",
} as const;
const paymentRequired: Responder = () => ({
  status: 402,
  body: { error: { message: "Insufficient Balance" } },
});

let stub: Stub;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.requests.length = 0;
  for (const p of ["zai", "cloudru", "yandex", "moonshot", "xiaomi", "deepseek"])
    stub.respond[p] = okToolCall;
});
/** Every v4 provider at the stub, with keys. */
const env = (extra: Record<string, string> = {}) =>
  stub.env({
    MOONSHOT_BASE_URL: `${stub.url}/moonshot`,
    KIMI_API_KEY: "test-kimi",
    MIMO_BASE_URL: `${stub.url}/xiaomi`,
    MIMO_API_KEY: "test-mimo",
    ...extra,
  });
function mk(extra: Partial<RouterOptions> = {}) {
  const sink = new MemoryUsageSink();
  const router = createRouter({ mode: "live", env: env(), sink, sleep: async () => {}, ...extra });
  return { router, sink };
}

describe("plan v4 §3: every role on its model with a reserve", () => {
  const ROLES: [CallType, string, string][] = [
    ["interview_v3", "glm-5.3", "kimi-k2.6"],
    ["brief_extract", "glm-5.3", "kimi-k2.6"],
    ["art_direction", "kimi-k3-fast", "glm-5.3"],
    ["page_compose", "glm-5.3", "kimi-k3-fast"],
    ["page_edit", "deepseek-v4.1-flash", "mimo-v2.6-flash"],
    ["critic_visual", "glm-5v-turbo", "kimi-k2.6"],
    ["techreview", "mimo-v2.6-pro", "gpt-oss-120b"],
  ];
  const chain = (ct: CallType) => [...(ROUTES[ct].chain.T1 ?? []), ...(ROUTES[ct].chain.T0 ?? [])];

  test.each(ROLES)("%s: %s, then %s", (ct, head, reserve) => {
    const ids = chain(ct);
    expect(ids[0]).toBe(head);
    expect(ids.indexOf(reserve)).toBeGreaterThan(0);
    for (const id of ids) expect(getModel(createRegistry({}, {}), id).enabled, id).toBe(true);
  });

  test("the first-screen candidates: the page route has ≥ 2 families on T1, the second candidate heads with GLM", () => {
    const fams = new Set(
      (ROUTES.page_compose.chain.T1 ?? []).map((id) => modelFamilyOf(createRegistry({}, {}), id)),
    );
    expect([...fams]).toEqual(expect.arrayContaining(["kimi", "glm", "deepseek"]));
    expect(ROUTES.signature_section.chain.T1?.[0]).toBe("deepseek-v4-pro-0813");
  });

  test("runtime_ai_*, support, import_mapping: RF chains as in v3", () => {
    for (const ct of ["runtime_ai_extract", "runtime_ai_generate", "support"] as const) {
      expect(ROUTES[ct].chain.T1).toBeUndefined();
      expect(isBuildCallType(ct)).toBe(false);
    }
    expect(isBuildCallType("import_mapping")).toBe(false);
    expect(isBuildCallType("repo_code")).toBe(false);
  });

  test("live: page code goes to GLM-5.3; avoiding its family — Kimi K3 without reasoning (temperature 0.6, tools required)", async () => {
    const { router } = mk();
    const tools = [
      {
        name: "submit_page_code",
        description: "Код страницы",
        parameters: { type: "object", properties: {} },
      },
    ];
    const a = await router.route({
      callType: "page_compose",
      messages: msgs("Сайт пекарни"),
      orgPolicy: OPEN,
      ctx,
    });
    const b = await router.route({
      callType: "page_compose",
      messages: msgs("Сайт пекарни"),
      tools,
      avoidFamilies: [modelFamilyOf(router.registry, a.model)],
      orgPolicy: OPEN,
      ctx,
    });
    expect([a.model, b.model]).toEqual(["glm-5.3", "kimi-k3-fast"]);
    const kimi = stub.requests.find((r) => r.provider === "moonshot");
    expect(kimi?.body.model).toBe("kimi-k3");
    expect(kimi?.body.temperature).toBe(0.6);
    expect(kimi?.body.thinking).toEqual({ type: "disabled" });
    expect(kimi?.body.tool_choice).toBe("required");
    expect(kimi?.headers.authorization).toBe("Bearer test-kimi");
    expect(stub.requests.find((r) => r.provider === "zai")?.body.temperature).toBe(0.2);
  });
});

describe("critic and judge never of the author's family", () => {
  const reg = createRegistry({}, {});
  const authors = new Set<string>();
  for (const ct of ["art_direction", "page_compose", "signature_section", "page_edit"] as const)
    for (const ids of Object.values(ROUTES[ct].chain)) for (const id of ids) authors.add(id);

  test("every author model leaves vision models of another family in critic_visual (the RF reserve among them)", () => {
    const all = [...(ROUTES.critic_visual.chain.T1 ?? []), ...(ROUTES.critic_visual.chain.T0 ?? [])];
    for (const id of all) expect(getModel(reg, id).vision, id).toBe(true);
    for (const author of authors) {
      const fam = modelFamilyOf(reg, author);
      const other = (ids: readonly string[]) => ids.filter((id) => modelFamily(getModel(reg, id)) !== fam);
      expect(other(ROUTES.critic_visual.chain.T0 ?? []).length, author).toBeGreaterThan(0);
      expect(other(all).length, author).toBeGreaterThan(1);
    }
  });

  test("live: the judge of two candidates (kimi + glm) and the critic of each author", async () => {
    const { router } = mk();
    const shot = [{ mime: "image/png" as const, data: "iVBORw0KGgo=" }];
    const call = (avoid: string[]) =>
      router.route({
        callType: "critic_visual",
        messages: [{ role: "user", content: "Снимки 390 и 1440", attachments: shot }],
        avoidFamilies: avoid,
        orgPolicy: OPEN,
        ctx,
      });
    for (const author of authors) {
      const fam = modelFamilyOf(reg, author);
      const out = await call([fam]);
      expect(modelFamilyOf(reg, out.model), author).not.toBe(fam);
    }
    const judge = await call(["kimi", "glm"]);
    expect([judge.model, judge.tier]).toEqual(["qwen3.6-35b", "T0"]);
  });
});

describe("D79 (3): build stages without scrub, the signal filter, runtime only in RF", () => {
  const BUILD = CALL_TYPES.filter(isBuildCallType);

  test("every build stage gets the original text abroad; journal: not scrubbed, no text", async () => {
    const { router, sink } = mk();
    for (const callType of BUILD) {
      const out = await router.route({ callType, messages: msgs(T1_RF_CANARY), orgPolicy: OPEN, ctx });
      if (ROUTES[callType].defaultTier === "T1")
        expect([out.tier, out.scrubbed], callType).toEqual(["T1", false]);
    }
    const abroad = stub.requests.filter((r) =>
      ["zai", "moonshot", "xiaomi", "deepseek"].includes(r.provider),
    );
    expect(abroad.length).toBeGreaterThan(0);
    for (const r of abroad) expect(r.raw).toContain("Иванов Пётр Сергеевич");
    expect(JSON.stringify(sink.records)).not.toContain("Иванов");
  });

  test.each(Object.entries(SIGNALS))(
    "%s in the input of any build stage → RF, nothing abroad",
    async (_k, signal) => {
      const { router, sink } = mk();
      for (const callType of BUILD)
        await router.route({ callType, messages: msgs(`${T1_RF_CANARY} ${signal}`), orgPolicy: OPEN, ctx });
      expect(stub.requests.every((r) => r.provider === "cloudru" || r.provider === "yandex")).toBe(true);
      expect(sink.records.every((r) => r.tier === "T0")).toBe(true);
      for (const callType of BUILD) {
        const d = decideTier({ callType, messages: msgs(signal), orgPolicy: OPEN }, createRegistry({}, {}));
        expect([d.tier, d.reason], callType).toEqual(["T0", "pii_high_risk"]);
      }
    },
  );

  test("runtime calls never leave RF: any payload, image, hint, policy and build tier", async () => {
    const { router } = mk({ t1Reserve: true });
    const payloads = ["Извлеки сумму", T1_RF_CANARY, SIGNALS.passport];
    for (const callType of ["runtime_ai_extract", "runtime_ai_generate", "support"] as const)
      for (const text of payloads)
        for (const containsPiiHint of [undefined, false, true])
          for (const attachments of [undefined, [{ mime: "image/png" as const, data: "iVBORw0KGgo=" }]]) {
            const out = await router.route({
              callType,
              messages: [{ role: "user", content: text, ...(attachments ? { attachments } : {}) }],
              ...(containsPiiHint !== undefined ? { containsPiiHint } : {}),
              orgPolicy: OPEN,
              ctx,
            });
            expect(out.tier).toBe("T0");
          }
    expect(stub.requests.every((r) => r.provider === "cloudru" || r.provider === "yandex")).toBe(true);
  });

  test("reversible PII tokens never go abroad, build stage or not", async () => {
    const { router } = mk();
    await expect(
      router.route({
        callType: "page_compose",
        messages: msgs("Клиент tok_person_ABCDEFGHIJKLMNOP"),
        orgPolicy: OPEN,
        ctx,
      }),
    ).rejects.toMatchObject({ code: "PII_TOKEN_IN_T1_PAYLOAD" });
  });
});

describe("empty balances (DeepSeek, MiMo 13.10.2026) are skipped until topped up", () => {
  test("402 at DeepSeek and MiMo: one attempt each, then GLM; the next call skips both without HTTP", async () => {
    stub.respond.deepseek = paymentRequired;
    stub.respond.xiaomi = paymentRequired;
    const { router, sink } = mk();
    const first = await router.route({
      callType: "page_edit",
      messages: msgs("Правка"),
      orgPolicy: OPEN,
      ctx,
    });
    expect(first.model).toBe("glm-5.3-flash");
    expect(stub.requests.map((r) => r.provider)).toEqual(["deepseek", "xiaomi", "zai"]);
    stub.requests.length = 0;
    const review = await router.route({
      callType: "techreview",
      messages: msgs("Ревью"),
      orgPolicy: OPEN,
      ctx,
    });
    expect(review.model).toBe("gpt-oss-120b");
    expect(stub.requests.map((r) => r.provider)).toEqual(["cloudru"]);
    expect(
      sink.records.filter((r) => r.errorCode === "PROVIDER_BALANCE_EXHAUSTED").map((r) => r.provider),
    ).toEqual(["deepseek", "xiaomi", "xiaomi"]);
  });
});

describe("providers v4", () => {
  test("Moonshot on KIMI_API_KEY at api.moonshot.ai, MiMo on MIMO_API_KEY; both T1 and enabled", () => {
    expect(PROVIDERS.moonshot).toMatchObject({
      apiKeyEnv: "KIMI_API_KEY",
      defaultBaseUrl: "https://api.moonshot.ai/v1",
      enabled: true,
      tier: "T1",
    });
    expect(PROVIDERS.xiaomi).toMatchObject({
      apiKeyEnv: "MIMO_API_KEY",
      defaultBaseUrl: "https://api.xiaomimimo.com/v1",
      enabled: true,
      tier: "T1",
    });
    expect(getModel(createRegistry({}, {}), "kimi-k3")).toMatchObject({ temperature: 1, vision: true });
  });

  test("Ollama Cloud: only with WIZARD_LLM_BENCH=1 and a list; in no route chain; closed models refused", () => {
    expect(ollamaFromEnv({ WIZARD_LLM_OLLAMA_MODELS: "kimi-k2:1t" })).toBeNull();
    expect(createRegistry({}, {}).providers.ollama.enabled).toBe(false);
    const reg = createRegistry(
      {},
      { WIZARD_LLM_BENCH: "1", WIZARD_LLM_OLLAMA_MODELS: "kimi-k2:1t, glm-4.6" },
    );
    expect(reg.providers.ollama.enabled).toBe(true);
    expect(getModel(reg, "ollama:glm-4.6")).toMatchObject({
      provider: "ollama",
      tier: "T1",
      price: { input: 0 },
    });
    for (const ct of CALL_TYPES)
      for (const ids of Object.values(reg.routes[ct].chain))
        expect(ids.some((id) => id.startsWith("ollama:"))).toBe(false);
    expect(() => ollamaFromEnv({ WIZARD_LLM_BENCH: "1", WIZARD_LLM_OLLAMA_MODELS: "gpt-5" })).toThrow();
  });
});
