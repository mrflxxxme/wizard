// DeepSeek API (T1 eval challenger, models.yaml#providers.deepseek): off by default, thinking always disabled,
// same scrub and pii_forbidden_for_T1 rules as Z.ai, missing key → plain fallback. Local HTTP stub only.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, isPlaceholder } from "@wizard/pii";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  buildModelLabel,
  CALL_TYPES,
  createRegistry,
  createRouter,
  type FixtureLine,
  getModel,
  type LlmMessage,
  type LlmTool,
  MemoryUsageSink,
  PII_FORBIDDEN_FOR_T1,
  PROVIDERS,
  type Registry,
  ROUTES,
  type RouterOptions,
  transformBody,
} from "../src/index.js";
import { type Captured, okToolCall, type Responder, type Stub, startStub } from "./stub-server.js";

const DS_MODELS = ["deepseek-v4.1-flash", "deepseek-v4-pro-0813"];
const OPEN = { ruOnly: false, t1Restricted: false };
const ctx = { orgId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-0000000000bb" };
const TOOLS: LlmTool[] = [
  {
    name: "apply_ops",
    description: "Apply AppSpec operations",
    parameters: { type: "object", properties: { ops: { type: "array" } }, required: ["ops"] },
  },
];
const msgs = (text: string): LlmMessage[] => [
  { role: "system", content: "You are the Wizard builder." },
  { role: "user", content: text },
];

/** Worst case for the boundary: the challenger enabled and first in the T1 chain of EVERY call type. */
function challengerRegistry(id = "deepseek-v4.1-flash"): Registry {
  const base = createRegistry({ buildDefaultTier: "T1" }, {});
  const routes = structuredClone(base.routes);
  for (const ct of CALL_TYPES) routes[ct].chain.T1 = [id, ...(routes[ct].chain.T1 ?? [])];
  return {
    ...base,
    routes,
    models: base.models.map((x) => (x.id === id ? { ...x, enabled: true } : x)),
  };
}

/** DeepSeek API behaviour: thinking is on unless disabled; with tools in thinking mode a past assistant tool-call
 * turn without reasoning_content is a 400 (api-docs.deepseek.com/guides/thinking_mode). */
const deepseekLike: Responder = (req: Captured) => {
  const thinkingOff = (req.body.thinking as { type?: string } | undefined)?.type === "disabled";
  const msgsIn = (req.body.messages ?? []) as Record<string, unknown>[];
  const lostReasoning = msgsIn.some((m) => m.role === "assistant" && m.tool_calls && !m.reasoning_content);
  if (!thinkingOff && Array.isArray(req.body.tools) && lostReasoning) {
    return { status: 400, body: { error: { message: "Missing reasoning_content in assistant message" } } };
  }
  return okToolCall(req);
};

let stub: Stub;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());
beforeEach(() => {
  stub.requests.length = 0;
  stub.respond.deepseek = deepseekLike;
  stub.respond.zai = okToolCall;
  stub.respond.cloudru = okToolCall;
});

function mk(extra: Partial<RouterOptions> = {}) {
  const sink = new MemoryUsageSink();
  const router = createRouter({
    mode: "live",
    env: stub.env(),
    registry: challengerRegistry(),
    sink,
    sleep: async () => {},
    ...extra,
  });
  return { router, sink };
}
const toDeepseek = () => stub.requests.filter((r) => r.provider === "deepseek");

describe("registry: deepseek is a disabled-by-default T1 challenger", () => {
  test("provider: T1, env DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL, default https://api.deepseek.com", () => {
    expect(PROVIDERS.deepseek).toMatchObject({
      tier: "T1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      defaultBaseUrl: "https://api.deepseek.com",
    });
    const reg = createRegistry({}, {});
    expect(getModel(reg, "deepseek-v4.1-flash").providerModel).toBe("deepseek-flash");
    expect(getModel(reg, "deepseek-v4-pro-0813").providerModel).toBe("deepseek-v4-pro");
  });

  test("models are enabled=false, T1/external, and in no route chain; build default stays GLM-5.3 on Z.ai", () => {
    const reg = createRegistry({}, {});
    for (const id of DS_MODELS) {
      expect(getModel(reg, id)).toMatchObject({ provider: "deepseek", tier: "T1", enabled: false });
      for (const ct of CALL_TYPES) {
        for (const ids of Object.values(ROUTES[ct].chain)) expect(ids, `${ct}:${id}`).not.toContain(id);
      }
    }
    expect(reg.buildDefaultTier).toBe("T1");
    expect(ROUTES.build_ops.chain.T1).toEqual(["glm-5.3"]);
    expect(buildModelLabel(reg, OPEN)).toBe("GLM-5.3");
    expect(ROUTES.runtime_ai_extract.defaultTier).toBe("T0");
    expect(ROUTES.runtime_ai_generate.defaultTier).toBe("T0");
  });

  test("default registry with a DeepSeek key set: no call type ever reaches the DeepSeek host", async () => {
    const { router } = mk({ registry: createRegistry({}, {}) });
    for (const callType of CALL_TYPES) {
      const out = await router.route({
        callType,
        messages: msgs("Собери форму"),
        tools: TOOLS,
        orgPolicy: OPEN,
        ctx,
      });
      expect(DS_MODELS).not.toContain(out.model);
    }
    expect(toDeepseek()).toEqual([]);
  });
});

describe("transformBody(deepseek): thinking disabled on every call", () => {
  test("without tools", () => {
    const out = transformBody("deepseek", {
      model: "deepseek-flash",
      messages: [{ role: "user", content: "x" }],
    });
    expect(out.thinking).toEqual({ type: "disabled" });
  });

  test("with tools: also strips reasoning_content, reasoning params and response_format", () => {
    const out = transformBody("deepseek", {
      model: "deepseek-flash",
      tools: [{ type: "function" }],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      enable_thinking: true,
      chat_template_kwargs: { enable_thinking: true },
      response_format: { type: "json_object" },
      messages: [{ role: "assistant", content: "", reasoning_content: "secret chain", tool_calls: [] }],
    });
    expect(out.thinking).toEqual({ type: "disabled" });
    for (const k of ["reasoning_effort", "enable_thinking", "chat_template_kwargs", "response_format"])
      expect(out).not.toHaveProperty(k);
    expect(JSON.stringify(out.messages)).not.toContain("reasoning_content");
  });

  test("other providers keep their rules (zai: no thinking field, middle reasoning effort with or without tools)", () => {
    expect(transformBody("zai", { messages: [] })).not.toHaveProperty("thinking");
    expect(transformBody("zai", { messages: [] }).reasoning_effort).toBe("high");
    // Reasoning shares max_tokens with the answer: the answer budget keeps its size.
    expect(transformBody("zai", { messages: [], max_tokens: 4000 }).max_tokens).toBe(4000 + 8192);
    expect(transformBody("cloudru", { messages: [], max_tokens: 4000 }).max_tokens).toBe(4000);
    expect(transformBody("zai", { messages: [], tools: [{}], thinking: { type: "disabled" } })).toMatchObject(
      {
        reasoning_effort: "high",
      },
    );
    expect(
      transformBody("zai", { messages: [], tools: [{}], thinking: { type: "disabled" } }),
    ).not.toHaveProperty("thinking");
    expect(transformBody("cloudru", { messages: [], tools: [{}] }).chat_template_kwargs).toEqual({
      enable_thinking: false,
    });
  });
});

describe("live calls to deepseek (stub)", () => {
  test("tool-calling second turn succeeds: thinking disabled, no reasoning_content, model deepseek-flash", async () => {
    const { router } = mk();
    const first = await router.route({
      callType: "build_ops",
      messages: msgs("Собери форму регистрации"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([first.tier, first.model]).toEqual(["T1", "deepseek-v4.1-flash"]);
    const call = first.result.toolCalls[0];
    expect(call?.name).toBe("apply_ops");
    const second = await router.route({
      callType: "build_ops",
      messages: [
        ...msgs("Собери форму регистрации"),
        { role: "assistant", content: "", toolCalls: first.result.toolCalls },
        { role: "tool", toolCallId: call?.id ?? "", toolName: "apply_ops", content: { ok: true } },
      ],
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([second.tier, second.model, second.routeReason]).toEqual([
      "T1",
      "deepseek-v4.1-flash",
      "default_T1",
    ]);
    const reqs = toDeepseek();
    expect(reqs).toHaveLength(2);
    for (const r of reqs) {
      expect(r.path).toBe("/deepseek/chat/completions");
      expect(r.body.model).toBe("deepseek-flash");
      expect(r.body.thinking).toEqual({ type: "disabled" });
      expect(r.raw).not.toContain("reasoning_content");
      expect(r.headers.authorization).toBe("Bearer test-deepseek");
    }
    expect(stub.requests.filter((r) => r.provider !== "deepseek")).toEqual([]);
  });

  test("a call without tools is sent with thinking disabled too", async () => {
    const { router } = mk();
    await router.route({ callType: "qa_explain", messages: msgs("Объясни провал"), orgPolicy: OPEN, ctx });
    expect(toDeepseek()[0]?.body.thinking).toEqual({ type: "disabled" });
    expect(toDeepseek()[0]?.body).not.toHaveProperty("tools");
  });

  test("the stub really rejects a thinking-mode tool turn without reasoning_content (guards the guard)", () => {
    const body = {
      tools: [{}],
      messages: [{ role: "assistant", tool_calls: [{ id: "c" }] }],
    };
    const raw = JSON.stringify(body);
    expect(deepseekLike({ provider: "deepseek", path: "", headers: {}, body, raw }).status).toBe(400);
    const fixed = transformBody("deepseek", body);
    expect(
      deepseekLike({ provider: "deepseek", path: "", headers: {}, body: fixed, raw: JSON.stringify(fixed) })
        .status,
    ).toBe(200);
  });
});

describe("data boundary applies to deepseek exactly as to Z.ai", () => {
  const CANARIES = [
    "Иванов Пётр Сергеевич",
    "Анна Смирнова",
    "+7 916 123-45-67",
    "+49 30 1234567",
    "canary.person@example.ru",
    "@canary_handle",
    "John Smith",
  ];
  const BRIEF =
    `Организатор — ${CANARIES[0]}, помощник ${CANARIES[1]}. Телефоны: ${CANARIES[2]} и ${CANARIES[3]}. ` +
    `Почта ${CANARIES[4]}, телеграм ${CANARIES[5]}, гость ${CANARIES[6]}. Нужна регистрация на форум.`;

  test("build calls with basic PII reach deepseek only after scrub; journal: scrubbed, counts only", async () => {
    const { router, sink } = mk();
    for (const callType of [
      "card",
      "plan",
      "build_ops",
      "build_code",
      "fix",
      "qa_generate",
      "qa_explain",
    ] as const) {
      const out = await router.route({ callType, messages: msgs(BRIEF), tools: TOOLS, orgPolicy: OPEN, ctx });
      expect([out.tier, out.model, out.scrubbed]).toEqual(["T1", "deepseek-v4.1-flash", true]);
    }
    const reqs = toDeepseek();
    expect(reqs).toHaveLength(7);
    for (const r of reqs) {
      const lower = r.raw.toLowerCase();
      for (const c of CANARIES) {
        expect(lower).not.toContain(c.toLowerCase());
        const digits = c.replace(/\D/g, "");
        if (digits.length > 6) expect(lower).not.toContain(digits);
      }
      const text = (r.body.messages as { content: string }[]).map((m) => m.content).join("\n");
      expect(detect(text).filter((f) => !isPlaceholder(text.slice(f.start, f.end)))).toEqual([]);
      expect(text).toContain("[EMAIL_1]");
    }
    const journal = JSON.stringify(sink.records);
    for (const c of CANARIES) expect(journal).not.toContain(c);
    for (const rec of sink.records) {
      expect([rec.provider, rec.tier, rec.scrubbed]).toEqual(["deepseek", "T1", true]);
      expect(rec.piiCategoriesCount.email).toBe(1);
    }
  });

  test("pii_forbidden_for_T1, attachments, strong ids, interview PII, import_mapping and ruOnly never reach deepseek", async () => {
    const { router, sink } = mk();
    for (const callType of PII_FORBIDDEN_FOR_T1.always) {
      await router.route({ callType, messages: msgs("Извлеки сумму из записи"), orgPolicy: OPEN, ctx });
    }
    await router.route({
      callType: "build_ops",
      messages: [
        {
          role: "user",
          content: "Что на фото?",
          attachments: [{ mime: "image/png", data: "iVBORw0KGgo=" }],
        },
      ],
      orgPolicy: OPEN,
      ctx,
    });
    await router.route({
      callType: "build_ops",
      messages: msgs(`${BRIEF} Паспорт 4510 123456.`),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    await router.route({ callType: "interview", messages: msgs(BRIEF), orgPolicy: OPEN, ctx });
    await router.route({
      callType: "import_mapping",
      messages: msgs("Колонки: имя, телефон"),
      orgPolicy: OPEN,
      ctx,
    });
    for (const callType of CALL_TYPES) {
      await router.route({
        callType,
        messages: msgs("Собери форму"),
        orgPolicy: { ruOnly: true, t1Restricted: false },
        ctx,
      });
      await router.route({ callType, messages: msgs("Собери форму"), orgPolicy: { ruOnly: false }, ctx });
    }
    expect(toDeepseek()).toEqual([]);
    expect(sink.records.every((r) => r.tier === "T0" && r.provider !== "deepseek")).toBe(true);
    const reasons = new Set(sink.records.map((r) => r.routeReason));
    for (const r of [
      "callType_forbidden_T1",
      "pii_hint",
      "pii_high_risk",
      "pii_detected_interview",
      "policy_ru_only",
      "policy_region_restricted",
    ])
      expect(reasons.has(r as never), r).toBe(true);
  });

  test("tok_* tokens are refused before anything is sent to deepseek", async () => {
    const { router } = mk();
    await expect(
      router.route({
        callType: "build_ops",
        messages: msgs("Клиент tok_person_ABCDEFGHIJKLMNOP"),
        orgPolicy: OPEN,
        ctx,
      }),
    ).rejects.toMatchObject({ code: "PII_TOKEN_IN_T1_PAYLOAD" });
    expect(toDeepseek()).toEqual([]);
  });
});

describe("no key → deepseek is simply unavailable, the existing fallback works", () => {
  test("no DEEPSEEK_API_KEY → next T1 model (GLM-5.3), no request to the DeepSeek host", async () => {
    const { router, sink } = mk({ env: stub.env({ DEEPSEEK_API_KEY: "" }) });
    const out = await router.route({
      callType: "build_ops",
      messages: msgs("Собери форму"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model, out.routeReason]).toEqual(["T1", "glm-5.3", "fallback_error"]);
    expect(toDeepseek()).toEqual([]);
    // A missing key is not an attempt: nothing is journaled or charged for the challenger.
    expect(sink.records.map((r) => [r.modelId, r.status])).toEqual([["glm-5.3", "ok"]]);
    expect(sink.records[0]?.fallbackFrom).toBe("deepseek-v4.1-flash");
  });

  test("no DeepSeek and no Z.ai key → T0 with ruFallback", async () => {
    const { router } = mk({ env: stub.env({ DEEPSEEK_API_KEY: "", ZAI_API_KEY: "" }) });
    const out = await router.route({
      callType: "build_ops",
      messages: msgs("Собери форму"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model, out.ruFallback]).toEqual(["T0", "glm-5.1", true]);
    expect(stub.requests.map((r) => r.provider)).toEqual(["cloudru"]);
  });

  test("deepseek 5xx → retries, then GLM-5.3", async () => {
    stub.respond.deepseek = () => ({ status: 503, body: { error: { message: "busy" } } });
    const { router } = mk();
    const out = await router.route({
      callType: "plan",
      messages: msgs("План"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.model).toBe("glm-5.3");
    expect(toDeepseek()).toHaveLength(3);
  });
});

describe("fixture mode stays offline", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-deepseek-"));
    const line: FixtureLine = {
      v: 1,
      key: "k",
      callType: "build_ops",
      modelId: "glm-5.3",
      request: {
        messages: [],
        tools: [{ name: "apply_ops", schemaHash: "x" }],
        params: { temperature: 0, max_tokens: 1 },
      },
      response: {
        toolCalls: [{ id: "c1", name: "apply_ops", args: { ops: [] } }],
        finishReason: "tool_calls",
      },
      usage: { promptTokens: 1000, cachedPromptTokens: 0, completionTokens: 100 },
      latencyMs: 5,
      recordedAt: "2026-10-01T00:00:00.000Z",
    };
    mkdirSync(join(dir, "demo"), { recursive: true });
    writeFileSync(join(dir, "demo", "ds.jsonl"), `${JSON.stringify(line)}\n${JSON.stringify(line)}\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const noNetwork: typeof globalThis.fetch = () => {
    throw new Error("network in fixture mode");
  };

  test("challenger in fixture mode: answered from the fixture, journal says deepseek, no HTTP", async () => {
    const sink = new MemoryUsageSink();
    const router = createRouter({
      mode: "fixture",
      env: {},
      registry: challengerRegistry(),
      sink,
      fetch: noNetwork,
      fixture: { suite: "demo", name: "ds", dir },
    });
    const out = await router.route({
      callType: "build_ops",
      messages: msgs("Собери форму"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model, out.scrubbed]).toEqual(["T1", "deepseek-v4.1-flash", true]);
    expect(sink.records[0]?.provider).toBe("deepseek");
    expect(sink.records[0]?.mode).toBe("fixture");
  });

  test("default registry, no DeepSeek env: fixture build still lands on GLM-5.3", async () => {
    const router = createRouter({
      mode: "fixture",
      env: {},
      sink: new MemoryUsageSink(),
      fetch: noNetwork,
      fixture: { suite: "demo", name: "ds", dir },
    });
    const out = await router.route({
      callType: "build_ops",
      messages: msgs("Собери форму"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.model).toBe("glm-5.3");
  });
});
