// B2-20: the modules pipeline end to end on scripted model answers (no network, no money): dental brief → goal interview
// with button questions → plan awaiting approval with its sketch → deterministic edits (no model) → the build starts
// only after approveSystemPlan. Events and responses are checked against workflows.yaml and api.yaml.
import type { RouteInput, RouteOutput, Router, RouterOptions } from "@wizard/llm";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsCjs from "ajv-formats";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  DENTAL_BRIEF,
  dentalAnalysis,
  dentalPlan,
  plannerRegistry,
} from "../../../packages/agents/test/planner-helpers.js";
import { planInterviewTurn } from "../src/agents/executors.js";
import { listEvents } from "../src/runs/events.js";
import type { BuildParams } from "../src/runs/types.js";
import { loadEventSchemas } from "./event-schemas.js";
import { createTestDb, loadYaml, passingReport, startApi, type TestApi, waitRun } from "./helpers.js";

const registry = plannerRegistry();
const schemas = loadEventSchemas();
const addFormats = formatsCjs.default;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({
  $id: "api",
  components: (loadYaml("specs/platform/api.yaml") as { components: unknown }).components,
});
const planRevisionSchema = ajv.getSchema("api#/components/schemas/SystemPlanRevision");
const errorSchema = ajv.getSchema("api#/components/schemas/Error");

/** Router whose model answers by the required tool: submit_goals → the dental analysis, submit_plan → the plan. */
function scriptedRouter(calls: RouteInput[]): (opts: RouterOptions) => Router {
  return () => ({
    mode: "fixture",
    registry: {} as Router["registry"],
    async route(input: RouteInput): Promise<RouteOutput> {
      calls.push(input);
      const tool = input.tools?.[0]?.name;
      const args = tool === "submit_goals" ? dentalAnalysis() : dentalPlan();
      return {
        tier: "T1",
        model: "fixture",
        result: {
          toolCalls: [{ id: `c${calls.length}`, name: tool ?? "none", args }],
          finishReason: "tool-calls",
        },
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
const builds: BuildParams[] = [];

beforeAll(async () => {
  tdb = await createTestDb("b2plan");
  api = await startApi(tdb.url, {
    config: { buildPipeline: "modules" },
    modules: registry,
    createRouter: scriptedRouter(calls),
    executors: {
      interviewTurn: (host) => planInterviewTurn(host, { registry }),
      build: async (_host, params) => {
        builds.push(params);
        return { status: "succeeded", summary_ru: "Собрано по плану" };
      },
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

const validRevision = (body: unknown) => {
  const ok = planRevisionSchema?.(body);
  expect(ok, JSON.stringify(planRevisionSchema?.errors)).toBe(true);
};

describe("modules pipeline: goal interview → plan → edits → approval", () => {
  let systemId = "";
  let fp1 = "";

  test("brief → button questions with a recommendation and the interview sketch; no build", async () => {
    const r = await api.req("POST", "/systems", { body: { prompt: DENTAL_BRIEF } });
    expect(r.status).toBe(201);
    systemId = r.body.system.id;
    await waitRun(api, r.body.run.id, ["succeeded"]);
    const s = await api.req("GET", `/systems/${systemId}`);
    expect(s.body.system.stage).toBe("interview");
    // B2-25: the goal interview state opens the canvas screen.
    expect(s.body.pipeline).toBe("modules");
    expect(s.body.pendingQuestions.map((q: { id: string }) => q.id)).toEqual(["q1", "q2"]);
    const ev = await events(r.body.run.id);
    const sketch = ev.find((e) => e.type === "plan_sketch");
    expect(sketch?.payload).toMatchObject({ stage: "interview", planRevision: null });
    expect(calls.map((c) => c.callType)).toEqual(["interview"]);
    const none = await api.req("GET", `/systems/${systemId}/plan`);
    expect(none.status).toBe(200);
    expect(none.body.plan).toBeNull();
    const approve = await api.req("POST", `/systems/${systemId}/plan/approve`, { body: { revision: 1 } });
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe("NO_PLAN");
  });

  test("answers → the planner → plan revision 1 awaiting approval (stage card), events chat_output plan + plan_sketch", async () => {
    const a = await api.req("POST", `/systems/${systemId}/answers`, {
      body: { answers: [{ questionId: "q1", optionId: "phone" }], restByRecommendation: true },
    });
    expect(a.status).toBe(202);
    await waitRun(api, a.body.run.id, ["succeeded"]);
    expect(calls.map((c) => c.callType)).toEqual(["interview", "system_plan"]);
    const s = await api.req("GET", `/systems/${systemId}`);
    expect(s.body.system.stage).toBe("card");
    expect(s.body.card).toBeNull();
    expect(s.body.pipeline).toBe("modules");
    expect(s.body.messages.at(-1)).toMatchObject({
      role: "assistant",
      kind: "plan",
      payload: { planRevision: 1 },
    });
    const ev = await events(a.body.run.id);
    expect(ev.find((e) => e.type === "chat_output")?.payload).toMatchObject({
      kind: "plan",
      planRevision: 1,
    });
    const sk = ev.find((e) => e.type === "plan_sketch")?.payload as {
      stage: string;
      sketch: { errors: unknown[] };
    };
    expect(sk.stage).toBe("plan");
    expect(sk.sketch.errors).toEqual([]);

    const p = await api.req("GET", `/systems/${systemId}/plan`);
    expect(p.status).toBe(200);
    validRevision(p.body.plan);
    expect(p.body.plan).toMatchObject({
      revision: 1,
      status: "awaiting_approval",
      source: "planner",
      errors: [],
    });
    expect(p.body.plan.plan.modules.map((m: { id: string }) => m.id)).toEqual(["landing", "leads", "notify"]);
    expect(p.body.plan.sketch.goals.map((g: { id: string }) => g.id)).toEqual(["leads", "attract"]);
    fp1 = p.body.plan.fingerprint;
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("no build without approval: nothing queued, /card/approve has no card", async () => {
    const runs = await api.deps.db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", systemId)
      .where("kind", "=", "build")
      .execute();
    expect(runs).toEqual([]);
    const card = await api.req("POST", `/systems/${systemId}/card/approve`, { body: { cardVersion: 1 } });
    expect(card.status).toBe(409);
    expect(card.body.code).toBe("NO_CARD");
  });

  test("a parameter edit without a model: new revision, new sketch; the same edit back gives the old fingerprint", async () => {
    const before = calls.length;
    const t0 = Date.now();
    const e = await api.req("PATCH", `/systems/${systemId}/plan`, {
      body: { revision: 1, edits: [{ op: "set_param", module: "leads", param: "contact", value: "email" }] },
    });
    expect(e.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    validRevision(e.body.plan);
    expect(e.body.plan).toMatchObject({
      revision: 2,
      source: "edit",
      status: "awaiting_approval",
      errors: [],
    });
    expect(e.body.plan.fingerprint).not.toBe(fp1);
    const leads = e.body.plan.sketch.modules.find((m: { id: string }) => m.id === "leads");
    expect(leads.params.find((p: { name: string }) => p.name === "contact").value).toBe("email");
    const back = await api.req("PATCH", `/systems/${systemId}/plan`, {
      body: {
        revision: 2,
        dryRun: true,
        edits: [{ op: "set_param", module: "leads", param: "contact", value: "phone" }],
      },
    });
    expect(back.status).toBe(200);
    expect(back.body.plan).toMatchObject({ revision: 2, dryRun: true });
    expect(back.body.plan.fingerprint).toBe(fp1);
    expect(calls.length).toBe(before);
    const old = await api.req("GET", `/systems/${systemId}/plan?revision=1`);
    expect(old.body.plan.status).toBe("superseded");
  });

  test("sketch for the canvas: light by default, compiled spec and files with detail=full", async () => {
    const light = await api.req("GET", `/systems/${systemId}/plan/sketch`);
    expect(light.status).toBe(200);
    expect(light.body.revision).toBe(2);
    expect(light.body.spec).toBeUndefined();
    expect(light.body.sketch.screens.map((s: { route: string }) => s.route)).toEqual(
      expect.arrayContaining(["/", "/cabinet"]),
    );
    const full = await api.req("GET", `/systems/${systemId}/plan/sketch?detail=full`);
    expect(full.body.spec.entities.map((e: { name: string }) => e.name)).toContain("lead");
    expect(Object.keys(full.body.files)).toContain("ui/pages/Home.tsx");
  });

  test("stale and invalid edits are rejected with Russian reasons", async () => {
    const stale = await api.req("PATCH", `/systems/${systemId}/plan`, {
      body: { revision: 1, edits: [{ op: "remove_section", index: 2 }] },
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: "PLAN_REVISION_STALE", details: { revision: 2 } });
    const bad = await api.req("PATCH", `/systems/${systemId}/plan`, {
      body: { revision: 2, edits: [{ op: "remove_module", module: "leads" }] },
    });
    expect(bad.status).toBe(422);
    expect(errorSchema?.(bad.body)).toBe(true);
    expect(bad.body.code).toBe("PLAN_INVALID");
    expect(bad.body.details.errors.map((x: { code: string }) => x.code)).toContain("GOAL_NOT_COVERED");
    expect(bad.body.message_ru).toMatch(/[а-я]/);
  });

  test("approval of the seen revision starts the build with the plan; the plan is then approved and locked", async () => {
    const stale = await api.req("POST", `/systems/${systemId}/plan/approve`, { body: { revision: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PLAN_REVISION_STALE");
    const ok = await api.req("POST", `/systems/${systemId}/plan/approve`, { body: { revision: 2 } });
    expect(ok.status).toBe(202);
    expect(ok.body.run).toMatchObject({ kind: "build", mode: "create" });
    await waitRun(api, ok.body.run.id, ["succeeded"]);
    expect(builds).toHaveLength(1);
    expect(builds[0]?.plan?.revision).toBe(2);
    const built = builds[0]?.plan?.plan as { modules: { id: string; version?: number }[] } | undefined;
    expect(built?.modules[1]).toMatchObject({
      id: "leads",
      version: 1,
      params: { contact: "email" },
    });
    const run = await api.deps.db
      .selectFrom("platform.runs")
      .select(["credits_cap_milli", "input"])
      .where("id", "=", ok.body.run.id)
      .executeTakeFirstOrThrow();
    expect(Number(run.credits_cap_milli)).toBe(3000);
    expect(run.input).toMatchObject({ pipeline: "modules", planRevision: 2 });
    const p = await api.req("GET", `/systems/${systemId}/plan`);
    expect(p.body.plan).toMatchObject({ revision: 2, status: "approved", buildRunId: ok.body.run.id });
    const again = await api.req("POST", `/systems/${systemId}/plan/approve`, { body: { revision: 2 } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("NO_PLAN");
  });

  test("B2-29: the sketch carries ready section variants and parameter types with options", async () => {
    const p = await api.req("GET", `/systems/${systemId}/plan`);
    const sk = p.body.plan.sketch;
    const hero = sk.sections.find((x: { type: string }) => x.type === "hero");
    expect(hero.variants).toEqual(["split", "centered", "cover"]);
    const leads = sk.modules.find((m: { id: string }) => m.id === "leads");
    expect(leads.params.find((x: { name: string }) => x.name === "contact")).toMatchObject({
      type: "enum",
      options: expect.arrayContaining([{ value: "email", label: "Почта" }]),
    });
    expect(leads.params.find((x: { name: string }) => x.name === "with_service")).toMatchObject({
      type: "bool",
    });
  });

  test("B2-29: a built system edits its approved plan without a model — a new revision, stage card, rebuild", async () => {
    const before = calls.length;
    expect((await api.req("GET", `/systems/${systemId}`)).body.system.stage).toBe("ready");
    const p = await api.req("GET", `/systems/${systemId}/plan`);
    const hero = p.body.plan.sketch.sections.find((x: { type: string }) => x.type === "hero");
    const edit = { op: "update_section", index: hero.index, variant: "centered" };
    const dry = await api.req("PATCH", `/systems/${systemId}/plan`, {
      body: { revision: 2, edits: [edit], dryRun: true },
    });
    expect(dry.status).toBe(200);
    validRevision(dry.body.plan);
    expect(dry.body.plan).toMatchObject({ revision: 2, dryRun: true });
    expect(dry.body.plan.sketch.sections[hero.index].variant).toBe("centered");
    expect((await api.req("GET", `/systems/${systemId}`)).body.system.stage).toBe("ready");
    const ok = await api.req("PATCH", `/systems/${systemId}/plan`, { body: { revision: 2, edits: [edit] } });
    expect(ok.status).toBe(200);
    expect(ok.body.plan).toMatchObject({ revision: 3, status: "awaiting_approval", source: "edit" });
    expect(ok.body.plan.fingerprint).toBe(dry.body.plan.fingerprint);
    expect((await api.req("GET", `/systems/${systemId}`)).body.system.stage).toBe("card");
    expect((await api.req("GET", `/systems/${systemId}/plan?revision=2`)).body.plan.status).toBe("approved");
    expect(calls.length).toBe(before);
    const stale = await api.req("PATCH", `/systems/${systemId}/plan`, {
      body: { revision: 2, edits: [edit] },
    });
    expect(stale.body).toMatchObject({ code: "PLAN_REVISION_STALE", details: { revision: 3 } });
    const run = await api.req("POST", `/systems/${systemId}/plan/approve`, { body: { revision: 3 } });
    expect(run.status).toBe(202);
    await waitRun(api, run.body.run.id, ["succeeded"]);
    expect(builds.at(-1)?.plan?.revision).toBe(3);
  });

  test("B2-29: a wish to a canvas block keeps the block on the message and the planner sees it", async () => {
    const before = calls.length;
    const block = { id: "site:features", title: "Наши преимущества", module: "landing", sectionIndex: 2 };
    const r = await api.req("POST", `/systems/${systemId}/messages`, {
      body: { text: "Сделайте короче", block },
    });
    expect(r.status).toBe(202);
    expect(r.body.message.payload).toEqual({ block });
    await waitRun(api, r.body.run.id, ["succeeded"]);
    const seen = JSON.stringify(calls.slice(before).map((c) => c.messages));
    expect(seen).toContain(
      "Пожелание к блоку «Наши преимущества» (секция страницы №3, модуль landing): Сделайте короче",
    );
    const bad = await api.req("POST", `/systems/${systemId}/messages`, {
      body: { text: "Сделайте короче", block: { id: "site:x", title: "" } },
    });
    expect(bad.status).toBe(400);
  });
});
