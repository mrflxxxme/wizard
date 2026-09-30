// Run lifecycle: budget check before LLM steps (workflows.yaml#run_lifecycle.budget), cancel of queued runs,
// global concurrency (execution.M0), DbUsageSink, WIZARD_RUN_CONCURRENCY.
import type { RouteOutput, Router, RouterOptions } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { listEvents } from "../src/runs/events.js";
import type { BuildHost, InterviewHost, RunExecutors } from "../src/runs/types.js";
import { DbUsageSink } from "../src/runs/usage.js";
import { loadEventSchemas } from "./event-schemas.js";
import { startBuild } from "./flow.js";
import { createTestDb, fakeInterview, startApi, type TestApi, waitFor, waitRun } from "./helpers.js";

const schemas = loadEventSchemas();
let tdb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  tdb = await createTestDb("runs");
});
afterAll(async () => {
  await tdb?.drop();
});

function countingRouter(creditsMilli: number) {
  const calls: string[] = [];
  const factory = (_o: RouterOptions): Router => ({
    mode: "fixture",
    registry: {} as Router["registry"],
    async route(input): Promise<RouteOutput> {
      calls.push(input.callType);
      return {
        tier: "T0",
        model: "fixture",
        result: { text: "ok", toolCalls: [], finishReason: "stop" },
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
        creditsCharged: creditsMilli / 1000,
        creditsMilli,
        routeReason: "default_T0",
        scrubbed: false,
        ruFallback: false,
      };
    },
  });
  return { calls, factory };
}

const budgetBuild: RunExecutors["build"] = async (host: BuildHost) => {
  await host.route({
    callType: "build_code",
    messages: [{ role: "user", content: "…" }],
    step: "code",
    upperBoundCredits: 25,
  });
  return { summary_ru: "ok" };
};

async function valid(api: TestApi, runId: string) {
  const ev = await listEvents(api.deps.db, runId, 0);
  expect(ev.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  return ev;
}

describe("budget", () => {
  test("build: budget_exceeded → needs_input(budget) → raise_cap_N continues; stop → cancelled without an LLM call", async () => {
    const router = countingRouter(1000);
    const api = await startApi(tdb.url, {
      executors: { interviewTurn: fakeInterview, build: budgetBuild },
      createRouter: router.factory,
    });
    try {
      // cap 20 (card min = ceil(expected 20)); the call's upper bound is 25 → exceeded.
      for (const choice of ["raise_cap_5", "stop"]) {
        const c = await startBuild(api, `Бюджет ${choice}`, 20);
        const run = await api.req("GET", `/runs/${c.buildRunId}`);
        if (run.body.status !== "needs_input") await waitRun(api, c.buildRunId, ["needs_input"]);
        const before = router.calls.length;
        const pending = (
          await api.deps.db
            .selectFrom("platform.runs")
            .select("pending_input")
            .where("id", "=", c.buildRunId)
            .executeTakeFirstOrThrow()
        ).pending_input as { inputId: string; decisionId: string; options: { id: string }[] };
        expect(pending.decisionId).toBe("budget");
        expect(pending.options.map((o) => o.id)).toEqual(["raise_cap_5", "stop"]);
        expect(router.calls.length).toBe(before); // nothing called after budget_exceeded
        const r = await api.req("POST", `/runs/${c.buildRunId}/input`, {
          body: { inputId: pending.inputId, choice },
        });
        expect(r.status).toBe(202);
        const done = await waitRun(api, c.buildRunId, ["succeeded", "cancelled"]);
        const ev = await valid(api, c.buildRunId);
        const types = ev.map((e) => e.type);
        expect(types.indexOf("budget_exceeded")).toBeLessThan(types.indexOf("needs_input"));
        if (choice === "stop") {
          expect(done.status).toBe("cancelled");
          expect(ev.at(-1)?.payload).toMatchObject({ status: "cancelled" });
          expect(router.calls.length).toBe(before);
        } else {
          expect(done.status).toBe("succeeded");
          expect(done.credits).toMatchObject({ cap: 25, used: 1 });
          expect(types).toContain("budget_update");
          expect(router.calls.length).toBe(before + 1);
        }
      }
    } finally {
      await api.dispose();
    }
  });

  test("interview turn over its 2-credit cap → run_failed BUDGET_STOPPED", async () => {
    const router = countingRouter(2500);
    const interviewTurn = async (host: InterviewHost) => {
      await host.route({ callType: "interview", messages: [{ role: "user", content: "…" }] });
      await host.route({ callType: "interview", messages: [{ role: "user", content: "…" }] });
      return { kind: "answer" as const, text: "никогда" };
    };
    const api = await startApi(tdb.url, {
      executors: { interviewTurn, build: budgetBuild },
      createRouter: router.factory,
    });
    try {
      const c = await api.req("POST", "/systems", { body: { prompt: "Дорогой ход интервью" } });
      const run = await waitRun(api, c.body.run.id, ["failed"]);
      expect(run.failure.code).toBe("BUDGET_STOPPED");
      expect(router.calls).toHaveLength(1);
      const ev = await valid(api, c.body.run.id);
      expect(ev.map((e) => e.type)).not.toContain("needs_input");
    } finally {
      await api.dispose();
    }
  });
});

describe("queue", () => {
  test("global concurrency; queued runs are cancelled directly", async () => {
    let running = 0;
    let peak = 0;
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const interviewTurn = async (host: InterviewHost) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.race([
        hold,
        new Promise((r) => host.signal.addEventListener("abort", r, { once: true })),
      ]);
      running--;
      return { kind: "answer" as const, text: "ok" };
    };
    const api = await startApi(tdb.url, {
      executors: { interviewTurn, build: budgetBuild },
      createRouter: countingRouter(0).factory,
      config: { runConcurrency: 2 },
    });
    try {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++)
        ids.push((await api.req("POST", "/systems", { body: { prompt: `Система номер ${i}` } })).body.run.id);
      await waitFor(async () => running === 2);
      const statuses = await Promise.all(
        ids.map(async (id) => (await api.req("GET", `/runs/${id}`)).body.status),
      );
      expect(statuses.filter((s) => s === "queued")).toHaveLength(2);
      const queued = ids[statuses.lastIndexOf("queued")] as string;
      const c = await api.req("POST", `/runs/${queued}/cancel`);
      expect(c.status).toBe(202);
      expect(c.body.status).toBe("cancelled");
      expect((await valid(api, queued)).map((e) => e.type)).toEqual(["run_finished"]);
      release();
      await Promise.all(ids.filter((id) => id !== queued).map((id) => waitRun(api, id, ["succeeded"])));
      expect(peak).toBe(2);
    } finally {
      release();
      await api.dispose();
    }
  });

  test("WIZARD_RUN_CONCURRENCY parsing", () => {
    expect(loadConfig({}).runConcurrency).toBe(2);
    expect(loadConfig({ WIZARD_RUN_CONCURRENCY: "5" }).runConcurrency).toBe(5);
    expect(loadConfig({ WIZARD_RUN_CONCURRENCY: "zero" }).runConcurrency).toBe(2);
  });
});

describe("usage sink", () => {
  test("DbUsageSink writes platform.llm_calls without prompt text", async () => {
    const api = await startApi(tdb.url, { executors: { interviewTurn: fakeInterview, build: budgetBuild } });
    try {
      const sink = new DbUsageSink(api.deps.db);
      await sink.write({
        id: "11111111-1111-4111-8111-111111111111",
        runId: null,
        orgId: "00000000-0000-0000-0000-000000000001",
        systemId: null,
        step: "orchestrate",
        callType: "interview",
        agentRole: "orchestrator",
        tier: "T0",
        provider: "fixture",
        modelId: "qwen3",
        attempt: 1,
        status: "ok",
        errorCode: null,
        routeReason: "default_T0",
        fallbackFrom: null,
        policyVersion: "p1",
        scrubbed: false,
        piiCategoriesCount: { phone_ru: 2 },
        inputTokens: 10,
        cachedTokens: 0,
        outputTokens: 3,
        toolCalls: 0,
        latencyMs: 12.4,
        ttftMs: null,
        costRub: 0.0123,
        creditsMilli: 7,
        billable: true,
        mode: "fixture",
        requestHash: "abc",
        createdAt: new Date().toISOString(),
      });
      const [row] = await api.deps
        .pg`select * from platform.llm_calls where id = '11111111-1111-4111-8111-111111111111'`;
      expect(row).toMatchObject({
        call_type: "interview",
        credits_milli: "7",
        pii_categories_count: { phone_ru: 2 },
      });
    } finally {
      await api.dispose();
    }
  });
});
