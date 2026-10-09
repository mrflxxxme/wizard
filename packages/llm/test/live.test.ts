// Live mode against a local HTTP stub (no external network).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, isPlaceholder } from "@wizard/pii";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  abortableSleep,
  CALL_TYPES,
  costRub,
  createRegistry,
  createRouter,
  creditsMilli,
  getModel,
  JsonlUsageSink,
  type LlmEvent,
  type LlmMessage,
  type LlmTool,
  MAX_RETRY_AFTER_MS,
  MemoryUsageSink,
  PII_FORBIDDEN_FOR_T1,
  type RouterOptions,
} from "../src/index.js";
import { fail500, okText, okToolCall, type Stub, startStub } from "./stub-server.js";

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
});

const OPEN = { ruOnly: false, t1Restricted: false };
const ctx = { orgId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-0000000000aa" };
const TOOLS: LlmTool[] = [
  {
    name: "apply_ops",
    description: "Apply AppSpec operations",
    parameters: { type: "object", properties: { ops: { type: "array" } }, required: ["ops"] },
  },
];

function mk(extra: Partial<RouterOptions> = {}) {
  const sink = new MemoryUsageSink();
  const events: LlmEvent[] = [];
  const router = createRouter({
    mode: "live",
    env: stub.env(),
    sink,
    sleep: async () => {},
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { router, sink, events };
}

const msgs = (text: string): LlmMessage[] => [
  { role: "system", content: "You are the Wizard builder." },
  { role: "user", content: text },
];

describe("request body policy (models.yaml#call_policy)", () => {
  test("T1 (zai) with tools: reasoning effort low outside card and plan (D75; thinking cannot be disabled), no response_format, no reasoning_content", async () => {
    const { router } = mk();
    const out = await router.route({
      callType: "build_ops",
      messages: [
        ...msgs("Собери форму регистрации"),
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "apply_ops", args: { ops: [] } }] },
        { role: "tool", toolCallId: "c0", toolName: "apply_ops", content: { ok: true } },
      ],
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.tier).toBe("T1");
    expect(out.model).toBe("glm-5.3");
    expect(out.result.toolCalls).toEqual([{ id: "call_1", name: "apply_ops", args: { ops: [] } }]);
    const req = stub.requests[0];
    expect(req?.provider).toBe("zai");
    expect(req?.body.model).toBe("glm-5.3");
    expect(req?.body).not.toHaveProperty("thinking");
    expect(req?.body.reasoning_effort).toBe("low");
    expect(req?.body).not.toHaveProperty("response_format");
    expect(req?.raw).not.toContain("reasoning_content");
    expect(Array.isArray(req?.body.tools)).toBe(true);
    expect(req?.headers.authorization).toBe("Bearer test-zai");
  });

  test("T0 (cloudru) with tools: chat_template_kwargs.enable_thinking=false, no response_format", async () => {
    const { router } = mk();
    const out = await router.route({
      callType: "audit",
      messages: msgs("Проверь спеку"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model]).toEqual(["T0", "gigachat-3.5"]);
    const body = stub.requests[0]?.body ?? {};
    expect(body.model).toBe("ai-sage/GigaChat3.5-432B-A28B");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("response_format");
  });

  test("T0 (cloudru) tool schemas lose the keywords guided decoding lacks (propertyNames), a property of that name stays", async () => {
    const { router } = mk();
    const schema = {
      type: "object",
      properties: {
        map: {
          type: "object",
          propertyNames: { pattern: "^[a-z]+$" },
          additionalProperties: { type: "string" },
        },
        propertyNames: { type: "string" },
      },
      required: ["map"],
    };
    await router.route({
      callType: "audit",
      messages: msgs("Проверь спеку"),
      tools: [{ name: "apply_ops", description: "Apply", parameters: schema }],
      orgPolicy: OPEN,
      ctx,
    });
    const tools = (stub.requests[0]?.body?.tools ?? []) as { function: { parameters: typeof schema } }[];
    const sent = tools[0]?.function.parameters;
    expect(sent?.properties.map).toEqual({ type: "object", additionalProperties: { type: "string" } });
    expect(sent?.properties.propertyNames).toEqual({ type: "string" });
    expect(sent?.required).toEqual(["map"]);
  });

  test("Yandex: every request carries x-data-logging-enabled: false and gpt:// model URI", async () => {
    // No Cloud.ru key → runtime_ai_extract chain skips to yandex-deepseek-v4-flash.
    const { router } = mk({ env: stub.env({ CLOUDRU_API_KEY: "" }) });
    const out = await router.route({
      callType: "runtime_ai_extract",
      messages: msgs("Извлеки сумму"),
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.model).toBe("yandex-deepseek-v4-flash");
    const reqs = stub.requests.filter((r) => r.provider === "yandex");
    expect(reqs.length).toBeGreaterThan(0);
    for (const r of reqs) expect(r.headers["x-data-logging-enabled"]).toBe("false");
    expect(reqs[0]?.body.model).toBe("gpt://b1gfolder/deepseek-v4-flash/latest");
  });
});

describe("call journal: no PII reaches T1 (models.yaml#usage_record.test, data-boundary.yaml#tests)", () => {
  const CANARIES = [
    "Иванов Пётр Сергеевич",
    "Анна Смирнова",
    "Ivan Petrov",
    "+7 916 123-45-67",
    "+49 30 1234567",
    "canary.person@example.ru",
    "@canary_handle",
    "Джахонгир Рахимов",
    "John Smith",
    "Hiroshi Tanaka-Weller",
  ];
  const BRIEF =
    `Организатор — ${CANARIES[0]}, помощник ${CANARIES[1]}, спикер ${CANARIES[2]}. ` +
    `Телефоны: ${CANARIES[3]} и ${CANARIES[4]}. Почта ${CANARIES[5]}, телеграм ${CANARIES[6]}. ` +
    `Бухгалтер ${CANARIES[7]}, гость ${CANARIES[8]}. ` +
    `Заявки сводит помощник финдиректора ${CANARIES[9]}. ` +
    "Нужна регистрация на форум с типами билетов.";

  test("build calls with basic PII go to T1 only after scrub; journal has counts only", async () => {
    const { router, sink } = mk();
    for (const callType of [
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
    ] as const) {
      const out = await router.route({ callType, messages: msgs(BRIEF), tools: TOOLS, orgPolicy: OPEN, ctx });
      expect(out.tier).toBe("T1");
      expect(out.scrubbed).toBe(true);
    }
    const t1 = stub.requests.filter((r) => r.provider === "zai");
    expect(t1.length).toBe(11);
    // B2-20: the system planner reasons high like the card and the v1 plan (models.yaml#call_policy.thinking);
    // B2-21: the builder v2 texts and design stages reason low; B2-23: the custom code too.
    expect(t1.map((r) => r.body.reasoning_effort)).toEqual([
      "high",
      "high",
      "high",
      "low",
      "low",
      "low",
      "low",
      "low",
      "low",
      "low",
      "low",
    ]);
    for (const r of t1) {
      const lower = r.raw.toLowerCase();
      for (const c of CANARIES) {
        expect(lower).not.toContain(c.toLowerCase());
        expect(lower).not.toContain(c.replace(/\D/g, "").length > 6 ? c.replace(/\D/g, "") : "\u0000");
      }
      const text = (r.body.messages as { content: string }[]).map((m) => m.content).join("\n");
      const leftovers = detect(text).filter((f) => !isPlaceholder(text.slice(f.start, f.end)));
      expect(leftovers).toEqual([]);
      expect(text).toContain("[ФИО_1]");
      expect(text).toContain("[EMAIL_1]");
    }
    const journal = JSON.stringify(sink.records);
    for (const c of CANARIES) expect(journal).not.toContain(c);
    for (const rec of sink.records) {
      expect(rec.tier === "T0" || rec.scrubbed).toBe(true);
      expect(rec.piiCategoriesCount.email).toBe(1);
      expect(Object.values(rec.piiCategoriesCount).every((n) => typeof n === "number")).toBe(true);
    }
  });

  test("strong identifiers, interview with PII, forbidden callTypes and ruOnly never reach the T1 host", async () => {
    const { router, sink } = mk();
    const strong = `${BRIEF} Паспорт 4510 123456.`;
    await router.route({ callType: "build_ops", messages: msgs(strong), tools: TOOLS, orgPolicy: OPEN, ctx });
    await router.route({ callType: "interview", messages: msgs(BRIEF), orgPolicy: OPEN, ctx });
    for (const callType of PII_FORBIDDEN_FOR_T1.always) {
      await router.route({ callType, messages: msgs(BRIEF), orgPolicy: OPEN, ctx });
    }
    await router.route({
      callType: "import_mapping",
      messages: msgs("Колонки: имя, телефон"),
      orgPolicy: OPEN,
      ctx,
    });
    for (const callType of CALL_TYPES) {
      await router.route({
        callType,
        messages: msgs(BRIEF),
        orgPolicy: { ruOnly: true, t1Restricted: false },
        ctx,
      });
      await router.route({ callType, messages: msgs(BRIEF), orgPolicy: { ruOnly: false }, ctx });
    }
    expect(stub.requests.filter((r) => r.provider === "zai")).toEqual([]);
    expect(sink.records.every((r) => r.tier === "T0")).toBe(true);
    const reasons = new Set(sink.records.map((r) => r.routeReason));
    for (const r of [
      "pii_high_risk",
      "pii_detected_interview",
      "callType_forbidden_T1",
      "policy_ru_only",
      "policy_region_restricted",
    ]) {
      expect(reasons.has(r as never)).toBe(true);
    }
    const forbidden: readonly string[] = PII_FORBIDDEN_FOR_T1.always;
    expect(sink.records.filter((r) => r.tier === "T1" && forbidden.includes(r.callType))).toEqual([]);
  });
});

describe("fallback, retries, circuit breaker", () => {
  test("T1 5xx → 3 attempts, then T0 with fallback_error; model_switched only in the internal journal", async () => {
    stub.respond.zai = fail500;
    const { router, sink, events } = mk();
    const out = await router.route({
      callType: "plan",
      messages: msgs("План сборки"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model, out.ruFallback, out.routeReason]).toEqual([
      "T0",
      "glm-5.1",
      true,
      "fallback_error",
    ]);
    expect(stub.requests.filter((r) => r.provider === "zai").length).toBe(3);
    expect(sink.records.map((r) => [r.modelId, r.status, r.attempt, r.billable])).toEqual([
      ["glm-5.3", "error", 1, false],
      ["glm-5.3", "error", 2, false],
      ["glm-5.3", "error", 3, false],
      ["glm-5.1", "ok", 1, true],
    ]);
    expect(sink.records[3]?.fallbackFrom).toBe("glm-5.3");
    expect(sink.records[0]?.errorCode).toBe("HTTP_5xx");
    expect(events).toEqual([
      { type: "model_switched", fromModel: "glm-5.3", toModel: "glm-5.1", reason: "fallback_error" },
    ]);
  });

  test("400 is not retried", async () => {
    stub.respond.zai = () => ({ status: 400, body: { error: { message: "bad request" } } });
    const { router, sink } = mk();
    await router.route({ callType: "plan", messages: msgs("План"), orgPolicy: OPEN, ctx });
    expect(sink.records.filter((r) => r.modelId === "glm-5.3").map((r) => r.errorCode)).toEqual(["HTTP_400"]);
  });

  test("toolChoice required answered with text: one billed answer for the caller, not a retried network error", async () => {
    stub.respond.zai = okText;
    const { router, sink } = mk();
    const out = await router.route({
      callType: "plan",
      messages: msgs("План"),
      tools: TOOLS,
      toolChoice: "required",
      orgPolicy: OPEN,
      ctx,
    });
    expect(out.result).toMatchObject({ toolCalls: [], text: "Готово" });
    expect(out.model).toBe("glm-5.3");
    expect(out.usage).toMatchObject({ inputTokens: 100, outputTokens: 10 });
    expect(sink.records.map((r) => [r.modelId, r.status, r.errorCode])).toEqual([["glm-5.3", "ok", null]]);
    expect(sink.records[0]?.costRub).toBeGreaterThan(0);
    expect(stub.requests).toHaveLength(1);
  });

  test("backoff with jitter and Retry-After", async () => {
    let n = 0;
    stub.respond.zai = (req) =>
      ++n <= 2 ? { status: 429, body: {}, headers: n === 1 ? { "retry-after": "2" } : {} } : okText(req);
    const waits: number[] = [];
    const { router } = mk({ sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
    const out = await router.route({ callType: "plan", messages: msgs("План"), orgPolicy: OPEN, ctx });
    expect(out.model).toBe("glm-5.3");
    expect(waits).toEqual([2000, 4000]);
  });

  test("V3-18: Retry-After past 30 s is not waited for — the next model of the chain takes the call", async () => {
    stub.respond.zai = (req) =>
      req.body.model === "glm-5.3"
        ? { status: 429, body: {}, headers: { "retry-after": "120" } }
        : okText(req);
    const waits: number[] = [];
    const { router, events } = mk({ sleep: async (ms) => void waits.push(ms) });
    const out = await router.route({ callType: "plan", messages: msgs("План"), orgPolicy: OPEN, ctx });
    expect(out.model).not.toBe("glm-5.3");
    expect(waits).toEqual([]);
    expect(stub.requests.filter((r) => r.body.model === "glm-5.3")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "model_switched", fromModel: "glm-5.3" }));
    expect(MAX_RETRY_AFTER_MS).toBe(30_000);
  });

  test("V3-18: a cancelled call stops waiting out the pause at once (ABORTED)", async () => {
    stub.respond.zai = () => ({ status: 429, body: {}, headers: { "retry-after": "20" } });
    const ac = new AbortController();
    let waiting = false;
    // A pause that never ends by itself: only the call's signal ends it.
    const { router } = mk({
      sleep: () => {
        waiting = true;
        ac.abort();
        return new Promise<void>(() => {});
      },
    });
    await expect(
      router.route({ callType: "plan", messages: msgs("План"), orgPolicy: OPEN, ctx, signal: ac.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(waiting).toBe(true);
  });

  test("V3-18: abortableSleep — a plain sleep without a signal, an aborted signal rejects at once", async () => {
    const waits: number[] = [];
    await abortableSleep(async (ms) => void waits.push(ms), 5);
    expect(waits).toEqual([5]);
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(async () => {}, 5, ac.signal)).rejects.toMatchObject({ code: "ABORTED" });
  });

  test("5 failures open the circuit: the next call goes to the next model without a request to the first", async () => {
    let gigachatCalls = 0;
    stub.respond.cloudru = (req) => {
      if (req.body.model === "ai-sage/GigaChat3.5-432B-A28B") {
        gigachatCalls++;
        return fail500(req);
      }
      return okText(req);
    };
    const { router, sink } = mk();
    await router.route({ callType: "audit", messages: msgs("a"), orgPolicy: OPEN, ctx }); // 3 failures → gpt-oss
    await router.route({ callType: "audit", messages: msgs("b"), orgPolicy: OPEN, ctx }); // 2 more → open
    expect(gigachatCalls).toBe(5);
    const out = await router.route({ callType: "audit", messages: msgs("c"), orgPolicy: OPEN, ctx });
    expect(gigachatCalls).toBe(5);
    expect(out.model).toBe("gpt-oss-120b");
    expect(out.routeReason).toBe("fallback_circuit_open");
    expect(sink.records.some((r) => r.status === "circuit_open" && r.modelId === "gigachat-3.5")).toBe(true);
  });

  test("all T0 models fail → LLM_UNAVAILABLE, never T0 → T1", async () => {
    stub.respond.cloudru = fail500;
    stub.respond.yandex = fail500;
    const { router } = mk();
    await expect(
      router.route({ callType: "support", messages: msgs("x"), orgPolicy: OPEN, ctx }),
    ).rejects.toMatchObject({
      code: "LLM_UNAVAILABLE",
    });
    expect(stub.requests.filter((r) => r.provider === "zai")).toEqual([]);
  });

  test("disabled models are never chosen", async () => {
    const reg = createRegistry();
    const disabled = {
      ...reg,
      models: reg.models.map((x) => (x.id === "glm-5.3" ? { ...x, enabled: false } : x)),
    };
    const { router } = mk({ registry: disabled });
    const out = await router.route({ callType: "plan", messages: msgs("x"), orgPolicy: OPEN, ctx });
    expect(out.tier).toBe("T0");
    expect(stub.requests.filter((r) => r.provider === "zai")).toEqual([]);
  });

  test("abort signal stops the call", async () => {
    const { router } = mk();
    const ac = new AbortController();
    ac.abort();
    await expect(
      router.route({ callType: "plan", messages: msgs("x"), orgPolicy: OPEN, ctx, signal: ac.signal }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });
});

describe("usage and credits (models.yaml#credits)", () => {
  test("cost and credits per record; creditsCharged sums billable attempts", async () => {
    const { router, sink } = mk();
    const out = await router.route({
      callType: "build_ops",
      messages: msgs("x"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    const price = getModel(createRegistry(), "glm-5.3").price;
    const cost = (600 * price.input + 400 * price.cached + 200 * price.output) / 1e6;
    expect(out.usage).toEqual({ inputTokens: 1000, cachedTokens: 400, outputTokens: 200 });
    const rec = sink.records[0];
    expect(rec?.costRub).toBeCloseTo(cost, 4);
    expect(rec?.creditsMilli).toBe(Math.ceil((cost * 1000) / 5));
    expect(out.creditsMilli).toBe(rec?.creditsMilli);
    expect(out.creditsCharged).toBe((rec?.creditsMilli ?? 0) / 1000);
    expect(rec).toMatchObject({
      agentRole: "builder",
      provider: "zai",
      mode: "live",
      runId: ctx.runId,
      toolCalls: 1,
    });
    expect(rec?.policyVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(rec?.requestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("costRub and creditsMilli formulas", () => {
    const price = { input: 100, cached: 10, output: 1000 };
    expect(costRub(price, { inputTokens: 1_000_000, cachedTokens: 500_000, outputTokens: 1000 })).toBe(56);
    expect(creditsMilli(56, 5)).toBe(11200);
    expect(creditsMilli(0.0001, 5)).toBe(1);
    expect(creditsMilli(0, 5)).toBe(0);
  });

  test("JsonlUsageSink appends one JSON line per record, without payload text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-usage-"));
    try {
      const path = join(dir, ".data", "usage.jsonl");
      const { router } = mk({ sink: new JsonlUsageSink(path) });
      await router.route({
        callType: "plan",
        messages: msgs("Секретный бриф без ПДн"),
        orgPolicy: OPEN,
        ctx,
      });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines.length).toBe(1);
      expect(lines[0]).not.toContain("Секретный бриф");
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ callType: "plan", tier: "T1", status: "ok" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
