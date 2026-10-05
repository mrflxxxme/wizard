// BuildHost.routeBatch (agents/builder.yaml#harness.tasks.parallel): one budget check for Σ upperBoundCredits, ONE
// durable step llm_batch:<steps> for the wave, credits and budget_update once; a failed call is {ok: false}; fixture
// mode runs the calls in input order (and a replayed batch advances the fixture router in the same order).
import { LlmError, type RouteOutput, type Router, type RouterOptions } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Durable } from "../src/runs/durable.js";
import { listEvents } from "../src/runs/events.js";
import type { BuildHost, RouteBatchItem, RunExecutors } from "../src/runs/types.js";
import { loadEventSchemas } from "./event-schemas.js";
import { startBuild } from "./flow.js";
import { createTestDb, fakeInterview, parseSse, startApi, type TestApi, waitRun } from "./helpers.js";

const schemas = loadEventSchemas();
let tdb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  tdb = await createTestDb("route_batch");
});
afterAll(async () => {
  await tdb?.drop();
});

const answer = (step: string): RouteOutput => ({
  tier: "T0",
  model: "fake",
  result: { text: `out:${step}`, toolCalls: [], finishReason: "stop" },
  usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
  creditsCharged: 1,
  creditsMilli: 1000,
  routeReason: "default_T0",
  scrubbed: false,
  ruFallback: false,
});

/** Fake router: 1 credit per call; steps "fail_llm" / "fail_other" throw; tracks order and peak concurrency. */
function fakeRouter(mode: Router["mode"]) {
  const calls: string[] = [];
  let running = 0;
  let peak = 0;
  const factory = (_o: RouterOptions): Router => ({
    mode,
    registry: {} as Router["registry"],
    async route(input): Promise<RouteOutput> {
      // Interview turns of the test flow route too: only the builder's calls are tracked (and charged nothing).
      if (input.callType !== "build_code")
        return { ...answer("interview"), creditsMilli: 0, creditsCharged: 0 };
      const step = input.ctx.step ?? input.callType;
      calls.push(step);
      running++;
      peak = Math.max(peak, running);
      try {
        // Lets the other calls of the wave start (concurrent mode) before this one finishes.
        await new Promise((r) => setTimeout(r, 20));
        if (step === "fail_llm") throw new LlmError("LLM_UNAVAILABLE", "модели недоступны");
        if (step === "fail_other") throw new Error("boom");
        return answer(step);
      } finally {
        running--;
      }
    },
  });
  return { calls, factory, peak: () => peak };
}

function batchBuild(steps: string[], ub: number, out: RouteBatchItem[][]): RunExecutors["build"] {
  return async (host: BuildHost) => {
    out.push(
      await host.routeBatch(
        steps.map((step) => ({
          callType: "build_code" as const,
          messages: [{ role: "user" as const, content: "…" }],
          step,
          upperBoundCredits: ub,
        })),
      ),
    );
    return { summary_ru: "ok" };
  };
}

/** Records the durable step names per run; `replayBatch` marks the llm_batch step as replayed. */
function recordSteps(api: TestApi, replayBatch = false): Map<string, string[]> {
  const byRun = new Map<string, string[]>();
  const orig = api.engine.executeRun.bind(api.engine);
  api.engine.executeRun = (id: string, D: Durable) => {
    const steps: string[] = [];
    byRun.set(id, steps);
    const w = {
      durable: D.durable,
      replayed: false,
      async step<T>(name: string, fn: () => Promise<T>, o?: { offload?: boolean }): Promise<T> {
        const v = await D.step(name, fn, o);
        steps.push(name);
        w.replayed = replayBatch && name.startsWith("llm_batch:");
        return v;
      },
      recv: <T>(topic: string, ms: number) => D.recv<T>(topic, ms),
      send: (to: string, topic: string, m: unknown) => D.send(to, topic, m),
    };
    return orig(id, w);
  };
  return byRun;
}

async function pendingInput(api: TestApi, runId: string) {
  const r = await api.deps.db
    .selectFrom("platform.runs")
    .select("pending_input")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return r.pending_input as { inputId: string; decisionId: string; options: { id: string }[] };
}

async function validEvents(api: TestApi, runId: string) {
  const ev = await listEvents(api.deps.db, runId, 0);
  expect(ev.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  return ev;
}

describe("routeBatch", () => {
  test("3 calls: one llm_batch step, concurrent, credits Σ once, one budget_update; failures are {ok:false}", async () => {
    const router = fakeRouter("live");
    const out: RouteBatchItem[][] = [];
    const api = await startApi(tdb.url, {
      executors: {
        interviewTurn: fakeInterview,
        build: batchBuild(["T1", "fail_llm", "fail_other"], 1, out),
      },
      createRouter: router.factory,
    });
    try {
      const runs = recordSteps(api);
      const c = await startBuild(api, "Пакет вызовов", 20);
      const done = await waitRun(api, c.buildRunId, ["succeeded"]);
      const steps = runs.get(c.buildRunId) ?? [];
      expect(steps.filter((s) => s.startsWith("llm"))).toEqual(["llm_batch:T1,fail_llm,fail_other"]);
      expect(steps.filter((s) => s === "budget_check")).toHaveLength(1);
      expect(router.peak()).toBe(3);
      expect(out[0]).toEqual([
        { ok: true, out: expect.objectContaining({ result: expect.objectContaining({ text: "out:T1" }) }) },
        { ok: false, code: "LLM_UNAVAILABLE", message: "модели недоступны" },
        { ok: false, code: "INTERNAL", message: "boom" },
      ]);
      expect(done.credits).toMatchObject({ used: 1 });
      const ev = await validEvents(api, c.buildRunId);
      expect(ev.filter((e) => e.type === "budget_update")).toHaveLength(1);
    } finally {
      await api.dispose();
    }
  });

  test("budget: Σ upper bounds checked once → one needs_input(budget); after raise_cap all 3 run", async () => {
    const router = fakeRouter("live");
    const out: RouteBatchItem[][] = [];
    const api = await startApi(tdb.url, {
      // 3 × 8 = 24 > cap 20 although each call alone fits.
      executors: { interviewTurn: fakeInterview, build: batchBuild(["T1", "T2", "T3"], 8, out) },
      createRouter: router.factory,
    });
    try {
      const runs = recordSteps(api);
      const c = await startBuild(api, "Пакет и бюджет", 20);
      await waitRun(api, c.buildRunId, ["needs_input"]);
      expect(router.calls).toEqual([]);
      const pending = await pendingInput(api, c.buildRunId);
      expect(pending.decisionId).toBe("budget");
      expect(pending.options.map((o) => o.id)).toEqual(["raise_cap_5", "stop"]);
      const r = await api.req("POST", `/runs/${c.buildRunId}/input`, {
        body: { inputId: pending.inputId, choice: "raise_cap_5" },
      });
      expect(r.status).toBe(202);
      const done = await waitRun(api, c.buildRunId, ["succeeded"]);
      expect(router.calls).toHaveLength(3);
      expect(done.credits).toMatchObject({ cap: 25, used: 3 });
      expect(out[0]?.every((i) => i.ok)).toBe(true);
      expect((runs.get(c.buildRunId) ?? []).filter((s) => s.startsWith("llm"))).toEqual([
        "llm_batch:T1,T2,T3",
      ]);
      const ev = await validEvents(api, c.buildRunId);
      const exceeded = ev.filter((e) => e.type === "budget_exceeded");
      expect(exceeded).toHaveLength(1);
      expect(exceeded[0]?.payload).toMatchObject({ nextStep: "T1", cap: 20 });
      expect(ev.filter((e) => e.type === "needs_input")).toHaveLength(1);
      expect(ev.filter((e) => e.type === "budget_update")).toHaveLength(1);
    } finally {
      await api.dispose();
    }
  });

  test("fixture mode: calls in input order, one at a time; a replayed batch advances the router in order", async () => {
    const router = fakeRouter("fixture");
    const out: RouteBatchItem[][] = [];
    const api = await startApi(tdb.url, {
      executors: { interviewTurn: fakeInterview, build: batchBuild(["T1", "T2", "T3"], 1, out) },
      createRouter: router.factory,
    });
    try {
      recordSteps(api, true);
      const c = await startBuild(api, "Пакет в fixture", 20);
      const done = await waitRun(api, c.buildRunId, ["succeeded"]);
      expect(router.peak()).toBe(1);
      // The batch, then the (simulated) replay advancing the fixture router.
      expect(router.calls).toEqual(["T1", "T2", "T3", "T1", "T2", "T3"]);
      expect(out[0]?.map((i) => i.ok && i.out.result.text)).toEqual(["out:T1", "out:T2", "out:T3"]);
      expect(done.credits).toMatchObject({ used: 3 });
    } finally {
      await api.dispose();
    }
  });

  test("build_metrics: the builder's emit is journaled (valid payload) and never streamed", async () => {
    const metrics = { stages: { tasks: { total: 3, firstPass: 2 } }, creditsUsed: 1.5, durationMs: 1200 };
    const build: RunExecutors["build"] = async (host: BuildHost) => {
      await host.emit("build_metrics", metrics);
      return { summary_ru: "ok" };
    };
    const api = await startApi(tdb.url, {
      executors: { interviewTurn: fakeInterview, build },
      createRouter: fakeRouter("fixture").factory,
    });
    try {
      const c = await startBuild(api, "Метрики этапов", 20);
      await waitRun(api, c.buildRunId, ["succeeded"]);
      const ev = await validEvents(api, c.buildRunId);
      expect(ev.find((e) => e.type === "build_metrics")?.payload).toEqual(metrics);
      const sse = await api.req("GET", `/runs/${c.buildRunId}/events`);
      expect(parseSse(sse.text).map((f) => f.event)).not.toContain("build_metrics");
    } finally {
      await api.dispose();
    }
  });
});
