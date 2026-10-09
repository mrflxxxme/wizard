// Acceptance M2-08 (security/abuse.yaml#report, #takedown; compliance.yaml#platform.security_org; D21_beta_moderation):
// «Пожаловаться» → ticket with sla_deadline +24 h → staff alert; /admin only for staff with TOTP (RFC 6238) verified in
// the session (non-staff 404, no MFA 403 MFA_REQUIRED, 12 h step-up, codes once, recovery codes, brute-force 429);
// triage → staff access to system data for 24 h with staff_audit_log and an owner letter (none for phishing);
// takedown → prod suspended (deployments.suspended → runtime 451) and the owner letter; restore → live again;
// founder review through the console (adminFounderReview) and the CLI functions; reporter e-mail retention; SLA alert.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkAbuseSla, purgeAbuseContacts } from "../src/abuse/reports.js";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode, totpStep } from "../src/auth/totp.js";
import type { OpsAlert } from "../src/ops/alert.js";
import { runHousekeeping } from "../src/privacy/housekeeping.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  type Res,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { devLogin, expectContract, MemoryMailer, ORIGIN, type Session } from "./session.js";

const OWNER = "dev@wizard.local";
const STAFF = "founder-abuse@example.test";
const STAFF2 = "second-staff@example.test";
const USER = "plain-user@example.test";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const mailer = new MemoryMailer();
const alerts: OpsAlert[] = [];
let systemId = "";
let slug = "";
let prodUrl = "";
let staff: Session;
let secret = "";
let recovery: string[] = [];
/** The code accepted at enrolment (replayed later). */
let enrollCode = "";

beforeAll(async () => {
  tdb = await createTestDb("abuse", { migrator: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    mailer,
    alert: async (a) => {
      alerts.push(a);
    },
    abuseSlaMs: 0,
    publish: {
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: { mode: "outbox", outboxDir: null },
    },
  });
  const b = await startBuild(api);
  systemId = b.systemId;
  expect((await waitRun(api, b.buildRunId, ["succeeded"], 20_000)).status).toBe("succeeded");
  const s0 = await sys();
  const put = await api.req("PUT", `/systems/${systemId}/compliance`, {
    body: {
      expectedVersion: s0.draft_revision,
      operatorName: "ООО «Форум»",
      operatorContact: "privacy@forum.example",
      operatorAddress: "г. Москва, ул. Тверская, д. 1",
    },
  });
  expect(put.status, put.text).toBe(200);
  const pub = await api.req("POST", `/systems/${systemId}/publish`, {
    body: { revision: put.body.revision.version, confirmDiff: true },
  });
  expect(pub.status, pub.text).toBe(202);
  expect((await waitRun(api, pub.body.run.id, ["succeeded", "failed"], 20_000)).status).toBe("succeeded");
  const s1 = await sys();
  slug = s1.slug;
  prodUrl = `http://${slug}.localhost:4100/`;
  await api.deps.pg.unsafe(
    `insert into "app_${s1.schema_key}_prod"."users" (role, display_name, email) values ('participant', 'Иван Петров', 'ivan@mail.example')`,
  );
  staff = await devLogin(api, STAFF);
  await setStaff(api.deps.db, STAFF, true);
}, 90_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

function sys() {
  return api.deps.db
    .selectFrom("platform.systems")
    .selectAll()
    .where("id", "=", systemId)
    .executeTakeFirstOrThrow();
}

const report = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  api.req("POST", "/abuse-reports", { body, headers: { origin: ORIGIN, ...headers } });

const audit = (action: string) =>
  api.deps.db.selectFrom("platform.staff_audit_log").selectAll().where("action", "=", action).execute();

async function prodSuspended(): Promise<boolean> {
  const [r] = await api.deps.pg`
    select suspended from platform.deployments where system_id = (select schema_key from platform.systems where id = ${systemId}) and env = 'prod'`;
  return r?.suspended === true;
}

let reportId = "";
let phishingId = "";

describe("«Пожаловаться»: public report → ticket", () => {
  test("without login: 202 reportId; sla_deadline = +24 h; system and live publication linked; staff alerted", async () => {
    const res = await report({
      url: `${prodUrl}tickets`,
      category: "fraud",
      text: "Просят перевести деньги на карту",
      contactEmail: "Reporter@Example.test",
      contactConsent: true,
    });
    expect(res.status, res.text).toBe(202);
    expectContract("createAbuseReport", res);
    expect(Object.keys(res.body)).toEqual(["reportId"]);
    reportId = res.body.reportId;
    const row = await api.deps.db
      .selectFrom("platform.abuse_reports")
      .selectAll()
      .where("id", "=", reportId)
      .executeTakeFirstOrThrow();
    expect(row.system_id).toBe(systemId);
    expect(row.publication_id).not.toBeNull();
    expect(row.status).toBe("new");
    expect(row.contact_email).toBe("reporter@example.test");
    expect(row.reporter_ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(row.sla_deadline).getTime() - new Date(row.created_at).getTime()).toBe(24 * 3600_000);
    const a = alerts.find((x) => x.event === "abuse_report_new");
    expect(a?.fields).toMatchObject({ kind: "abuse_report", code: "fraud", reason: reportId });
    expect(JSON.stringify(a)).not.toContain("reporter@example.test");
    expect(mailer.last(STAFF, "notice")?.text).toContain(`/admin?report=${reportId}`);
  });

  test("unknown system → 202 too (no status disclosure); foreign domain and e-mail without consent → 400", async () => {
    const unknown = await report({ url: "http://no-such-system.localhost:4100/", category: "spam" });
    expect(unknown.status).toBe(202);
    const row = await api.deps.db
      .selectFrom("platform.abuse_reports")
      .select("system_id")
      .where("id", "=", unknown.body.reportId)
      .executeTakeFirstOrThrow();
    expect(row.system_id).toBeNull();
    const foreign = await report({ url: "https://evil.example/login", category: "phishing" });
    expect(foreign.status).toBe(400);
    expectContract("createAbuseReport", foreign);
    const noConsent = await report({ url: prodUrl, category: "spam", contactEmail: "a@b.example" });
    expect(noConsent.status).toBe(400);
    expect((await report({ url: prodUrl, category: "bad" })).status).toBe(400);
  });

  test("phishing report on the same system", async () => {
    const res = await report({ url: prodUrl, category: "phishing", text: "Форма входа банка" });
    expect(res.status).toBe(202);
    phishingId = res.body.reportId;
    expect(alerts.find((x) => x.fields?.reason === phishingId)?.level).toBe("error");
  });
});

describe("/admin: staff only, with TOTP in the session", () => {
  test("non-staff → 404; dev header (no session) → 404; staff without MFA → 403 MFA_REQUIRED", async () => {
    const user = await devLogin(api, USER);
    for (const path of ["/admin/session", "/admin/abuse-reports", `/admin/abuse-reports/${reportId}`]) {
      const r = await user.req("GET", path);
      expect(r.status, path).toBe(404);
      expect(r.body.code).toBe("NOT_FOUND");
    }
    expect(
      (
        await user.req("POST", `/admin/abuse-reports/${reportId}/actions`, {
          body: { action: "takedown", note: "xxx" },
        })
      ).status,
    ).toBe(404);
    expect((await api.req("GET", "/admin/abuse-reports")).status).toBe(404);
    const st = await staff.req("GET", "/admin/session");
    expect(st.status).toBe(200);
    expectContract("adminSession", st);
    expect(st.body).toMatchObject({ isStaff: true, mfaEnrolled: false, mfaVerifiedUntil: null });
    const q = await staff.req("GET", "/admin/abuse-reports");
    expect(q.status).toBe(403);
    expect(q.body.code).toBe("MFA_REQUIRED");
    expectContract("adminListAbuseReports", q);
  });

  test("enrol: secret → wrong code 401 → right code → 10 recovery codes, session verified, secret stored as secret://", async () => {
    const en = await staff.req("POST", "/admin/mfa/enroll");
    expect(en.status, en.text).toBe(200);
    expectContract("adminMfaEnroll", en);
    secret = en.body.secret;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(en.body.otpauthUrl).toContain(`secret=${secret}`);
    const u = await api.deps.db
      .selectFrom("platform.users")
      .select(["totp_secret_ref", "mfa_enrolled_at"])
      .where("email", "=", STAFF)
      .executeTakeFirstOrThrow();
    expect(u.totp_secret_ref).toMatch(/^secret:\/\/platform\/staff\//);
    expect(u.mfa_enrolled_at).toBeNull();
    const code = totpCode(secret);
    const wrong = await staff.req("POST", "/admin/mfa/confirm", {
      body: { code: code === "000000" ? "111111" : "000000" },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("OTP_INVALID");
    enrollCode = code;
    const ok = await staff.req("POST", "/admin/mfa/confirm", { body: { code } });
    expect(ok.status, ok.text).toBe(200);
    expectContract("adminMfaConfirm", ok);
    recovery = ok.body.recoveryCodes;
    expect(recovery).toHaveLength(10);
    const stored = await api.deps.db
      .selectFrom("platform.users")
      .select("mfa_recovery_hashes")
      .where("email", "=", STAFF)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(stored.mfa_recovery_hashes)).not.toContain(recovery[0] as string);
    expect((await staff.req("POST", "/admin/mfa/enroll")).status).toBe(400);
    expect((await staff.req("GET", "/admin/abuse-reports")).status).toBe(200);
    expect((await audit("mfa_enrolled")).length).toBe(1);
  });

  test("a new session needs its own step-up; a TOTP code works once; recovery codes work once", async () => {
    const s2 = await devLogin(api, STAFF);
    expect((await s2.req("GET", "/admin/abuse-reports")).body.code).toBe("MFA_REQUIRED");
    // The code of the current step was used at enrolment: replay refused.
    const replay = await s2.req("POST", "/admin/mfa/verify", { body: { code: enrollCode } });
    expect(replay.status).toBe(401);
    // Pretend the last accepted step was long ago: the current code passes, then is refused again.
    await api.deps.db
      .updateTable("platform.users")
      .set({ totp_last_step: totpStep() - 10 })
      .where("email", "=", STAFF)
      .execute();
    const fresh = totpCode(secret);
    const v = await s2.req("POST", "/admin/mfa/verify", { body: { code: fresh } });
    expect(v.status, v.text).toBe(200);
    expectContract("adminMfaVerify", v);
    expect((await s2.req("GET", "/admin/abuse-reports")).status).toBe(200);
    const s3 = await devLogin(api, STAFF);
    expect((await s3.req("POST", "/admin/mfa/verify", { body: { code: fresh } })).status).toBe(401);
    const rc = await s3.req("POST", "/admin/mfa/verify", {
      body: { recoveryCode: (recovery[0] as string).toUpperCase() },
    });
    expect(rc.status, rc.text).toBe(200);
    expect((await s3.req("GET", "/admin/abuse-reports")).status).toBe(200);
    const s4 = await devLogin(api, STAFF);
    expect((await s4.req("POST", "/admin/mfa/verify", { body: { recoveryCode: recovery[0] } })).status).toBe(
      401,
    );
    expect((await audit("mfa_recovery_used")).length).toBe(1);
  });

  test("the step-up expires after 12 h", async () => {
    const s5 = await devLogin(api, STAFF);
    await s5.req("POST", "/admin/mfa/verify", { body: { recoveryCode: recovery[1] } });
    expect((await s5.req("GET", "/admin/abuse-reports")).status).toBe(200);
    await api.deps.pg`
      update platform.sessions set mfa_verified_at = now() - interval '12 hours 1 minute'
      where user_id = (select id from platform.users where email = ${STAFF}) and mfa_verified_at is not null`;
    expect((await s5.req("GET", "/admin/abuse-reports")).body.code).toBe("MFA_REQUIRED");
    expect((await staff.req("GET", "/admin/abuse-reports")).body.code).toBe("MFA_REQUIRED");
    const again = await staff.req("POST", "/admin/mfa/verify", { body: { recoveryCode: recovery[2] } });
    expect(again.status).toBe(200);
  });

  test("5 wrong codes in 15 min → 429", async () => {
    const s = await devLogin(api, STAFF2);
    await setStaff(api.deps.db, STAFF2, true);
    const en = await s.req("POST", "/admin/mfa/enroll");
    const good = totpCode(en.body.secret);
    const bad = good === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++)
      expect((await s.req("POST", "/admin/mfa/confirm", { body: { code: bad } })).status).toBe(401);
    const locked = await s.req("POST", "/admin/mfa/confirm", { body: { code: good } });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("RATE_LIMITED");
  });
});

describe("ticket → staff access → takedown → owner notice → restore", () => {
  test("queue by sla_deadline; ticket view is journaled", async () => {
    const q = await staff.req("GET", "/admin/abuse-reports");
    expectContract("adminListAbuseReports", q);
    const open = q.body.items.filter((i: { status: string }) => i.status === "new");
    const deadlines = open.map((i: { slaDeadline: string }) => i.slaDeadline);
    expect(deadlines).toEqual([...deadlines].sort());
    expect(open.find((i: { id: string }) => i.id === reportId)?.systemName).toBeTruthy();
    const t = await staff.req("GET", `/admin/abuse-reports/${reportId}`);
    expect(t.status).toBe(200);
    expectContract("adminGetAbuseReport", t);
    expect(t.body).toMatchObject({ id: reportId, contactEmail: "reporter@example.test", access: null });
    expect(t.body.system).toMatchObject({ id: systemId, prodUrl, suspended: false });
    expect((await audit("abuse_view")).some((r) => r.target === `abuse_report:${reportId}`)).toBe(true);
    expect((await staff.req("GET", "/admin/abuse-reports/00000000-0000-4000-8000-000000000000")).status).toBe(
      404,
    );
  });

  test("system data only by an open ticket: 403 before triage; triage opens 24 h, owner notified, PII columns left out", async () => {
    const before = await staff.req("GET", `/admin/abuse-reports/${reportId}/data`);
    expect(before.status).toBe(403);
    expectContract("adminSystemData", before);
    const ownerLetters = mailer.sent.filter((m) => m.to === OWNER).length;
    const tr = await staff.req("POST", `/admin/abuse-reports/${reportId}/actions`, {
      body: { action: "triage", note: "Проверяю систему по жалобе" },
    });
    expect(tr.status, tr.text).toBe(200);
    expectContract("adminAbuseAction", tr);
    expect(tr.body.status).toBe("triaged");
    const letters = mailer.sent.filter((m) => m.to === OWNER);
    expect(letters.length).toBe(ownerLetters + 1);
    expect(letters.at(-1)?.subject).toContain("Доступ к данным системы");
    const data = await staff.req("GET", `/admin/abuse-reports/${reportId}/data?entity=users`);
    expect(data.status, data.text).toBe(200);
    expectContract("adminSystemData", data);
    expect(data.body.env).toBe("prod");
    expect(data.body.entity).toBe("users");
    // The registered user and the owner (first isAdmin role at publication, runtime.yaml#auth.role_assignment (в)).
    expect(data.body.entities.find((e: { name: string }) => e.name === "users")?.rows).toBe(2);
    expect(data.body.columns).not.toContain("email");
    expect(data.body.columns).not.toContain("display_name");
    expect(JSON.stringify(data.body.rows)).not.toContain("ivan@mail.example");
    expect(data.body.omittedPii).toBeGreaterThan(0);
    const reads = await audit("staff_data_read");
    expect(reads.at(-1)).toMatchObject({ target: `system:${systemId}` });
    expect(reads.at(-1)?.note).toContain(`abuse_report:${reportId}`);
  });

  test("staff access TTL is 24 h; reopening is journaled and notifies the owner again", async () => {
    await api.deps.pg`
      update platform.staff_audit_log set created_at = now() - interval '24 hours 1 minute'
      where action = 'staff_access_open' and target = ${`abuse_report:${reportId}`}`;
    expect((await staff.req("GET", `/admin/abuse-reports/${reportId}/data`)).status).toBe(403);
    expect((await staff.req("GET", `/admin/abuse-reports/${reportId}`)).body.access).toBeNull();
    const n = mailer.sent.filter((m) => m.to === OWNER).length;
    const re = await staff.req("POST", `/admin/abuse-reports/${reportId}/access`, {
      body: { note: "Нужна повторная проверка" },
    });
    expect(re.status, re.text).toBe(200);
    expectContract("adminOpenStaffAccess", re);
    expect(new Date(re.body.until).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(mailer.sent.filter((m) => m.to === OWNER).length).toBe(n + 1);
    expect((await staff.req("GET", `/admin/abuse-reports/${reportId}/data`)).status).toBe(200);
  });

  test("phishing: triage without an owner letter", async () => {
    const n = mailer.sent.filter((m) => m.to === OWNER).length;
    const tr = await staff.req("POST", `/admin/abuse-reports/${phishingId}/actions`, {
      body: { action: "triage", note: "Расследование фишинга" },
    });
    expect(tr.status).toBe(200);
    expect(mailer.sent.filter((m) => m.to === OWNER).length).toBe(n);
    expect((await staff.req("GET", `/admin/abuse-reports/${phishingId}/data`)).status).toBe(200);
  });

  test("takedown: publication suspended, deployments.suspended, owner letter with the reason, reporter letter", async () => {
    expect(await prodSuspended()).toBe(false);
    const bad = await staff.req("POST", `/admin/abuse-reports/${reportId}/actions`, {
      body: { action: "restore", note: "рано" },
    });
    expect(bad.status).toBe(400);
    const td = await staff.req("POST", `/admin/abuse-reports/${reportId}/actions`, {
      body: { action: "takedown", note: "Подтверждено: сбор переводов на карту" },
    });
    expect(td.status, td.text).toBe(200);
    expectContract("adminAbuseAction", td);
    expect(td.body).toMatchObject({ status: "takedown" });
    expect(td.body.resolvedAt).toBeTruthy();
    const pubs = await api.deps.db
      .selectFrom("platform.publications")
      .select(["status", "suspended_reason"])
      .where("system_id", "=", systemId)
      .execute();
    expect(pubs.filter((p) => p.status === "suspended")).toEqual([
      { status: "suspended", suspended_reason: "fraud" },
    ]);
    expect(pubs.some((p) => p.status === "live")).toBe(false);
    expect((await sys()).suspended_at).not.toBeNull();
    expect(await prodSuspended()).toBe(true);
    const letter = mailer.last(OWNER, "notice");
    expect(letter?.subject).toContain("временно недоступна по жалобе");
    expect(letter?.text).toContain("Причина: мошенничество");
    expect(letter?.text).toContain("ответьте на это письмо");
    expect(letter?.text).not.toContain("Подтверждено: сбор");
    expect(mailer.last("reporter@example.test", "notice")?.subject).toBe("Ваша жалоба рассмотрена");
    const g = await api.req("GET", `/systems/${systemId}`);
    expect(g.body.publishBlockers).toContain("SYSTEM_SUSPENDED");
  });

  test("restore: another takedown ticket keeps the system down; the last restore brings prod back live", async () => {
    const td = await staff.req("POST", `/admin/abuse-reports/${phishingId}/actions`, {
      body: { action: "takedown", note: "Фишинговая форма подтверждена" },
    });
    expect(td.status).toBe(200);
    const r1 = await staff.req("POST", `/admin/abuse-reports/${phishingId}/actions`, {
      body: { action: "restore", note: "Владелец убрал форму" },
    });
    expect(r1.body.status).toBe("restored");
    expect(await prodSuspended()).toBe(true);
    const r2 = await staff.req("POST", `/admin/abuse-reports/${reportId}/actions`, {
      body: { action: "restore", note: "Апелляция владельца принята" },
    });
    expect(r2.status).toBe(200);
    expect(await prodSuspended()).toBe(false);
    expect((await sys()).suspended_at).toBeNull();
    const live = await api.deps.db
      .selectFrom("platform.publications")
      .select("status")
      .where("system_id", "=", systemId)
      .where("status", "=", "live")
      .execute();
    expect(live).toHaveLength(1);
    expect(mailer.last(OWNER, "notice")?.subject).toContain("снова доступна");
    // A closed ticket gives no data access.
    expect((await staff.req("GET", `/admin/abuse-reports/${reportId}/data`)).status).toBe(403);
    const actions = (await api.deps.db.selectFrom("platform.staff_audit_log").select("action").execute()).map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(["abuse_triage", "abuse_takedown", "abuse_restore", "staff_access_open"]),
    );
  });

  test("dismiss closes a ticket", async () => {
    const r = await report({ url: prodUrl, category: "spam" });
    const d = await staff.req("POST", `/admin/abuse-reports/${r.body.reportId}/actions`, {
      body: { action: "dismiss", note: "Нарушения нет" },
    });
    expect(d.body.status).toBe("dismissed");
    expect(await prodSuspended()).toBe(false);
  });
});

describe("founder reviews and org flags in the console", () => {
  test("queue → reject needs a note → approve; journaled", async () => {
    const rev = (await sys()).draft_revision;
    await api.deps.db
      .insertInto("platform.founder_reviews")
      .values({ system_id: systemId, revision: rev, status: "pending" })
      .execute();
    const q = await staff.req("GET", "/admin/founder-reviews");
    expect(q.status).toBe(200);
    expectContract("adminListFounderReviews", q);
    expect(q.body.items).toEqual([expect.objectContaining({ systemId, revision: rev })]);
    // D75: a look at the draft before the decision, journaled; only a system with a pending review.
    const pv = await staff.req("POST", `/admin/systems/${systemId}/founder-review/preview`);
    expect(pv.status, pv.text).toBe(200);
    expectContract("adminFounderReviewPreview", pv);
    expect(pv.body.reviewRevision).toBe(rev);
    expect(pv.body.url).toMatch(/\/_wizard\/(dev-logout|dev-login|preview-login)/);
    expect((await audit("founder_review_preview")).length).toBe(1);
    const noNote = await staff.req("POST", `/admin/systems/${systemId}/founder-review`, {
      body: { revision: rev, decision: "reject" },
    });
    expect(noNote.status).toBe(400);
    const ok = await staff.req("POST", `/admin/systems/${systemId}/founder-review`, {
      body: { revision: rev, decision: "approve", note: "Проверено" },
    });
    expect(ok.status, ok.text).toBe(200);
    expectContract("adminFounderReview", ok);
    const row = await api.deps.db
      .selectFrom("platform.founder_reviews")
      .selectAll()
      .where("system_id", "=", systemId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("approved");
    expect(row.reviewer).toBe(staff.userId);
    expect((await staff.req("POST", `/admin/systems/${systemId}/founder-review/preview`)).status).toBe(404);
    expect((await audit("founder_review_approve")).length).toBe(1);
    expect(
      (
        await staff.req("POST", `/admin/systems/${systemId}/founder-review`, {
          body: { revision: 999, decision: "approve" },
        })
      ).status,
    ).toBe(404);
  });

  test("org flags", async () => {
    const orgId = (await sys()).org_id;
    const r = await staff.req("PUT", `/admin/orgs/${orgId}/flags`, { body: { requireFounderReview: false } });
    expect(r.status).toBe(200);
    expect(r.body.requireFounderReview).toBe(false);
    expect((await audit("org_flags")).length).toBe(1);
  });
});

describe("retention, SLA alert and limits", () => {
  test("reporter e-mail removed one year after closing (housekeeping)", async () => {
    await api.deps
      .pg`update platform.abuse_reports set resolved_at = now() - interval '366 days' where id = ${reportId}`;
    const now = new Date();
    const h = await runHousekeeping(api.deps.db, now);
    expect(h.abuseContacts).toBe(1);
    const row = await api.deps.db
      .selectFrom("platform.abuse_reports")
      .select("contact_email")
      .where("id", "=", reportId)
      .executeTakeFirstOrThrow();
    expect(row.contact_email).toBeNull();
    expect(await purgeAbuseContacts(api.deps.db, now)).toBe(0);
  });

  test("< 2 h to the SLA → one alert per report", async () => {
    const r = await report({ url: prodUrl, category: "illegal_content" });
    await api.deps
      .pg`update platform.abuse_reports set sla_deadline = now() + interval '90 minutes' where id = ${r.body.reportId}`;
    const got: OpsAlert[] = [];
    const sink = async (a: OpsAlert) => {
      got.push(a);
    };
    expect(await checkAbuseSla({ db: api.deps.db, alert: sink })).toBe(1);
    expect(await checkAbuseSla({ db: api.deps.db, alert: sink })).toBe(0);
    expect(got[0]).toMatchObject({ level: "error", event: "abuse_sla_at_risk" });
  });

  test("10 reports an hour per IP → 429", async () => {
    await api.deps.pg`update platform.abuse_reports set created_at = now() - interval '2 hours'`;
    const results: Res[] = [];
    for (let i = 0; i < 11; i++) results.push(await report({ url: prodUrl, category: "spam" }));
    expect(results.slice(0, 10).every((r) => r.status === 202)).toBe(true);
    const last = results[10] as Res;
    expect(last.status).toBe(429);
    expectContract("createAbuseReport", last);
  });
});
