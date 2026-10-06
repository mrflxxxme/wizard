// D76 (B2-22): an empty provider balance is not retried, the provider is skipped by every route, the reserve provider
// takes the call and the platform hook fires once (models.yaml#fallback_rules). Local HTTP stub, no external network.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  BALANCE_BLOCK_MS,
  CircuitBreaker,
  createRegistry,
  createRouter,
  isBalanceError,
  type LlmMessage,
  type LlmTool,
  MemoryUsageSink,
  type ProviderDegraded,
  type RouterOptions,
} from "../src/index.js";
import { fail500, okToolCall, type Responder, type Stub, startStub } from "./stub-server.js";

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

/** Z.ai's answer when the account is empty (06.10.2026). */
const zaiNoBalance: Responder = () => ({
  status: 429,
  body: { error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." } },
});
const paymentRequired: Responder = () => ({ status: 402, body: { error: { message: "Payment Required" } } });

const OPEN = { ruOnly: false, t1Restricted: false };
const ctx = { orgId: "00000000-0000-4000-8000-000000000001", runId: "00000000-0000-4000-8000-0000000000bb" };
const TOOLS: LlmTool[] = [
  { name: "apply_ops", description: "Apply AppSpec operations", parameters: { type: "object" } },
];
const msgs = (text: string): LlmMessage[] => [
  { role: "system", content: "You are the Wizard builder." },
  { role: "user", content: text },
];

function mk(extra: Partial<RouterOptions> = {}) {
  const sink = new MemoryUsageSink();
  const degraded: ProviderDegraded[] = [];
  const waits: number[] = [];
  const router = createRouter({
    mode: "live",
    env: stub.env(),
    sink,
    sleep: async (ms) => void waits.push(ms),
    onProviderDegraded: (e) => degraded.push(e),
    ...extra,
  });
  return { router, sink, degraded, waits };
}

describe("isBalanceError (providers.ts classify)", () => {
  test("Z.ai 429/1113, any 402 and a billing 403 are balance errors; a plain rate limit and 5xx are not", () => {
    expect(isBalanceError(429, '{"error":{"code":"1113","message":"Insufficient balance"}}')).toBe(true);
    expect(isBalanceError(402, "")).toBe(true);
    expect(isBalanceError(403, "Недостаточно средств на балансе")).toBe(true);
    expect(isBalanceError(429, "insufficient_quota")).toBe(true);
    expect(isBalanceError(429, "Rate limit reached for requests")).toBe(false);
    expect(isBalanceError(429, "")).toBe(false);
    expect(isBalanceError(403, "Forbidden")).toBe(false);
    expect(isBalanceError(500, "billing service error")).toBe(false);
  });
});

describe("empty balance of a provider (D76)", () => {
  test("Z.ai 429/1113: one request, no retry, the call goes to Cloud.ru; the next calls skip Z.ai; hook once", async () => {
    stub.respond.zai = zaiNoBalance;
    const { router, sink, degraded, waits } = mk();
    const out = await router.route({
      callType: "plan",
      messages: msgs("План"),
      tools: TOOLS,
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model, out.routeReason, out.ruFallback]).toEqual([
      "T0",
      "glm-5.1",
      "fallback_error",
      true,
    ]);
    expect(stub.requests.filter((r) => r.provider === "zai")).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(sink.records.map((r) => [r.modelId, r.status, r.errorCode])).toEqual([
      ["glm-5.3", "error", "PROVIDER_BALANCE_EXHAUSTED"],
      ["glm-5.1", "ok", null],
    ]);

    // Another route of the same router: Z.ai is not asked again, the skip is journaled with the reason.
    const next = await router.route({ callType: "build_code", messages: msgs("Код"), orgPolicy: OPEN, ctx });
    expect([next.model, next.routeReason]).toEqual(["deepseek-v4-pro", "fallback_circuit_open"]);
    expect(stub.requests.filter((r) => r.provider === "zai")).toHaveLength(1);
    expect(sink.records.at(-2)).toMatchObject({
      modelId: "glm-5.3",
      status: "circuit_open",
      errorCode: "PROVIDER_BALANCE_EXHAUSTED",
      billable: false,
    });
    expect(degraded).toEqual([{ provider: "zai", reason: "balance_exhausted" }]);
  });

  test("the block is shared by routers of one breaker and lifts after balanceBlockMs: the stage returns to Z.ai", async () => {
    let t = 1_000_000;
    const now = () => t;
    const circuit = new CircuitBreaker(now);
    stub.respond.zai = zaiNoBalance;
    const a = mk({ circuit, now });
    await a.router.route({ callType: "interview", messages: msgs("Бриф"), orgPolicy: OPEN, ctx });
    const b = mk({ circuit, now });
    const onT0 = await b.router.route({ callType: "card", messages: msgs("Карточка"), orgPolicy: OPEN, ctx });
    expect(onT0.model).toBe("glm-5.1");
    expect(stub.requests.filter((r) => r.provider === "zai")).toHaveLength(1);
    expect([...a.degraded, ...b.degraded]).toHaveLength(1);

    // The founder topped up the balance; after the block the next call goes to Z.ai again.
    stub.respond.zai = okToolCall;
    t += BALANCE_BLOCK_MS + 1;
    const back = await b.router.route({ callType: "card", messages: msgs("Карточка"), orgPolicy: OPEN, ctx });
    expect([back.tier, back.model, back.routeReason]).toEqual(["T1", "glm-5.3", "default_T1"]);
  });

  test("Cloud.ru 402 on a T0-only call: the whole provider is skipped at once, never Z.ai, LLM_UNAVAILABLE", async () => {
    stub.respond.cloudru = paymentRequired;
    const { router, degraded, waits } = mk({ t1Reserve: true });
    await expect(
      router.route({ callType: "support", messages: msgs("Помогите"), orgPolicy: OPEN, ctx }),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE", details: { balanceExhausted: ["cloudru"] } });
    // support: kimi-k2.6, glm-5.1, deepseek-v4-pro — all Cloud.ru; only the first is asked.
    expect(stub.requests.filter((r) => r.provider === "cloudru")).toHaveLength(1);
    expect(stub.requests.filter((r) => r.provider === "zai")).toEqual([]);
    expect(waits).toEqual([]);
    expect(degraded).toEqual([{ provider: "cloudru", reason: "balance_exhausted" }]);
  });

  test("5xx keeps the old path: 3 attempts with backoff, no provider block; the breaker opening fires the hook once", async () => {
    stub.respond.zai = fail500;
    const { router, sink, degraded, waits } = mk();
    await router.route({ callType: "plan", messages: msgs("a"), orgPolicy: OPEN, ctx });
    expect(stub.requests.filter((r) => r.provider === "zai")).toHaveLength(3);
    expect(waits).toHaveLength(2);
    expect(degraded).toEqual([]);
    await router.route({ callType: "plan", messages: msgs("b"), orgPolicy: OPEN, ctx }); // 2 more → open
    await router.route({ callType: "plan", messages: msgs("c"), orgPolicy: OPEN, ctx });
    expect(stub.requests.filter((r) => r.provider === "zai")).toHaveLength(5);
    expect(sink.records.filter((r) => r.errorCode === "PROVIDER_BALANCE_EXHAUSTED")).toEqual([]);
    expect(degraded).toEqual([{ provider: "zai", reason: "circuit_open", model: "glm-5.3" }]);
  });

  test("a throwing hook never breaks the call", async () => {
    stub.respond.zai = zaiNoBalance;
    const { router } = mk({
      onProviderDegraded: () => {
        throw new Error("alert down");
      },
    });
    const out = await router.route({ callType: "plan", messages: msgs("План"), orgPolicy: OPEN, ctx });
    expect(out.model).toBe("glm-5.1");
  });
});

describe("Z.ai as the reserve of Cloud.ru (t1Reserve, D76)", () => {
  const t0Default = createRegistry({ buildDefaultTier: "T0" });
  const PHONE = "+7 916 123-45-67";

  test("T0 by default only + Cloud.ru empty → Z.ai gets the call, scrubbed", async () => {
    stub.respond.cloudru = paymentRequired;
    const { router } = mk({ registry: t0Default, t1Reserve: true });
    const out = await router.route({
      callType: "build_ops",
      messages: msgs(`Собери форму, телефон менеджера ${PHONE}`),
      orgPolicy: OPEN,
      ctx,
    });
    expect([out.tier, out.model, out.scrubbed, out.ruFallback]).toEqual(["T1", "glm-5.3", true, false]);
    const zai = stub.requests.filter((r) => r.provider === "zai");
    expect(zai).toHaveLength(1);
    expect(zai[0]?.raw).not.toContain("916");
  });

  test("off by default, and never for T0 chosen for data reasons or T0-only calls", async () => {
    stub.respond.cloudru = paymentRequired;
    stub.respond.yandex = paymentRequired;
    const off = mk({ registry: t0Default });
    await expect(
      off.router.route({ callType: "build_ops", messages: msgs("Форма"), orgPolicy: OPEN, ctx }),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });

    const on = () => mk({ registry: t0Default, t1Reserve: true }).router;
    const refused = [
      { callType: "build_ops", orgPolicy: { ruOnly: true, t1Restricted: false } },
      { callType: "build_ops", orgPolicy: { ruOnly: false, t1Restricted: true } },
      { callType: "build_ops", orgPolicy: OPEN, containsPiiHint: true },
      { callType: "runtime_ai_extract", orgPolicy: OPEN },
      { callType: "support", orgPolicy: OPEN },
    ] as const;
    for (const c of refused) {
      await expect(on().route({ ...c, messages: msgs("Форма"), ctx })).rejects.toMatchObject({
        code: "LLM_UNAVAILABLE",
      });
    }
    // Strong identifiers (passport) → pii_high_risk: T0 for data reasons, no reserve.
    await expect(
      on().route({ callType: "build_ops", messages: msgs("Паспорт 4510 123456"), orgPolicy: OPEN, ctx }),
    ).rejects.toMatchObject({ code: "LLM_UNAVAILABLE" });
    expect(stub.requests.filter((r) => r.provider === "zai")).toEqual([]);
  });
});

describe("CircuitBreaker provider block", () => {
  test("blockProvider is true only for a new episode; unblockProvider lifts it", () => {
    let t = 0;
    const c = new CircuitBreaker(() => t);
    expect(c.blockProvider("zai", 1000)).toBe(true);
    expect(c.blockProvider("zai", 1000)).toBe(false);
    expect(c.providerBlocked("zai")).toBe(true);
    expect(c.providerBlocked("cloudru")).toBe(false);
    t = 1001;
    expect(c.providerBlocked("zai")).toBe(false);
    expect(c.blockProvider("zai", 1000)).toBe(true);
    c.unblockProvider("zai");
    expect(c.providerBlocked("zai")).toBe(false);
  });
});
