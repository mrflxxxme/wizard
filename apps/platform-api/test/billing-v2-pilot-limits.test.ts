// D70 pilot limit (M2-34 mvp_scope): 5 builds and 20 edits in a rolling 30 days per pilot org; GET /orgs/:id/usage
// shows what is left without credits; the 6th build → 402 BUILDS_LIMIT with «Написать команде» text; the founder raises
// the limit in /admin (staff_audit_log); failed and cancelled runs do not count; non-pilot and exempt orgs are free of it.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import { assertPilotLimit, PILOT_WINDOW_DAYS, pilotUsage } from "../src/billing/pilot-limits.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import { ApiError } from "../src/errors.js";
import { grantPilotCredits } from "../src/pilot/service.js";
import { toCard } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { devLogin, expectContract, type Session } from "./session.js";

const DAY = 86_400_000;

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let client: Session;
let staff: Session;
let orgId = "";

beforeAll(async () => {
  tdb = await createTestDb("pilotlim");
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    abuseSlaMs: 0,
  });
  client = await devLogin(api, "owner@bakery.example");
  orgId = (await client.req("GET", "/me")).body.memberships[0].orgId;
  await api.deps.db.updateTable("platform.orgs").set({ plan: "pilot" }).where("id", "=", orgId).execute();
  await grantPilotCredits(api.deps.db, api.deps.billing, { orgId, credits: 5000, reference: "test" });
  staff = await devLogin(api, "founder-limits@example.test");
  await setStaff(api.deps.db, "founder-limits@example.test", true);
  const en = await staff.req("POST", "/admin/mfa/enroll");
  await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

/** Past build runs of the org (no system needed for the count). */
async function seedRuns(org: string, mode: string, n: number, o: { status?: string; at?: Date } = {}) {
  for (let i = 0; i < n; i++)
    await api.deps.db
      .insertInto("platform.runs")
      .values({
        id: randomUUID(),
        org_id: org,
        system_id: null,
        kind: "build",
        mode,
        status: o.status ?? "succeeded",
        input: JSON.stringify({}) as never,
        created_at: o.at ?? new Date(Date.now() - (i + 1) * 60_000),
      })
      .execute();
}

const asClient = () => ({ ...api, req: client.req }) as TestApi;

describe("pilot limit: builds", () => {
  test("usage starts at 5 builds and 20 edits left, without credits", async () => {
    const r = await client.req("GET", `/orgs/${orgId}/usage`);
    expectContract("getOrgUsage", r);
    expect(r.body).toEqual({
      pilot: true,
      free: true,
      builds: { limit: 5, used: 0, left: 5, nextAt: null },
      edits: { limit: 20, used: 0, left: 20, nextAt: null },
    });
    expect(r.text).not.toMatch(/credit|cap|costRub/i);
  });

  test("failed, cancelled and fix runs and runs older than 30 days do not count", async () => {
    await seedRuns(orgId, "create", 2, { status: "failed" });
    await seedRuns(orgId, "create", 1, { status: "cancelled" });
    await seedRuns(orgId, "fix", 3);
    await seedRuns(orgId, "create", 1, { at: new Date(Date.now() - (PILOT_WINDOW_DAYS + 1) * DAY) });
    const u = await pilotUsage(api.deps.db, orgId, new Date());
    expect(u.builds.used).toBe(0);
  });

  test("the 6th build in 30 days → 402 BUILDS_LIMIT with a date and «напишите команде»; the founder raises the limit", async () => {
    await seedRuns(orgId, "create", 5);
    const left = await client.req("GET", `/orgs/${orgId}/usage`);
    expect(left.body.builds).toMatchObject({ limit: 5, used: 5, left: 0 });
    expect(left.body.builds.nextAt).not.toBeNull();
    const c = await toCard(asClient());
    const refused = await client.req("POST", `/systems/${c.systemId}/card/approve`, {
      body: { cardVersion: c.cardVersion },
    });
    expect(refused.status).toBe(402);
    expectContract("approveCard", refused);
    expect(refused.body.code).toBe("BUILDS_LIMIT");
    expect(refused.body.message_ru).toMatch(/^На пилоте можно запустить 5 сборок за 30 дней/);
    expect(refused.body.message_ru).toContain("напишите команде");
    expect(refused.body.message_ru).not.toMatch(/кредит/i);
    expect(refused.body.details).toMatchObject({ limit: 5, used: 5 });

    const raise = await staff.req("PUT", `/admin/pilot/orgs/${orgId}/limits`, { body: { builds: 6 } });
    expect(raise.status, raise.text).toBe(200);
    expectContract("adminSetPilotLimits", raise);
    expect(raise.body).toMatchObject({ orgId, builds: 6, edits: 20 });
    expect(raise.body.usage.builds.left).toBe(1);
    const [row] = await api.deps.db
      .selectFrom("platform.staff_audit_log")
      .selectAll()
      .where("action", "=", "pilot_limits")
      .execute();
    expect(row?.target).toBe(`org:${orgId}`);

    const ok = await client.req("POST", `/systems/${c.systemId}/card/approve`, {
      body: { cardVersion: c.cardVersion },
    });
    expect(ok.status, ok.text).toBe(202);
    const done = await waitRun(asClient(), ok.body.run.id, ["succeeded", "failed"]);
    expect(done.status, JSON.stringify(done)).toBe("succeeded");
    expect((await client.req("GET", `/orgs/${orgId}/usage`)).body.builds).toMatchObject({ used: 6, left: 0 });

    const orgs = await staff.req("GET", "/admin/pilot/orgs");
    expectContract("adminListPilotOrgs", orgs);
    const mine = orgs.body.items.find((x: { id: string }) => x.id === orgId);
    expect(mine.usage.builds).toMatchObject({ limit: 6, used: 6 });
  });

  test("non-staff cannot change limits (404); bad values → 400; null puts the default back", async () => {
    expect(
      (await client.req("PUT", `/admin/pilot/orgs/${orgId}/limits`, { body: { builds: 99 } })).status,
    ).toBe(404);
    expect(
      (await staff.req("PUT", `/admin/pilot/orgs/${orgId}/limits`, { body: { builds: -1 } })).status,
    ).toBe(400);
    const back = await staff.req("PUT", `/admin/pilot/orgs/${orgId}/limits`, { body: { builds: null } });
    expect(back.body.builds).toBe(5);
  });
});

describe("pilot limit: edits and who is limited", () => {
  test("the 21st edit (change or point_edit) → EDITS_LIMIT; builds are counted apart", async () => {
    await seedRuns(orgId, "change", 15);
    await seedRuns(orgId, "point_edit", 5);
    const err = await api.deps.db
      .transaction()
      .execute((trx) => assertPilotLimit(trx, { orgId, mode: "change", now: new Date() }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("EDITS_LIMIT");
    expect((err as ApiError).message_ru).toMatch(/^На пилоте можно сделать 20 правок за 30 дней/);
    // fix runs are never limited.
    await api.deps.db
      .transaction()
      .execute((trx) => assertPilotLimit(trx, { orgId, mode: "fix", now: new Date() }));
  });

  test("a non-pilot org has no limit; the window slides: the oldest counted run frees a slot after 30 days", async () => {
    const other = await devLogin(api, "free-plan@example.test");
    const otherOrg = (await other.req("GET", "/me")).body.memberships[0].orgId;
    await seedRuns(otherOrg, "create", 7);
    const r = await other.req("GET", `/orgs/${otherOrg}/usage`);
    expect(r.body).toMatchObject({ pilot: false, free: false, builds: { limit: null, used: 7, left: null } });
    await api.deps.db
      .transaction()
      .execute((trx) => assertPilotLimit(trx, { orgId: otherOrg, mode: "create", now: new Date() }));

    await api.deps.db
      .updateTable("platform.orgs")
      .set({ plan: "pilot" })
      .where("id", "=", otherOrg)
      .execute();
    const u = await pilotUsage(api.deps.db, otherOrg, new Date());
    expect(u.builds.left).toBe(0);
    const oldest = await api.deps.db
      .selectFrom("platform.runs")
      .select("created_at")
      .where("org_id", "=", otherOrg)
      .orderBy("created_at")
      .offset(2)
      .limit(1)
      .executeTakeFirstOrThrow();
    // 7 used of 5: the 3rd oldest leaves the window first for a slot to free up.
    expect(u.builds.nextAt?.getTime()).toBe(new Date(oldest.created_at).getTime() + PILOT_WINDOW_DAYS * DAY);
  });

  test("another org's usage → 404; the exempt local org of the dev stand is not limited", async () => {
    const stranger = await devLogin(api, "stranger@example.test");
    expect((await stranger.req("GET", `/orgs/${orgId}/usage`)).status).toBe(404);
    await seedRuns(DEFAULT_ORG_ID, "create", 6);
    const c = await toCard(api);
    const ap = await api.req("POST", `/systems/${c.systemId}/card/approve`, {
      body: { cardVersion: c.cardVersion },
    });
    expect(ap.status, ap.text).toBe(202);
    await waitRun(api, ap.body.run.id, ["succeeded"]);
  });
});
