// V3-18: v3 per org (WIZARD_BUILD_PIPELINE_ORGS) — the pilot keeps its clients on WIZARD_BUILD_PIPELINE (modules)
// until the v3 checkpoint is accepted, while the orgs listed by id or by kind (eval — measurement orgs, staff — the
// founder's) start their new systems on v3: the grill interview (interview_v3, the reserved «Решите за меня») and the
// canvas; a system keeps the pipeline it started with, and the v3 build executor is on whenever the list names an org.
import { randomUUID } from "node:crypto";
import type { RouteInput, RouteOutput, Router, RouterOptions } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { question, update } from "../../../packages/agents/test/interview-v3/helpers.js";
import { createAgentExecutors } from "../src/agents/executors.js";
import {
  buildPipelineOrgsOf,
  loadConfig,
  PIPELINE_ORG_KINDS,
  pipelineOfOrg,
  pipelineOrgsOn,
} from "../src/config.js";
import { DEFAULT_ORG_ID, DEV_USER_ID } from "../src/db/index.js";
import { orgPipeline } from "../src/services/plans.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

/** interview_v3 gets one question; any other call type fails (the test only reads which call type was asked). */
function recordingRouter(calls: RouteInput[]): (opts: RouterOptions) => Router {
  return () => ({
    mode: "fixture",
    registry: {} as Router["registry"],
    async route(input: RouteInput): Promise<RouteOutput> {
      calls.push(input);
      if (input.callType !== "interview_v3") throw new Error(`нет записи для ${input.callType}`);
      return {
        tier: "T1",
        model: "fixture",
        result: {
          toolCalls: [
            update({
              goals: [
                { id: "leads", text: "Клиенты оставляют заявки", success: "Заявки приходят каждый день" },
              ],
              audience: "Жители района",
            }),
            question("scenarios", "Что клиент делает на сайте сам?", [
              "Оставляет заявку",
              "Записывается на замер",
              "И то, и другое",
            ]),
          ].map((c, i) => ({
            id: `c${calls.length}_${i}`,
            name: c.name,
            args: c.args as Record<string, unknown>,
          })),
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

describe("WIZARD_BUILD_PIPELINE_ORGS: parsing and the rule", () => {
  test("ids and kinds, case and spaces ignored, junk dropped; the env reaches the config", () => {
    const id = "6f1c2a4e-1b2c-4d5e-8f90-0a1b2c3d4e5f";
    expect(buildPipelineOrgsOf(` eval, ${id.toUpperCase()} ,staff,client,v3,,${id}`)).toEqual({
      ids: [id],
      kinds: ["eval", "staff"],
    });
    expect(buildPipelineOrgsOf(undefined)).toEqual({ ids: [], kinds: [] });
    expect(PIPELINE_ORG_KINDS).toEqual(["eval", "staff"]);
    const c = loadConfig({ WIZARD_BUILD_PIPELINE: "modules", WIZARD_BUILD_PIPELINE_ORGS: `eval,${id}` });
    expect(c.buildPipelineOrgs).toEqual({ ids: [id], kinds: ["eval"] });
    expect(pipelineOrgsOn(c)).toBe(true);
    expect(pipelineOrgsOn(loadConfig({}))).toBe(false);
    expect(pipelineOfOrg(c, { id, kind: "client" })).toBe("v3");
    expect(pipelineOfOrg(c, { id: randomUUID(), kind: "eval" })).toBe("v3");
    expect(pipelineOfOrg(c, { id: randomUUID(), kind: "staff" })).toBe("modules");
    expect(pipelineOfOrg(c, { id: randomUUID(), kind: "client" })).toBe("modules");
    // The global switch stays as it was for everybody else.
    expect(pipelineOfOrg({ ...c, buildPipeline: "v3" }, { id: randomUUID(), kind: "client" })).toBe("v3");
  });
});

describe("a pilot on modules with v3 for eval orgs and one listed client org", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let api: TestApi;
  const calls: RouteInput[] = [];
  const evalOrg = randomUUID();
  const listedOrg = randomUUID();

  beforeAll(async () => {
    tdb = await createTestDb("v3orgs");
    api = await startApi(tdb.url, {
      config: {
        buildPipeline: "modules",
        buildPipelineOrgs: buildPipelineOrgsOf(`eval,${listedOrg}`),
        // Credits are not what this test is about.
        billingExemptOrgs: [DEFAULT_ORG_ID, evalOrg, listedOrg],
      },
      createRouter: recordingRouter(calls),
      executors: (d) => createAgentExecutors({ pg: d.pg, config: d.config, research: null }),
    });
    await api.deps.pg`insert into platform.orgs (id, name, plan, kind) values
      (${evalOrg}, 'Замер V3 · тест', 'pilot', 'eval'), (${listedOrg}, 'Студия основателя', 'pilot', 'client')`;
    await api.deps.pg`insert into platform.memberships (org_id, user_id, role) values
      (${evalOrg}, ${DEV_USER_ID}, 'owner'), (${listedOrg}, ${DEV_USER_ID}, 'owner')`;
  });

  afterAll(async () => {
    await api?.dispose();
    await tdb?.drop();
  });

  const create = async (orgId: string) => {
    calls.length = 0;
    const r = await api.req("POST", "/systems", {
      body: { prompt: "Студия ремонта: сайт и заявки на замер", orgId },
    });
    expect(r.status).toBe(201);
    await waitRun(api, r.body.run.id, ["succeeded", "failed"]);
    return { id: r.body.system.id as string, callTypes: calls.map((c) => c.callType) };
  };

  test("orgPipeline: by id without a query, by kind from platform.orgs, the rest — WIZARD_BUILD_PIPELINE", async () => {
    expect(await orgPipeline(api.deps.db, api.deps.config, evalOrg)).toBe("v3");
    expect(await orgPipeline(api.deps.db, api.deps.config, listedOrg)).toBe("v3");
    expect(await orgPipeline(api.deps.db, api.deps.config, DEFAULT_ORG_ID)).toBe("modules");
    expect(await orgPipeline(api.deps.db, api.deps.config, randomUUID())).toBe("modules");
  });

  test("an eval org's new system: the grill interview v3 with «Решите за меня», the canvas", async () => {
    const s = await create(evalOrg);
    expect(s.callTypes).toEqual(["interview_v3"]);
    const view = (await api.req("GET", `/systems/${s.id}`)).body;
    expect(view.pipeline).toBe("modules");
    expect(view.pendingQuestions[0]).toMatchObject({ topic: "scenarios", allowDelegate: true });
    expect(view.pendingQuestions[0].options.at(-1)).toMatchObject({ id: "delegate", delegate: true });
    expect((await api.req("GET", `/systems/${s.id}/brief`)).body.brief).toMatchObject({ version: 1 });
  });

  test("a client org listed by id gets v3 too; the default org stays on the goal interview of modules", async () => {
    expect((await create(listedOrg)).callTypes).toEqual(["interview_v3"]);
    const client = await create(DEFAULT_ORG_ID);
    expect(client.callTypes).not.toContain("interview_v3");
    expect(client.callTypes[0]).toBe("interview");
    expect((await api.req("GET", `/systems/${client.id}`)).body.pipeline).toBe("modules");
    expect((await api.req("GET", `/systems/${client.id}/brief`)).body.brief).toBeNull();
  });

  test("a system keeps its pipeline: dropping the org from the list does not move its interview", async () => {
    const s = await create(evalOrg);
    const before = (await api.req("GET", `/systems/${s.id}`)).body.pendingQuestions[0];
    // The same api with the list emptied: the v3 interview state of the system decides, not the org.
    api.deps.config.buildPipelineOrgs = { ids: [], kinds: [] };
    try {
      calls.length = 0;
      const a = await api.req("POST", `/systems/${s.id}/answers`, {
        body: { answers: [{ questionId: before.id, optionId: "delegate" }] },
      });
      expect(a.status).toBe(202);
      await waitRun(api, a.body.run.id, ["succeeded", "failed"]);
      expect(calls.map((c) => c.callType)).toEqual(["interview_v3"]);
    } finally {
      api.deps.config.buildPipelineOrgs = buildPipelineOrgsOf(`eval,${listedOrg}`);
    }
  });
});
