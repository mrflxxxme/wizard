// V3-06 (D77 (12)): /admin — the monthly share of «пока не умею» over the capability maps of briefs. Per system and month
// the last brief version of the month counts; months without briefs are zeros; staff with MFA reads it, staff without
// MFA gets 403, everybody else 404 (as the other /admin routes).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import { saveBriefVersion } from "../src/briefs/store.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { monthRange } from "../src/routes/admin-capability.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";
import { devLogin, type Session } from "./session.js";

const NOW = new Date(Date.UTC(2026, 9, 8, 12, 0));
let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let staff: Session;
let staffNoMfa: Session;
let client: Session;

beforeAll(async () => {
  tdb = await createTestDb("v3capability");
  api = await startApi(tdb.url, { executors: fakeExecutors(), now: () => NOW });
  client = await devLogin(api, "owner-capability@example.test");
  staff = await devLogin(api, "founder-capability@example.test");
  await setStaff(api.deps.db, "founder-capability@example.test", true);
  const en = await staff.req("POST", "/admin/mfa/enroll");
  await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
  staffNoMfa = await devLogin(api, "staff-nomfa-capability@example.test");
  await setStaff(api.deps.db, "staff-nomfa-capability@example.test", true);
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function system(): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `c-${key}`,
      schema_key: key,
      name: "Система",
      pending_questions: json([]),
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A brief version with `notYet` of `total` requirements «пока не умею», dated `at`. */
async function version(systemId: string, at: Date, total: number, notYet: number): Promise<void> {
  const capability = Array.from({ length: total }, (_, i) => ({
    requirement: `Требование ${i + 1} ${at.toISOString()}`,
    level: i < notYet ? "not_yet" : "modules",
  }));
  const saved = await saveBriefVersion(api.deps.db, {
    systemId,
    brief: { ...dentalBrief(), capability },
    author: "agent",
  });
  await api.deps.pg`update platform.system_briefs set created_at = ${at}
    where system_id = ${systemId} and version = ${saved.version.version}`;
}

describe("GET /admin/capability-share", () => {
  test("monthRange: the months up to now, oldest first, across the new year", () => {
    expect(monthRange(new Date(Date.UTC(2026, 1, 3)), 4)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  test("the last version of each system per month counts; months without briefs are zeros", async () => {
    const a = await system();
    const b = await system();
    // August: system a — 4 requirements, 1 «не умею»; October: a's later version replaces its earlier one.
    await version(a, new Date(Date.UTC(2026, 7, 10)), 4, 1);
    await version(a, new Date(Date.UTC(2026, 9, 1)), 4, 4);
    await version(a, new Date(Date.UTC(2026, 9, 5)), 5, 1);
    await version(b, new Date(Date.UTC(2026, 9, 6)), 5, 2);
    // Older than the window: not counted.
    await version(b, new Date(Date.UTC(2025, 0, 6)), 3, 3);

    const r = await staff.req("GET", "/admin/capability-share?months=3");
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body.months).toEqual([
      { month: "2026-08", briefs: 1, requirements: 4, notYet: 1, share: 0.25 },
      { month: "2026-09", briefs: 0, requirements: 0, notYet: 0, share: 0 },
      { month: "2026-10", briefs: 2, requirements: 10, notYet: 3, share: 0.3 },
    ]);
    const year = await staff.req("GET", "/admin/capability-share");
    expect(year.body.months).toHaveLength(12);
    expect(year.body.months.at(-1).month).toBe("2026-10");
  });

  test("staff without MFA gets 403, a client 404; months out of range 400", async () => {
    const noMfa = await staffNoMfa.req("GET", "/admin/capability-share");
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.code).toBe("MFA_REQUIRED");
    expect((await client.req("GET", "/admin/capability-share")).status).toBe(404);
    expect((await api.req("GET", "/admin/capability-share")).status).toBe(404);
    expect((await staff.req("GET", "/admin/capability-share?months=0")).status).toBe(400);
    expect((await staff.req("GET", "/admin/capability-share?months=37")).status).toBe(400);
  });
});
