// ruOnly / t1Restricted switched on: policy cache invalidation and abort of in-flight T1 calls (data-boundary.yaml
// #ru_only.effect, #tests «Включение ruOnly во время T1-вызова в полёте», L3-42).
import { describe, expect, test } from "vitest";
import {
  createPolicyCache,
  createRouter,
  forbidsT1,
  LlmError,
  type LlmEvent,
  type LlmMessage,
  MemoryUsageSink,
  type OrgPolicy,
  POLICY_CACHE_TTL_MS,
  PolicyBus,
  type RouteOutput,
} from "../src/index.js";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const OPEN: OrgPolicy = { ruOnly: false, t1Restricted: false };
const RU_ONLY: OrgPolicy = { ruOnly: true, t1Restricted: false };
const ENV = {
  ZAI_BASE_URL: "http://mock.local/zai",
  ZAI_API_KEY: "k",
  CLOUDRU_BASE_URL: "http://mock.local/cloudru",
  CLOUDRU_API_KEY: "k",
};
const msgs: LlmMessage[] = [
  { role: "system", content: "You are the Wizard builder." },
  { role: "user", content: "Собери форму записи" },
];

const okBody = (model: string) => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model,
  choices: [{ index: 0, message: { role: "assistant", content: "Готово" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
});

/** T1 (zai) hangs until aborted and reports each start; T0 (cloudru) answers at once. */
function mockFetch(hangT1: boolean) {
  const calls: string[] = [];
  const waiters: Array<() => void> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u.includes("/zai") ? "zai" : "cloudru");
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    if (u.includes("/zai") && hangT1) {
      for (const w of waiters.splice(0)) w();
      await new Promise((_, reject) => {
        const s = init?.signal;
        if (s?.aborted) reject(s.reason);
        s?.addEventListener("abort", () => reject(s.reason));
      });
    }
    return new Response(JSON.stringify(okBody(body.model)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    nextStart: () => new Promise<void>((r) => waiters.push(r)),
  };
}

function mk(hangT1 = true, bus = new PolicyBus()) {
  const sink = new MemoryUsageSink();
  const events: LlmEvent[] = [];
  const m = mockFetch(hangT1);
  const router = createRouter({
    mode: "live",
    env: ENV,
    sink,
    policyBus: bus,
    fetch: m.fetch,
    sleep: async () => {},
    onEvent: (e) => events.push(e),
  });
  return { bus, sink, events, router, ...m };
}

describe("in-flight T1 calls", () => {
  test("ruOnly switched on → the T1 call is aborted and repeated on T0 within the same route()", async () => {
    const { bus, sink, events, router, calls, nextStart } = mk();
    const started = nextStart();
    const p = router.route({ callType: "build_ops", messages: msgs, orgPolicy: OPEN, ctx: { orgId: ORG } });
    await started;
    expect(router.inflightT1?.(ORG)).toBe(1);
    bus.publish({ orgId: ORG, policy: RU_ONLY });
    const out: RouteOutput = await p;
    expect(out).toMatchObject({
      tier: "T0",
      routeReason: "policy_ru_only",
      scrubbed: false,
      ruFallback: true,
    });
    expect(calls).toEqual(["zai", "cloudru"]);
    expect(sink.records.map((r) => [r.tier, r.status, r.errorCode, r.routeReason, r.fallbackFrom])).toEqual([
      ["T1", "aborted", "POLICY_CHANGED", "default_T1", null],
      ["T0", "ok", null, "policy_ru_only", "glm-5.3"],
    ]);
    expect(sink.records[0]?.billable).toBe(false);
    // model_switched goes only to the internal journal callback; the result carries no event.
    expect(events).toEqual([
      { type: "model_switched", fromModel: "glm-5.3", toModel: out.model, reason: "fallback_error" },
    ]);
    expect(JSON.stringify(out)).not.toContain("model_switched");
    expect(router.inflightT1?.()).toBe(0);
    expect(bus.size).toBe(0);
  });

  test("t1Restricted switched on aborts too; a change that still allows T1 or another org's change does not", async () => {
    const { bus, router, sink, nextStart } = mk();
    const started = nextStart();
    const p = router.route({ callType: "plan", messages: msgs, orgPolicy: OPEN, ctx: { orgId: ORG } });
    await started;
    bus.publish({ orgId: ORG, policy: OPEN });
    bus.publish({ orgId: OTHER, policy: RU_ONLY });
    await new Promise((r) => setTimeout(r, 20));
    expect(router.inflightT1?.(ORG)).toBe(1);
    bus.publish({ orgId: ORG, policy: { ruOnly: false, t1Restricted: true } });
    const out = await p;
    expect(out.tier).toBe("T0");
    expect(out.routeReason).toBe("policy_region_restricted");
    expect(sink.records.filter((r) => r.status === "aborted")).toHaveLength(1);
  });

  test("a user abort stays an abort (ABORTED), without a T0 repeat", async () => {
    const { router, calls, nextStart, bus } = mk();
    const ctrl = new AbortController();
    const started = nextStart();
    const p = router.route({
      callType: "fix",
      messages: msgs,
      orgPolicy: OPEN,
      ctx: { orgId: ORG },
      signal: ctrl.signal,
    });
    await started;
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
    await expect(p).rejects.toBeInstanceOf(LlmError);
    expect(calls).toEqual(["zai"]);
    expect(bus.size).toBe(0);
  });

  test("T0 calls are never tracked or aborted", async () => {
    const { router, bus, calls } = mk();
    const out = await router.route({
      callType: "support",
      messages: msgs,
      orgPolicy: OPEN,
      ctx: { orgId: ORG },
    });
    expect(out.tier).toBe("T0");
    expect(calls).toEqual(["cloudru"]);
    expect(bus.size).toBe(0);
  });
});

describe("policy cache", () => {
  test("TTL is capped at 10 s; a published change invalidates at once; later calls go to T0", async () => {
    const bus = new PolicyBus();
    let t = 0;
    let stored: OrgPolicy = OPEN;
    let loads = 0;
    const cache = createPolicyCache({
      load: async () => {
        loads++;
        return stored;
      },
      ttlMs: 60_000,
      bus,
      now: () => t,
    });
    expect(POLICY_CACHE_TTL_MS).toBe(10_000);
    await cache.get(ORG);
    t = 9_999;
    await cache.get(ORG);
    expect(loads).toBe(1);
    t = 10_000;
    await cache.get(ORG);
    expect(loads).toBe(2);

    // «Включение ruOnly посреди прогона → все последующие llm_calls.tier = T0».
    const { router, sink } = mk(false, bus);
    const step = async (callType: "interview" | "card" | "plan" | "build_ops") =>
      router.route({ callType, messages: msgs, orgPolicy: await cache.get(ORG), ctx: { orgId: ORG } });
    await step("interview");
    await step("card");
    stored = RU_ONLY; // PATCH /orgs/:id/settings writes the row…
    bus.publish({ orgId: ORG, policy: RU_ONLY }); // …and publishes the change
    await step("plan");
    await step("build_ops");
    expect(sink.records.map((r) => r.tier)).toEqual(["T1", "T1", "T0", "T0"]);
    expect(sink.records.slice(2).every((r) => r.routeReason === "policy_ru_only")).toBe(true);
    cache.close();
    expect(bus.size).toBe(0);
  });

  test("forbidsT1: ruOnly or anything but t1Restricted=false", () => {
    expect(forbidsT1(OPEN)).toBe(false);
    expect(forbidsT1(RU_ONLY)).toBe(true);
    expect(forbidsT1({ ruOnly: false })).toBe(true);
    expect(forbidsT1({ ruOnly: false, t1Restricted: null })).toBe(true);
    expect(forbidsT1(null)).toBe(true);
  });
});
