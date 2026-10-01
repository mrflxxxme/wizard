// Cleanup after M2-08/M2-09 (docs/reviews/impl-notes/cleanup-2026-10-01.md): the owner learns the founder's review
// decision by mail (approved / rejected with the note); org-wide suspension (abuse.yaml#takedown.flow: orgs.suspended_at
// → every system of the org 451 via deployments, publish 403 ORG_SUSPENDED, admin action journaled, owner letters);
// the automatic takedown (abuse.yaml#takedown.auto_suspend: ≥ 3 phishing reports from different IPs in 1 h AND the live
// revision fails the current G2 antifraud); the owner's «Оспорить» of a G2 antifraud stop (ticket auto_g2, answer by
// mail); one dedup path for founder alerts (ops/alert.ts alertOnce over db.yaml#ops_alerts).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { checkAutoSuspend } from "../src/abuse/escalation.js";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import { alertOnce, claimOpsAlert, type OpsAlert } from "../src/ops/alert.js";
import { opsAlertsSent } from "../src/ops/registry.js";
import { abuseContext, decideFounderReview, requestFounderReview } from "../src/publish/moderation.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { devLogin, expectContract, MemoryMailer, ORIGIN, type Session } from "./session.js";

const OWNER = "dev@wizard.local";
const STAFF = "escalation-staff@example.test";
const EDITOR = "escalation-editor@example.test";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const mailer = new MemoryMailer();
const alerts: OpsAlert[] = [];
let systemId = "";
let orgId = "";
let prodUrl = "";
let prodRevision = 0;
let staff: Session;

beforeAll(async () => {
  tdb = await createTestDb("abuse_esc", { migrator: true });
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
  orgId = s1.org_id;
  prodRevision = s1.prod_revision as number;
  prodUrl = `http://${s1.slug}.localhost:4100/`;
  staff = await devLogin(api, STAFF);
  await setStaff(api.deps.db, STAFF, true);
  const en = await staff.req("POST", "/admin/mfa/enroll");
  expect(en.status, en.text).toBe(200);
  const ok = await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
  expect(ok.status, ok.text).toBe(200);
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

async function deployments(): Promise<{ env: string; suspended: boolean }[]> {
  return api.deps.pg<{ env: string; suspended: boolean }[]>`
    select env, suspended from platform.deployments
    where system_id = (select schema_key from platform.systems where id = ${systemId}) order by env`;
}

const report = (body: Record<string, unknown>) =>
  api.req("POST", "/abuse-reports", { body, headers: { origin: ORIGIN } });

describe("founder review decision → letter to the owner", () => {
  test("approve and reject (console) mail every owner in Russian; the note is the «что исправить»", async () => {
    await requestFounderReview(api.deps.db, systemId, prodRevision);
    const ap = await staff.req("POST", `/admin/systems/${systemId}/founder-review`, {
      body: { revision: prodRevision, decision: "approve" },
    });
    expect(ap.status, ap.text).toBe(200);
    const yes = mailer.last(OWNER, "notice");
    expect(yes?.subject).toMatch(/^Система «.+» одобрена к публикации$/);
    expect(yes?.text).toContain(`ревизию ${prodRevision}`);
    expect(yes?.text).toContain(`/s/${systemId}`);

    await requestFounderReview(api.deps.db, systemId, prodRevision + 100);
    const rj = await staff.req("POST", `/admin/systems/${systemId}/founder-review`, {
      body: { revision: prodRevision + 100, decision: "reject", note: "Уберите поле с номером карты" },
    });
    expect(rj.status, rj.text).toBe(200);
    const no = mailer.last(OWNER, "notice");
    expect(no?.subject).toMatch(/^Публикация системы «.+» не одобрена$/);
    expect(no?.text).toContain("Что исправить: Уберите поле с номером карты");
    expect(no?.text).toContain("ответьте на это письмо");
  });

  test("decideFounderReview without a notice (e2e helpers) sends nothing; unknown revision sends nothing", async () => {
    await requestFounderReview(api.deps.db, systemId, prodRevision + 200);
    const n = mailer.sent.length;
    expect(
      await decideFounderReview(api.deps.db, {
        systemId,
        revision: prodRevision + 200,
        decision: "approve",
      }),
    ).toBe(true);
    expect(
      await decideFounderReview(
        api.deps.db,
        { systemId, revision: 99_999, decision: "approve" },
        { mailer, platformOrigin: "http://localhost:5173" },
      ),
    ).toBe(false);
    expect(mailer.sent.length).toBe(n);
  });
});

describe("«Оспорить» a G2 antifraud stop", () => {
  let disputeId = "";

  test("only an owner, only a G2-AF blocker of that revision; one open ticket; staff alerted", async () => {
    const s = await sys();
    const rev = s.preview_revision as number;
    const run = await api.deps.db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", systemId)
      .where("kind", "=", "publish")
      .executeTakeFirstOrThrow();
    const before = await api.req("POST", `/systems/${systemId}/disputes`, { body: { revision: rev } });
    expect(before.status).toBe(400);
    expectContract("disputeG2Block", before);
    await api.deps.pg`
      insert into platform.gate_reports (run_id, system_id, revision, level, passed, report)
      values (${run.id}, ${systemId}, ${rev}, 'G2', false, ${api.deps.pg.json({
        level: "G2",
        passed: false,
        checks: [
          { id: "G2-AF-01", severity: "blocker", status: "fail", message_ru: "Публикация приостановлена" },
          { id: "G2-PII-01", severity: "blocker", status: "pass", message_ru: "ok" },
        ],
      })})`;
    const editor = await devLogin(api, EDITOR);
    await api.deps.pg`
      insert into platform.memberships (org_id, user_id, role)
      select ${orgId}, id, 'editor' from platform.users where email = ${EDITOR}
      on conflict do nothing`;
    const denied = await editor.req("POST", `/systems/${systemId}/disputes`, { body: { revision: rev } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("NOT_OWNER");
    const res = await api.req("POST", `/systems/${systemId}/disputes`, {
      body: { revision: rev, text: "Это поле промокода, а не карты" },
    });
    expect(res.status, res.text).toBe(202);
    expectContract("disputeG2Block", res);
    expect(res.body.message_ru).toBe(
      "Заявка на проверку отправлена. Ответим на почту владельца в течение 24 часов.",
    );
    disputeId = res.body.reportId;
    const row = await api.deps.db
      .selectFrom("platform.abuse_reports")
      .selectAll()
      .where("id", "=", disputeId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      category: "auto_g2",
      system_id: systemId,
      status: "new",
      reporter_ip_hash: null,
    });
    expect(row.text).toContain("G2-AF-01");
    expect(row.text).toContain("Это поле промокода");
    expect(new Date(row.sla_deadline).getTime() - new Date(row.created_at).getTime()).toBe(24 * 3600_000);
    expect(alerts.find((a) => a.event === "abuse_dispute_new")?.fields?.reason).toBe(disputeId);
    expect(mailer.last(STAFF, "notice")?.subject).toBe("Владелец оспаривает блокировку");
    const again = await api.req("POST", `/systems/${systemId}/disputes`, { body: { revision: rev } });
    expect(again.body.reportId).toBe(disputeId);
    // The owner's own dispute is not an abuse signal (G2-AF-08 abuse_reports_prev).
    expect((await abuseContext(api.deps.db, orgId)).abuseReportsPrev).toBe(0);
  });

  test("staff closes the dispute → the owner gets the moderator's answer", async () => {
    const r = await staff.req("POST", `/admin/abuse-reports/${disputeId}/actions`, {
      body: { action: "dismiss", note: "Проверили: поле не собирает карты, бренд добавлен в исключения" },
    });
    expect(r.status, r.text).toBe(200);
    const letter = mailer.last(OWNER, "notice");
    expect(letter?.subject).toMatch(/^Проверка блокировки системы «.+» завершена$/);
    expect(letter?.text).toContain("Ответ модератора: Проверили: поле не собирает карты");
  });
});

describe("org-wide suspension", () => {
  let ticketId = "";

  test("non-staff → 404; suspend → every system of the org suspended, ORG_SUSPENDED, letters, journal", async () => {
    const t = await report({ url: prodUrl, category: "fraud", text: "Повторный обман" });
    ticketId = t.body.reportId;
    const user = await devLogin(api, EDITOR);
    expect(
      (
        await user.req("POST", `/admin/orgs/${orgId}/suspension`, {
          body: { action: "suspend", note: "xxx" },
        })
      ).status,
    ).toBe(404);
    expect((await deployments()).every((d) => !d.suspended)).toBe(true);
    const res = await staff.req("POST", `/admin/orgs/${orgId}/suspension`, {
      body: { action: "suspend", note: "Повторное нарушение", reportId: ticketId },
    });
    expect(res.status, res.text).toBe(200);
    expectContract("adminOrgSuspension", res);
    expect(res.body.suspendedAt).toBeTruthy();
    const deps = await deployments();
    expect(deps.map((d) => d.env)).toEqual(["draft", "prod"]);
    expect(deps.every((d) => d.suspended)).toBe(true);
    // The system itself is not taken down by its own ticket.
    expect((await sys()).suspended_at).toBeNull();
    const g = await api.req("GET", `/systems/${systemId}`);
    expect(g.body.publishBlockers).toContain("ORG_SUSPENDED");
    expectContract("getSystem", g);
    const s = await sys();
    const pub = await api.req("POST", `/systems/${systemId}/publish`, {
      body: { revision: s.preview_revision, confirmDiff: true },
    });
    expect(pub.status).toBe(403);
    expect(pub.body.code).toBe("ORG_SUSPENDED");
    expect(pub.body.message_ru).toContain("Публикации организации приостановлены");
    const letter = mailer.last(OWNER, "notice");
    expect(letter?.subject).toMatch(/^Публикации организации «.+» приостановлены$/);
    expect(letter?.text).toContain("ответьте на это письмо");
    const tk = await staff.req("GET", `/admin/abuse-reports/${ticketId}`);
    expectContract("adminGetAbuseReport", tk);
    expect(tk.body.system.orgSuspended).toBe(true);
    expect(tk.body.journal.some((j: { action: string }) => j.action === "org_suspend")).toBe(true);
    const again = await staff.req("POST", `/admin/orgs/${orgId}/suspension`, {
      body: { action: "suspend", note: "ещё раз" },
    });
    expect(again.status).toBe(400);
  });

  test("restore → systems served again, letter, publishBlockers without ORG_SUSPENDED", async () => {
    const res = await staff.req("POST", `/admin/orgs/${orgId}/suspension`, {
      body: { action: "restore", note: "Владелец устранил нарушения", reportId: ticketId },
    });
    expect(res.status, res.text).toBe(200);
    expect(res.body.suspendedAt).toBeNull();
    expect((await deployments()).every((d) => !d.suspended)).toBe(true);
    expect(mailer.last(OWNER, "notice")?.subject).toMatch(/восстановлены$/);
    const g = await api.req("GET", `/systems/${systemId}`);
    expect(g.body.publishBlockers).not.toContain("ORG_SUSPENDED");
    const audit = await api.deps.db
      .selectFrom("platform.staff_audit_log")
      .select(["action", "target", "note"])
      .where("target", "=", `org:${orgId}`)
      .orderBy("created_at")
      .execute();
    expect(audit.map((a) => a.action)).toEqual(["org_suspend", "org_restore"]);
    expect(audit[0]?.note).toContain(`abuse_report:${ticketId}`);
  });
});

describe("automatic takedown (abuse.yaml#takedown.auto_suspend)", () => {
  async function seedPhishing(n: number) {
    for (let i = 0; i < n; i++)
      await api.deps.db
        .insertInto("platform.abuse_reports")
        .values({
          system_id: systemId,
          url: prodUrl,
          category: "phishing",
          reporter_ip_hash: String(i).repeat(64).slice(0, 64),
          sla_deadline: new Date(Date.now() + 24 * 3600_000),
        })
        .execute();
  }

  test("2 IPs → nothing; the 3rd (HTTP) on a clean revision → G2 re-check passes → only a staff alert", async () => {
    await api.deps.pg`update platform.abuse_reports set created_at = now() - interval '2 hours'`;
    await seedPhishing(1);
    const second = await report({ url: prodUrl, category: "phishing" });
    expect(second.status).toBe(202);
    expect(alerts.some((a) => a.event.startsWith("abuse_auto") || a.event === "abuse_phishing_cluster")).toBe(
      false,
    );
    await seedPhishing(2);
    const third = await report({ url: prodUrl, category: "phishing" });
    expect(third.status).toBe(202);
    const cluster = alerts.find((a) => a.event === "abuse_phishing_cluster");
    expect(cluster?.level).toBe("error");
    expect(cluster?.fields?.count).toBe(3);
    expect((await sys()).suspended_at).toBeNull();
    expect((await deployments()).find((d) => d.env === "prod")?.suspended).toBe(false);
    // Once per publication and hour: the next report does not re-check.
    const fourth = await report({ url: prodUrl, category: "phishing" });
    expect(fourth.status).toBe(202);
    expect(alerts.filter((a) => a.event === "abuse_phishing_cluster")).toHaveLength(1);
  });

  test("the live revision fails the current G2 antifraud → immediate takedown with the ticket, letter, alert; restore", async () => {
    // The stored live revision now collects card numbers (G2-AF-01 under today's patterns).
    await api.deps.pg`
      update platform.revisions
      set spec = jsonb_set(spec, '{entities,2,fields}', (spec #> '{entities,2,fields}') || ${api.deps.pg.json(
        [{ name: "card_number", label: "Номер карты", type: "string" }],
      )}::jsonb)
      where system_id = ${systemId} and version = ${prodRevision}`;
    await api.deps.pg`delete from platform.ops_alerts where key like 'auto_suspend:%'`;
    const n = mailer.sent.filter((m) => m.to === OWNER).length;
    const res = await report({ url: prodUrl, category: "phishing", text: "Просят ввести карту" });
    expect(res.status).toBe(202);
    const reportId = res.body.reportId as string;
    const auto = alerts.find((a) => a.event === "abuse_auto_suspend");
    expect(auto?.level).toBe("error");
    expect(auto?.fields?.code).toBe("G2-AF-01");
    expect(auto?.text).toContain(`/admin?report=${reportId}`);
    expect((await sys()).suspended_at).not.toBeNull();
    expect((await deployments()).find((d) => d.env === "prod")?.suspended).toBe(true);
    const pubs = await api.deps.db
      .selectFrom("platform.publications")
      .select(["status", "suspended_reason"])
      .where("system_id", "=", systemId)
      .where("status", "=", "suspended")
      .execute();
    expect(pubs).toEqual([{ status: "suspended", suspended_reason: "phishing" }]);
    const ticket = await api.deps.db
      .selectFrom("platform.abuse_reports")
      .selectAll()
      .where("id", "=", reportId)
      .executeTakeFirstOrThrow();
    expect(ticket.status).toBe("takedown");
    expect(ticket.resolved_at).not.toBeNull();
    expect(ticket.resolution_note).toContain("Автоматическое снятие");
    const letters = mailer.sent.filter((m) => m.to === OWNER);
    expect(letters.length).toBe(n + 1);
    expect(letters.at(-1)?.text).toContain("Причина: фишинг");
    // Already down: a further check is skipped.
    expect(await checkAutoSuspend(abuseDeps(), { systemId, reportId })).toEqual({
      outcome: "skipped",
      reason: "suspended",
    });
    const restore = await staff.req("POST", `/admin/abuse-reports/${reportId}/actions`, {
      body: { action: "restore", note: "Владелец убрал поле карты" },
    });
    expect(restore.status, restore.text).toBe(200);
    expect((await deployments()).find((d) => d.env === "prod")?.suspended).toBe(false);
  });

  test("dismissed reports and reports without an IP do not count", async () => {
    await api.deps
      .pg`update platform.abuse_reports set status = 'dismissed' where category = 'phishing' and status = 'new'`;
    const r = await checkAutoSuspend(abuseDeps(), {
      systemId,
      reportId: "00000000-0000-4000-8000-000000000000",
    });
    expect(r.outcome).toBe("below_threshold");
  });
});

describe("founder alerts: one dedup path (ops/alert.ts)", () => {
  test("alertOnce claims a key once across callers and counts wizard_ops_alerts_total", async () => {
    const got: OpsAlert[] = [];
    const sink = async (a: OpsAlert) => {
      got.push(a);
    };
    const a: OpsAlert = { level: "warn", event: "cleanup_test_alert", text: "тест" };
    const counted = opsAlertsSent.get({ event: "cleanup_test_alert" });
    const first = await Promise.all([
      alertOnce(api.deps.db, "cleanup:test", sink, a),
      alertOnce(api.deps.db, "cleanup:test", sink, a),
    ]);
    expect(first.filter(Boolean)).toHaveLength(1);
    expect(got).toHaveLength(1);
    expect(await claimOpsAlert(api.deps.db, "cleanup:test")).toBe(false);
    expect(opsAlertsSent.get({ event: "cleanup_test_alert" })).toBe(counted + 1);
  });
});

function abuseDeps() {
  return {
    db: api.deps.db,
    pg: api.deps.pg,
    config: api.deps.config,
    mailer,
    alert: async (a: OpsAlert) => {
      alerts.push(a);
    },
  };
}
