// B2-41 (found by the D76 dry run): modules.yaml#system_plan.outOfScope — every out-of-scope item of the approved plan
// goes to «Запросы на развитие» with the build run of approveSystemPlan, once per system (recorded answers «dental»:
// online booking and payment on the site are out of scope; no network, no money).
import { createRouter, type Router, type RouterOptions } from "@wizard/llm";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { B2_SCENARIOS } from "../../../packages/agents/test/build-v2-scenarios.js";
import { recordPlanOutOfScope } from "../src/gaps/service.js";
import { createTestDb, startApi, type TestApi, waitRun } from "./helpers.js";

const fixtureRouter = (opts: RouterOptions): Router =>
  createRouter({ ...opts, mode: "fixture", fixture: { suite: "demo", name: "b2/dental" }, env: {} });

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
beforeAll(async () => {
  tdb = await createTestDb("b2plangaps", { migrator: true });
  api = await startApi(tdb.url, {
    config: { buildPipeline: "modules", unsafeLocalExec: true },
    createRouter: fixtureRouter,
  });
});
afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
});

describe("approveSystemPlan records the plan's out-of-scope items", () => {
  test("one request per item with its replacement, linked to the build run; never twice for the system", async () => {
    const sc = B2_SCENARIOS.find((s) => s.name === "dental");
    if (!sc) throw new Error("dental");
    const created = await api.req("POST", "/systems", { body: { prompt: sc.brief } });
    const systemId: string = created.body.system.id;
    const turn = await waitRun(api, created.body.run.id, ["succeeded", "failed"], 30_000);
    expect(turn.status, JSON.stringify(turn.failure)).toBe("succeeded");
    const plan = (await api.req("GET", `/systems/${systemId}/plan`)).body.plan;
    const items = plan.plan.outOfScope as { request: string; replacement: string }[];
    expect(items.length).toBeGreaterThan(0);
    const before = await api.deps.db
      .selectFrom("platform.development_requests")
      .select("id")
      .where("system_id", "=", systemId)
      .execute();
    expect(before).toEqual([]);
    const ap = await api.req("POST", `/systems/${systemId}/plan/approve`, { body: { revision: 1 } });
    expect(ap.status).toBe(202);
    const rows = await api.deps.db
      .selectFrom("platform.development_requests")
      .select(["quote", "offered", "run_id", "org_id", "category"])
      .where("system_id", "=", systemId)
      .orderBy("quote")
      .execute();
    expect(rows.map((r) => [r.quote, r.offered]).sort()).toEqual(
      items.map((o) => [o.request, o.replacement]).sort(),
    );
    expect(new Set(rows.map((r) => r.run_id))).toEqual(new Set([ap.body.run.id]));
    // A rebuild approves the same items again: nothing new for the system.
    const again = await recordPlanOutOfScope(
      api.deps.db,
      { id: ap.body.run.id, org_id: rows[0]?.org_id ?? "", system_id: systemId, started_by: null },
      items,
    );
    expect(again).toBe(0);
    const total = await api.deps.db
      .selectFrom("platform.development_requests")
      .select("id")
      .where("system_id", "=", systemId)
      .execute();
    expect(total.length).toBe(rows.length);
    await waitRun(api, ap.body.run.id, ["succeeded", "failed"], 240_000);
  });
});
