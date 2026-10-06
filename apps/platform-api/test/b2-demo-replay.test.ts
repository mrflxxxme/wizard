// Acceptance B2-02 (product.yaml#decisions.D76_beta_v2, docs/reviews/grill-6.md № 12; agents/models.yaml
// #credits.demo_replay): a staff user switches demo replay on in /admin and walks the client path — brief → interview →
// card → build → preview — on the recorded demo/forum answers with no paid call (llm_calls only fixture, Σ cost_rub = 0),
// while the platform router itself is live and its network refuses. Client and eval orgs cannot get the mode (403); a
// brief or a run with no recording fails with «В режиме показа есть только записанные сценарии: …», never live.
import { randomUUID } from "node:crypto";
import { createRouter, type Router } from "@wizard/llm";
import { closeExecutors } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import { json } from "../src/db/index.js";
import { grantPilotCredits } from "../src/pilot/service.js";
import {
  DEMO_REPLAY_MISS,
  demoFixture,
  demoMissMessage,
  demoRouter,
  demoScenarios,
  matchDemoScenario,
} from "../src/runs/demo-replay.js";
import { RunFailure } from "../src/runs/types.js";
import { createTestDb, startApi, type TestApi, waitFor } from "./helpers.js";
import { devLogin, expectContract, type Session } from "./session.js";

const STAFF = "founder-demo@example.test";
const CLIENT = "owner-demo@bakery.example";
const EVAL = "eval+demo@example.test";
const MISS_RU = /^В режиме показа есть только записанные сценарии: «Отраслевой форум «Северный ритейл»»/;

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let staff: Session;
let client: Session;
let evalUser: Session;
let staffOrg = "";
let clientOrg = "";
let evalOrg = "";
/** Network of the live router: any request is a paid call that must not happen. */
const fetched: string[] = [];

const orgOf = async (s: Session) => (await s.req("GET", "/me")).body.memberships[0].orgId as string;
const orgRow = (id: string) =>
  api.deps.db
    .selectFrom("platform.orgs")
    .select(["kind", "demo_replay"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
const waitRun = (s: Session, runId: string, statuses: string[], ms: number) =>
  waitFor(async () => {
    const r = await s.req("GET", `/runs/${runId}`);
    return statuses.includes(r.body.status) ? r.body : undefined;
  }, ms);
const calls = (orgId: string) =>
  api.deps.db
    .selectFrom("platform.llm_calls")
    .select(["run_id", "mode", "cost_rub", "credits_milli", "status"])
    .where("org_id", "=", orgId)
    .execute();

beforeAll(async () => {
  tdb = await createTestDb("demoreplay", { migrator: true });
  api = await startApi(tdb.url, {
    config: { unsafeLocalExec: true },
    // The platform runs live: only demo replay may turn a run's router into the free fixture router.
    createRouter: (o) =>
      createRouter({
        ...o,
        env: { WIZARD_LLM_MODE: "live" },
        fetch: async (input) => {
          fetched.push(String(input));
          throw new Error("network must not be used");
        },
      }),
  });
  staff = await devLogin(api, STAFF);
  client = await devLogin(api, CLIENT);
  evalUser = await devLogin(api, EVAL);
  [staffOrg, clientOrg, evalOrg] = await Promise.all([orgOf(staff), orgOf(client), orgOf(evalUser)]);
  await setStaff(api.deps.db, STAFF, true);
  await api.deps.db.updateTable("platform.orgs").set({ kind: "eval" }).where("id", "=", evalOrg).execute();
  await api.deps.db.updateTable("platform.orgs").set({ plan: "pilot" }).where("id", "=", staffOrg).execute();
  await grantPilotCredits(api.deps.db, api.deps.billing, {
    orgId: staffOrg,
    credits: 5000,
    reference: "b2-02",
  });
  const en = await staff.req("POST", "/admin/mfa/enroll");
  expect(en.status, en.text).toBe(200);
  const ok = await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
  expect(ok.status, ok.text).toBe(200);
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await closeExecutors();
  await tdb?.drop();
});

describe("recorded scenarios", () => {
  test("demo/forum is a scenario with its point_edit recording; bakery (interview of an older fork list) is not", () => {
    const list = demoScenarios();
    expect(list.map((s) => s.name)).toEqual(["forum"]);
    expect(list[0]?.modes).toEqual(["point_edit"]);
    expect(list[0]?.brief).toMatch(/^Организуем отраслевой форум «Северный ритейл»/);
    // Whitespace does not matter, the text does.
    expect(matchDemoScenario(`  ${list[0]?.brief.replace(/ /g, "\n ")}  `)?.name).toBe("forum");
    expect(matchDemoScenario("Хочу CRM для салона красоты")).toBeNull();
    expect(demoMissMessage()).toMatch(MISS_RU);
  });

  test("runs of a demo system: interview and create build replay the scenario, point_edit its recording, other modes nothing", () => {
    expect(demoFixture("forum", { kind: "interview_turn", mode: null })).toEqual({
      suite: "demo",
      name: "forum",
    });
    expect(demoFixture("forum", { kind: "build", mode: "create" })).toEqual({ suite: "demo", name: "forum" });
    expect(demoFixture("forum", { kind: "build", mode: "point_edit" })).toEqual({
      suite: "demo",
      name: "forum.point_edit",
    });
    expect(demoFixture("forum", { kind: "build", mode: "change" })).toBeNull();
    expect(demoFixture("forum", { kind: "import_table", mode: null })).toBeNull();
    expect(demoFixture(null, { kind: "interview_turn", mode: null })).toBeNull();
    expect(demoFixture("bakery", { kind: "interview_turn", mode: null })).toBeNull();
  });

  test("a call with no recorded answer fails the run with DEMO_REPLAY_MISS instead of going live", async () => {
    const router: Router = demoRouter(
      createRouter({
        mode: "fixture",
        free: true,
        fixture: { suite: "unit", name: `none-${randomUUID()}` },
        sink: { write: () => {} },
        env: {},
      }),
    );
    const err = await router
      .route({
        callType: "interview",
        messages: [{ role: "user", content: "Хочу CRM" }],
        orgPolicy: { ruOnly: false, t1Restricted: false },
        ctx: { orgId: staffOrg },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunFailure);
    expect(err).toMatchObject({ code: DEMO_REPLAY_MISS, message_ru: expect.stringMatching(MISS_RU) });
  });
});

describe("PUT /admin/orgs/:id/flags demoReplay", () => {
  test("clients get 404 on /admin; client and eval orgs are refused with 403 and keep the flag off", async () => {
    const own = await client.req("PUT", `/admin/orgs/${clientOrg}/flags`, { body: { demoReplay: true } });
    expect(own.status).toBe(404);
    for (const orgId of [clientOrg, evalOrg]) {
      const r = await staff.req("PUT", `/admin/orgs/${orgId}/flags`, { body: { demoReplay: true } });
      expect(r.status, r.text).toBe(403);
      expect(r.body).toMatchObject({
        code: "FORBIDDEN",
        message_ru: "Режим показа доступен только служебной организации",
      });
      expect((await orgRow(orgId)).demo_replay).toBe(false);
    }
    const o = await client.req("GET", `/orgs/${clientOrg}`);
    expect(o.body).toMatchObject({ demoReplay: false });
    expect(o.body.demoScenarios).toBeUndefined();
  });

  test("staff switches it on for a staff org (staff_audit_log); leaving staff switches it off", async () => {
    const extra = await staff.req("POST", "/orgs", { body: { name: "Wizard — второй показ" } });
    expect(extra.status, extra.text).toBe(201);
    const on = await staff.req("PUT", `/admin/orgs/${extra.body.id}/flags`, { body: { demoReplay: true } });
    expect(on.status, on.text).toBe(200);
    expectContract("adminSetOrgFlags", on);
    expect(on.body).toMatchObject({ kind: "staff", demoReplay: true });
    const off = await staff.req("PUT", `/admin/orgs/${extra.body.id}/flags`, { body: { kind: "client" } });
    expect(off.body).toMatchObject({ kind: "client", demoReplay: false });
    // kind and the flag in one request: the kind after the request decides.
    const both = await staff.req("PUT", `/admin/orgs/${extra.body.id}/flags`, {
      body: { kind: "staff", demoReplay: true },
    });
    expect(both.body).toMatchObject({ kind: "staff", demoReplay: true });

    const r = await staff.req("PUT", `/admin/orgs/${staffOrg}/flags`, { body: { demoReplay: true } });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ orgId: staffOrg, kind: "staff", demoReplay: true });
    const audit = await api.deps.db
      .selectFrom("platform.staff_audit_log")
      .select("note")
      .where("action", "=", "org_flags")
      .where("target", "=", `org:${staffOrg}`)
      .execute();
    expect(audit.map((a) => a.note)).toEqual(['{"demoReplay":true}']);
    const o = await staff.req("GET", `/orgs/${staffOrg}`);
    expect(o.status).toBe(200);
    expectContract("getOrg", o);
    expect(o.body.demoReplay).toBe(true);
    expect(o.body.demoScenarios).toEqual([
      { name: "forum", title: "Отраслевой форум «Северный ритейл»", brief: demoScenarios()[0]?.brief },
    ]);
  });
});

describe("the client path of a staff org in demo replay", () => {
  test("a brief that is not recorded: 422 with the scenarios, no system, no model call", async () => {
    const r = await staff.req("POST", "/systems", { body: { prompt: "Хочу CRM для салона красоты" } });
    expect(r.status, r.text).toBe(422);
    expect(r.body).toMatchObject({
      code: "DEMO_REPLAY_NO_SCENARIO",
      message_ru: expect.stringMatching(MISS_RU),
      details: { scenarios: [{ name: "forum", title: "Отраслевой форум «Северный ритейл»" }] },
    });
    const systems = await api.deps.db
      .selectFrom("platform.systems")
      .select("id")
      .where("org_id", "=", staffOrg)
      .execute();
    expect(systems).toEqual([]);
    expect(await calls(staffOrg)).toEqual([]);
  });

  test("brief → interview → card → build → preview on recorded answers: llm_calls only fixture, Σ cost_rub = 0", async () => {
    const brief = (await staff.req("GET", `/orgs/${staffOrg}`)).body.demoScenarios[0].brief as string;
    const created = await staff.req("POST", "/systems", { body: { prompt: brief } });
    expect(created.status, created.text).toBe(201);
    const systemId: string = created.body.system.id;
    const r0 = await waitRun(staff, created.body.run.id, ["succeeded", "failed"], 20_000);
    expect(r0.status, JSON.stringify(r0.failure)).toBe("succeeded");
    const q = await staff.req("GET", `/systems/${systemId}`);
    expect(q.body.demoReplay).toBe(true);
    expect(q.body.pendingQuestions.length).toBeGreaterThanOrEqual(3);
    const ans = await staff.req("POST", `/systems/${systemId}/answers`, {
      body: { restByRecommendation: true },
    });
    expect(ans.status, ans.text).toBe(202);
    const r1 = await waitRun(staff, ans.body.run.id, ["succeeded", "failed"], 20_000);
    expect(r1.status, JSON.stringify(r1.failure)).toBe("succeeded");
    const card = await staff.req("GET", `/systems/${systemId}`);
    expect(card.body.system.stage).toBe("card");
    const ap = await staff.req("POST", `/systems/${systemId}/card/approve`, {
      body: { cardVersion: card.body.card.cardVersion },
    });
    expect(ap.status, ap.text).toBe(202);
    const build = await waitRun(
      staff,
      ap.body.run.id,
      ["succeeded", "failed", "cancelled", "needs_input"],
      240_000,
    );
    expect(build.status, JSON.stringify(build.failure)).toBe("succeeded");

    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["demo_scenario", "preview_revision", "stage"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    expect(sys).toMatchObject({ demo_scenario: "forum", stage: "ready" });
    expect(sys.preview_revision).not.toBeNull();
    const preview = await staff.req("GET", `/systems/${systemId}/preview-url`);
    expect(preview.status, preview.text).toBe(200);

    const rows = await calls(staffOrg);
    expect(rows.length).toBeGreaterThan(10);
    expect(new Set(rows.map((x) => x.mode))).toEqual(new Set(["fixture"]));
    expect(rows.reduce((s, x) => s + Number(x.cost_rub), 0)).toBe(0);
    expect(rows.reduce((s, x) => s + Number(x.credits_milli), 0)).toBe(0);
    expect(fetched).toEqual([]);
    const charged = await api.deps.db
      .selectFrom("platform.runs")
      .select(["kind", "credits_used_milli"])
      .where("system_id", "=", systemId)
      .execute();
    expect(charged.map((x) => Number(x.credits_used_milli))).toEqual(charged.map(() => 0));
  }, 300_000);

  test("a system with no recorded scenario: the run fails with DEMO_REPLAY_MISS and calls no model", async () => {
    const before = (await calls(staffOrg)).length;
    const sys = await api.deps.db
      .insertInto("platform.systems")
      .values({
        org_id: staffOrg,
        slug: `demo-${randomUUID().slice(0, 8)}`,
        schema_key: randomUUID().replace(/-/g, "").slice(0, 12),
        name: "Без записи",
        pending_questions: json([]),
        created_by: staff.userId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const m = await staff.req("POST", `/systems/${sys.id}/messages`, {
      body: { text: "Хочу CRM для салона" },
    });
    expect(m.status, m.text).toBe(202);
    const run = await waitRun(staff, m.body.run.id, ["succeeded", "failed"], 20_000);
    expect(run.status).toBe("failed");
    expect(run.failure).toMatchObject({ code: DEMO_REPLAY_MISS, message_ru: expect.stringMatching(MISS_RU) });
    expect((await calls(staffOrg)).length).toBe(before);
    expect(fetched).toEqual([]);
  });
});
