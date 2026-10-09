// V3-18: /admin «Системы и сбои» — every system with its org, stage, published revision, the last build and the spend;
// failed runs with the code, the client's Russian text and the cost. Staff with MFA reads them, staff without MFA gets
// 403, everybody else 404 (as the other /admin routes).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import { DEFAULT_ORG_ID, DEV_USER_ID, json } from "../src/db/index.js";
import { createTestDb, fakeExecutors, startApi, type TestApi } from "./helpers.js";
import { devLogin, expectContract, type Session } from "./session.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let staff: Session;
let staffNoMfa: Session;
let client: Session;

beforeAll(async () => {
  tdb = await createTestDb("v3adminsystems");
  api = await startApi(tdb.url, { executors: fakeExecutors() });
  client = await devLogin(api, "owner-systems@example.test");
  staff = await devLogin(api, "founder-systems@example.test");
  await setStaff(api.deps.db, "founder-systems@example.test", true);
  const en = await staff.req("POST", "/admin/mfa/enroll");
  await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
  staffNoMfa = await devLogin(api, "staff-nomfa-systems@example.test");
  await setStaff(api.deps.db, "staff-nomfa-systems@example.test", true);
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

async function system(name: string, prod: number | null): Promise<string> {
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const row = await api.deps.db
    .insertInto("platform.systems")
    .values({
      org_id: DEFAULT_ORG_ID,
      slug: `s-${key}`,
      schema_key: key,
      name,
      pending_questions: json([]),
      created_by: DEV_USER_ID,
      prod_revision: prod,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function run(
  systemId: string,
  o: { kind?: string; status: string; code?: string; message?: string; credits?: number; at: Date },
): Promise<string> {
  const row = await api.deps.db
    .insertInto("platform.runs")
    .values({
      org_id: DEFAULT_ORG_ID,
      system_id: systemId,
      kind: o.kind ?? "build",
      status: o.status,
      input: json({}),
      failure_code: o.code ?? null,
      failure_message_ru: o.message ?? null,
      credits_used_milli: (o.credits ?? 0) * 1000,
      created_at: o.at,
      finished_at: o.at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function spend(systemId: string, runId: string | null, rub: number): Promise<void> {
  await api.deps.pg`
    insert into platform.llm_calls (org_id, system_id, run_id, call_type, tier, provider, model_id, status,
      route_reason, policy_version, scrubbed, cost_rub, billable, mode)
    values (${DEFAULT_ORG_ID}, ${systemId}, ${runId}, 'orchestrate', 'T0', 'cloudru', 'glm-5.1', 'ok', 'default_T0',
      'test', false, ${rub}, true, 'live')`;
}

describe("GET /admin/systems and /admin/runs", () => {
  test("systems: org, stage, published revision, the last build and the spend", async () => {
    const a = await system("Стоматология", 3);
    const b = await system("Кофейня", null);
    const ok = await run(a, { status: "succeeded", credits: 2, at: new Date(Date.UTC(2026, 9, 1)) });
    const bad = await run(a, {
      status: "failed",
      code: "G1_FAILED",
      message: "Проверка сценариев не прошла",
      credits: 1.5,
      at: new Date(Date.UTC(2026, 9, 2)),
    });
    await spend(a, ok, 10.25);
    await spend(a, bad, 4.5);

    const r = await staff.req("GET", "/admin/systems");
    expect(r.status, r.text).toBe(200);
    expectContract("adminListSystems", r);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const sa = r.body.items.find((x: { id: string }) => x.id === a);
    expect(sa).toMatchObject({
      name: "Стоматология",
      org: { id: DEFAULT_ORG_ID },
      stage: "interview",
      publishedRevision: 3,
      lastBuild: { status: "failed", failureCode: "G1_FAILED", at: "2026-10-02T00:00:00.000Z" },
      modelSpendRub: 14.75,
      creditsUsed: 3.5,
    });
    const sb = r.body.items.find((x: { id: string }) => x.id === b);
    expect(sb).toMatchObject({ publishedRevision: null, lastBuild: null, modelSpendRub: 0, creditsUsed: 0 });

    const f = await staff.req("GET", "/admin/runs?status=failed");
    expect(f.status, f.text).toBe(200);
    expectContract("adminListRuns", f);
    const ids = f.body.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(bad);
    expect(ids).not.toContain(ok);
    expect(f.body.items.find((x: { id: string }) => x.id === bad)).toMatchObject({
      system: { id: a, name: "Стоматология" },
      org: { id: DEFAULT_ORG_ID },
      kind: "build",
      status: "failed",
      errorCode: "G1_FAILED",
      messageRu: "Проверка сценариев не прошла",
      modelSpendRub: 4.5,
      creditsUsed: 1.5,
      finishedAt: "2026-10-02T00:00:00.000Z",
    });
    // The default status is failed; other statuses and kinds on request.
    const dflt = await staff.req("GET", "/admin/runs");
    expect(dflt.body.items.map((x: { id: string }) => x.id)).toContain(bad);
    const done = await staff.req("GET", "/admin/runs?status=succeeded&kind=build");
    expect(done.body.items.map((x: { id: string }) => x.id)).toContain(ok);
    const pub = await staff.req("GET", "/admin/runs?status=failed&kind=publish");
    expect(pub.body.items.map((x: { id: string }) => x.id)).not.toContain(bad);
  });

  test("staff without MFA gets 403, a client and a guest 404; bad params 400", async () => {
    for (const path of ["/admin/systems", "/admin/runs"]) {
      const noMfa = await staffNoMfa.req("GET", path);
      expect(noMfa.status).toBe(403);
      expect(noMfa.body.code).toBe("MFA_REQUIRED");
      expect((await client.req("GET", path)).status).toBe(404);
      expect((await api.req("GET", path)).status).toBe(404);
    }
    expect((await staff.req("GET", "/admin/runs?status=broken")).status).toBe(400);
    expect((await staff.req("GET", "/admin/systems?limit=0")).status).toBe(400);
    expect((await staff.req("GET", "/admin/runs?kind=DROP%20TABLE")).status).toBe(400);
  });
});
