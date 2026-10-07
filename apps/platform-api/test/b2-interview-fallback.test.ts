// B2-41: a crooked model answer never ends the goal interview on the platform — the model answers the interview with
// text only (no submit_goals) and the plan with an invalid plan: the run still succeeds with fallback button questions,
// then a plan awaiting approval built from the interview; orch_invalid {step, fallback, issues} is recorded (internal,
// workflows.yaml) and counted in wizard_interview_fallbacks_total. Scripted answers, no network, no money.
import type { RouteInput, RouteOutput, Router, RouterOptions } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DENTAL_BRIEF, dentalPlan, plannerRegistry } from "../../../packages/agents/test/planner-helpers.js";
import { planInterviewTurn } from "../src/agents/executors.js";
import { interviewFallbacks } from "../src/ops/metrics.js";
import { listEvents } from "../src/runs/events.js";
import { loadEventSchemas } from "./event-schemas.js";
import { createTestDb, passingReport, startApi, type TestApi, waitRun } from "./helpers.js";

const registry = plannerRegistry();
const schemas = loadEventSchemas();

/** The model never calls submit_goals (text only) and sends a plan without goals. */
function crookedRouter(calls: RouteInput[]): (opts: RouterOptions) => Router {
  return () => ({
    mode: "fixture",
    registry: {} as Router["registry"],
    async route(input: RouteInput): Promise<RouteOutput> {
      calls.push(input);
      const tool = input.tools?.[0]?.name;
      const result =
        tool === "submit_plan"
          ? {
              toolCalls: [{ id: `c${calls.length}`, name: tool, args: { ...dentalPlan(), goals: [] } }],
              finishReason: "tool-calls",
            }
          : { text: "Сейчас подумаю над целями клиента…", toolCalls: [], finishReason: "stop" };
      return {
        tier: "T1",
        model: "fixture",
        result,
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5 },
        creditsCharged: 0.01,
        creditsMilli: 10,
        routeReason: "default_T1",
        scrubbed: true,
        ruFallback: false,
      };
    },
  });
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const calls: RouteInput[] = [];

beforeAll(async () => {
  tdb = await createTestDb("b2fallback");
  api = await startApi(tdb.url, {
    config: { buildPipeline: "modules" },
    modules: registry,
    createRouter: crookedRouter(calls),
    executors: {
      interviewTurn: (host) => planInterviewTurn(host, { registry }),
      build: async () => ({ status: "succeeded", summary_ru: "Собрано по плану" }),
      gates: async (level, ctx) => passingReport(level, ctx.specVersion),
    },
  });
});

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function events(runId: string) {
  const list = await listEvents(api.deps.db, runId, 0);
  expect(list.map((e) => schemas.validate(e)).filter(Boolean)).toEqual([]);
  return list;
}

describe("goal interview fallback on the platform", () => {
  test("text instead of submit_goals → fallback questions; invalid plans → the plan from the interview", async () => {
    const before = {
      questions: interviewFallbacks.get({ step: "interview", fallback: "questions" }),
      plan: interviewFallbacks.get({ step: "system_plan", fallback: "plan" }),
    };
    const r = await api.req("POST", "/systems", { body: { prompt: DENTAL_BRIEF } });
    expect(r.status).toBe(201);
    const systemId = r.body.system.id;
    await waitRun(api, r.body.run.id, ["succeeded"]);
    expect(calls.map((c) => c.callType)).toEqual(["interview", "interview", "interview"]);
    const s = await api.req("GET", `/systems/${systemId}`);
    expect(s.body.system.stage).toBe("interview");
    const pending = s.body.pendingQuestions as { id: string; options: { recommended: boolean }[] }[];
    expect(pending.length).toBeGreaterThanOrEqual(2);
    for (const q of pending) expect(q.options.filter((o) => o.recommended)).toHaveLength(1);
    const ev1 = await events(r.body.run.id);
    const inv = ev1.find((e) => e.type === "orch_invalid");
    expect(inv?.payload).toMatchObject({ step: "interview", fallback: "questions" });
    expect(JSON.stringify(inv?.payload.issues)).toContain("NO_TOOL_CALL");
    expect(ev1.some((e) => e.type === "run_failed")).toBe(false);

    const a = await api.req("POST", `/systems/${systemId}/answers`, { body: { restByRecommendation: true } });
    expect(a.status).toBe(202);
    await waitRun(api, a.body.run.id, ["succeeded"]);
    const plan = await api.req("GET", `/systems/${systemId}/plan`);
    expect(plan.body.plan.status).toBe("awaiting_approval");
    expect(plan.body.plan.errors ?? []).toEqual([]);
    const ev2 = await events(a.body.run.id);
    expect(ev2.find((e) => e.type === "orch_invalid")?.payload).toMatchObject({
      step: "system_plan",
      fallback: "plan",
    });
    expect(interviewFallbacks.get({ step: "interview", fallback: "questions" })).toBe(before.questions + 1);
    expect(interviewFallbacks.get({ step: "system_plan", fallback: "plan" })).toBe(before.plan + 1);
  });
});
