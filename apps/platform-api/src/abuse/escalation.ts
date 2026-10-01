// Escalations of security/abuse.yaml#takedown beyond one ticket (cleanup after M2-08): the org-wide suspension
// («Повторное нарушение или явный фишинг → orgs.suspended_at: все системы организации снимаются, новые публикации
// запрещены (ORG_SUSPENDED)»), the automatic takedown (#takedown.auto_suspend: ≥ 3 phishing reports from different IPs
// in 1 h AND the live revision fails the current G2 antifraud → immediate takedown with a ticket) and the owner's
// «Оспорить» of a G2 antifraud stop (#rescan: «Ложная блокировка в G2 → кнопка «Оспорить» → тикет staff
// category=auto_g2», #messages_ru.dispute).
import { ABUSE, runG2 } from "@wizard/gates";
import { sql } from "kysely";
import { invalid, notFound } from "../errors.js";
import { claimOpsAlert } from "../ops/alert.js";
import { opsAlertsSent } from "../ops/registry.js";
import { abuseContext, orgOwnerEmails } from "../publish/moderation.js";
import { loadManifest, loadSpec } from "../services/revisions.js";
import {
  ABUSE_SLA_MS,
  type AbuseDeps,
  alertNewReport,
  mailOwners,
  reportTarget,
  staffAudit,
  takedownLetter,
} from "./reports.js";

const HOUR_MS = 3600_000;

/** abuse.yaml#takedown.auto_suspend: phishing reports from different IPs within an hour. */
export const AUTO_SUSPEND_REPORTS = 3;
/** G2 antifraud blockers (gates.yaml#G2.antifraud_rules; G2-AF-08/09 are warnings for the founder review). */
export const AF_BLOCKERS: readonly string[] = [
  "G2-AF-01",
  "G2-AF-02",
  "G2-AF-03",
  "G2-AF-04",
  "G2-AF-05",
  "G2-AF-06",
  "G2-AF-07",
];

/** abuse.yaml#messages_ru.dispute. */
export const DISPUTE_SENT_RU =
  ABUSE.messages.dispute ?? "Заявка на проверку отправлена. Ответим на почту владельца в течение 24 часов.";

// ---------------------------------------------------------------------------------------------------------------
// Org-wide suspension

export interface OrgSuspension {
  orgId: string;
  suspendedAt: string | null;
}

/**
 * api.yaml#adminOrgSuspension: suspend — orgs.suspended_at (the deployments view marks every system of the org
 * suspended → runtime 451 on draft and prod; publish → 403 ORG_SUSPENDED); restore — clears it (systems taken down by
 * their own tickets stay down). Journaled (staff_audit_log org_suspend|org_restore, target org:<id>); owners get a
 * letter. A no-op transition → 400.
 */
export async function setOrgSuspension(
  d: AbuseDeps,
  a: {
    orgId: string;
    action: "suspend" | "restore";
    actor: string;
    note: string;
    reportId?: string | undefined;
  },
  now = new Date(),
): Promise<OrgSuspension> {
  const org = await d.db.transaction().execute(async (trx) => {
    const o = await trx
      .selectFrom("platform.orgs")
      .select(["id", "name", "suspended_at"])
      .where("id", "=", a.orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!o) throw notFound("Организация");
    if ((a.action === "suspend") === (o.suspended_at !== null))
      throw invalid(
        a.action === "suspend" ? "Организация уже приостановлена" : "Организация не приостановлена",
      );
    const updated = await trx
      .updateTable("platform.orgs")
      .set({ suspended_at: a.action === "suspend" ? now : null })
      .where("id", "=", o.id)
      .returning(["id", "name", "suspended_at"])
      .executeTakeFirstOrThrow();
    await staffAudit(
      trx,
      a.actor,
      `org_${a.action}`,
      `org:${o.id}`,
      a.reportId ? `${a.note} [${reportTarget(a.reportId)}]` : a.note,
    );
    return updated;
  });
  const [subject, text]: [string, string] =
    a.action === "suspend"
      ? [
          `Публикации организации «${org.name}» приостановлены`,
          [
            `Все системы организации «${org.name}» временно недоступны, новые публикации запрещены: повторное или явное нарушение правил платформы (жалобы на системы организации).`,
            "Посетители видят страницу «Система временно недоступна по жалобе». Данные систем сохранены и не удаляются.",
            "Если вы не согласны с решением, ответьте на это письмо — мы рассмотрим обращение в течение 24 часов.",
          ].join("\n"),
        ]
      : [
          `Публикации организации «${org.name}» восстановлены`,
          `Проверка завершена: системы организации «${org.name}» снова доступны, публиковать можно как обычно.`,
        ];
  try {
    for (const to of await orgOwnerEmails(d.db, org.id))
      await d.mailer.send({ kind: "notice", to, subject, text });
  } catch (e) {
    d.log?.("org suspension notice failed", e);
  }
  return {
    orgId: org.id,
    suspendedAt: org.suspended_at ? new Date(org.suspended_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Automatic takedown

/**
 * The current G2 antifraud on a stored revision: runG2 with only the G2-AF blockers (static over spec and sources with
 * today's patterns, no runtime) → ids of the failed checks.
 */
export async function antifraudRecheck(
  d: Pick<AbuseDeps, "db" | "pg" | "config" | "blobs">,
  s: { systemId: string; revision: number },
): Promise<string[]> {
  const sys = await d.db
    .selectFrom("platform.systems")
    .select(["id", "name", "slug", "schema_key", "org_id"])
    .where("id", "=", s.systemId)
    .executeTakeFirstOrThrow();
  const spec = await loadSpec(d.db, sys, s.revision);
  const files = new Map<string, string>();
  if (d.blobs) {
    const manifest = await loadManifest(d.db, d.blobs, sys.id, s.revision);
    for (const [p, sha] of Object.entries(manifest))
      if (p.startsWith("ui/") || p.startsWith("functions/"))
        files.set(p, (await d.blobs.get(sha)).toString("utf8"));
  }
  const report = await runG2(
    {
      spec,
      prevSpec: null,
      specVersion: s.revision,
      files,
      env: "prod",
      systemKey: sys.schema_key,
      db: d.pg,
      milestone: d.config.milestone,
      slug: sys.slug,
      abuse: await abuseContext(d.db, sys.org_id),
    },
    { only: AF_BLOCKERS },
  );
  return [...new Set(report.checks.filter((c) => c.status === "fail").map((c) => c.id))];
}

export type AutoSuspendResult =
  | { outcome: "below_threshold"; reports: number }
  | { outcome: "skipped"; reason: "not_live" | "suspended" | "checked" }
  | { outcome: "g2_passed"; reports: number }
  | { outcome: "suspended"; reports: number; checks: string[] };

/**
 * abuse.yaml#takedown.auto_suspend, after a phishing report on `systemId` was stored: with ≥ 3 phishing reports from
 * different IPs in the last hour, the live revision is re-checked by the current G2 antifraud once per publication and
 * hour (db.yaml#ops_alerts key auto_suspend:<publication>:<hour>). A failed blocker → the publication is suspended
 * (runtime 451, data kept), the triggering report becomes the takedown ticket, the owner gets the takedown letter and
 * the founder an error alert. A passing re-check only alerts (staff decides — «без решения staff автоматически НЕ
 * снимать»).
 */
export async function checkAutoSuspend(
  d: AbuseDeps,
  a: { systemId: string; reportId: string },
  now = new Date(),
): Promise<AutoSuspendResult> {
  const since = new Date(now.getTime() - HOUR_MS);
  const cnt = await d.db
    .selectFrom("platform.abuse_reports")
    .select(sql<string>`count(distinct reporter_ip_hash)`.as("n"))
    .where("system_id", "=", a.systemId)
    .where("category", "=", "phishing")
    .where("status", "<>", "dismissed")
    .where("reporter_ip_hash", "is not", null)
    .where("created_at", ">", since)
    .executeTakeFirstOrThrow();
  const reports = Number(cnt.n);
  if (reports < AUTO_SUSPEND_REPORTS) return { outcome: "below_threshold", reports };
  const sys = await d.db
    .selectFrom("platform.systems")
    .select(["id", "org_id", "suspended_at"])
    .where("id", "=", a.systemId)
    .executeTakeFirstOrThrow();
  if (sys.suspended_at) return { outcome: "skipped", reason: "suspended" };
  const pub = await d.db
    .selectFrom("platform.publications")
    .select(["id", "revision"])
    .where("system_id", "=", sys.id)
    .where("status", "=", "live")
    .executeTakeFirst();
  if (!pub) return { outcome: "skipped", reason: "not_live" };
  if (!(await claimOpsAlert(d.db, `auto_suspend:${pub.id}:${now.toISOString().slice(0, 13)}`)))
    return { outcome: "skipped", reason: "checked" };
  const recheck = d.antifraudRecheck ?? ((s) => antifraudRecheck(d, s));
  const checks = await recheck({ systemId: sys.id, revision: pub.revision });
  const link = `${d.config.platformOrigin}/admin?report=${a.reportId}`;
  if (checks.length === 0) {
    opsAlertsSent.inc({ event: "abuse_phishing_cluster" });
    await d.alert?.({
      level: "error",
      event: "abuse_phishing_cluster",
      text: `${reports} жалоб на фишинг за час на одну систему, антифрод-проверка G2 нарушений не нашла — автоматического снятия нет, нужен разбор. ${link}`,
      fields: {
        kind: "abuse_report",
        code: "phishing",
        reason: a.reportId,
        systemId: sys.id,
        count: reports,
      },
    });
    return { outcome: "g2_passed", reports };
  }
  const note = `Автоматическое снятие: ${reports} жалоб на фишинг с разных адресов за час и провал антифрод-проверки (${checks.join(", ")})`;
  const done = await d.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`abuse-system:${sys.id}`}))`.execute(trx);
    const live = await trx
      .updateTable("platform.publications")
      .set({ status: "suspended", suspended_reason: "phishing" })
      .where("id", "=", pub.id)
      .where("status", "=", "live")
      .returning("id")
      .executeTakeFirst();
    if (!live) return false;
    await trx
      .updateTable("platform.systems")
      .set({ suspended_at: now })
      .where("id", "=", sys.id)
      .where("suspended_at", "is", null)
      .execute();
    await trx
      .updateTable("platform.abuse_reports")
      .set({ status: "takedown", resolved_at: now, resolution_note: note })
      .where("id", "=", a.reportId)
      .where("status", "in", ["new", "triaged"])
      .execute();
    return true;
  });
  if (!done) return { outcome: "skipped", reason: "not_live" };
  opsAlertsSent.inc({ event: "abuse_auto_suspend" });
  await d.alert?.({
    level: "error",
    event: "abuse_auto_suspend",
    text: `Система снята автоматически: ${reports} жалоб на фишинг за час и провал антифрод-проверки (${checks.join(", ")}). Проверьте тикет: ${link}`,
    fields: {
      kind: "abuse_report",
      code: checks.join(","),
      reason: a.reportId,
      systemId: sys.id,
      count: reports,
    },
  });
  await mailOwners(d, sys.id, (name) => takedownLetter(name, "phishing"));
  return { outcome: "suspended", reports, checks };
}

// ---------------------------------------------------------------------------------------------------------------
// «Оспорить»

/**
 * api.yaml#disputeG2Block (owner): the latest G2 report of `revision` failed a G2 antifraud blocker → a staff ticket
 * category=auto_g2 (sla_deadline +24 h, alert and staff letters as a new report); one open ticket per system (a repeat
 * returns it). The answer comes to the owner's mail when staff closes the ticket.
 */
export async function disputeG2Block(
  d: AbuseDeps,
  a: { systemId: string; revision: number; text?: string | undefined },
  now = new Date(),
): Promise<{ reportId: string; created: boolean }> {
  const g2 = await d.db
    .selectFrom("platform.gate_reports")
    .select("report")
    .where("system_id", "=", a.systemId)
    .where("revision", "=", a.revision)
    .where("level", "=", "G2")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const checks = (((g2?.report ?? {}) as { checks?: { id: string; status: string }[] }).checks ?? [])
    .filter((c) => AF_BLOCKERS.includes(c.id) && c.status === "fail")
    .map((c) => c.id);
  const failed = [...new Set(checks)];
  if (failed.length === 0)
    throw invalid("Оспорить можно только остановку публикации проверкой безопасности (G2) этой ревизии");
  const row = await d.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`abuse-dispute:${a.systemId}`}))`.execute(trx);
    const open = await trx
      .selectFrom("platform.abuse_reports")
      .select(["id", "sla_deadline"])
      .where("system_id", "=", a.systemId)
      .where("category", "=", "auto_g2")
      .where("status", "in", ["new", "triaged"])
      .executeTakeFirst();
    if (open) return { id: open.id, sla: open.sla_deadline, created: false };
    const comment = a.text?.trim();
    const ins = await trx
      .insertInto("platform.abuse_reports")
      .values({
        system_id: a.systemId,
        url: `${d.config.platformOrigin.replace(/\/+$/, "")}/s/${a.systemId}`,
        category: "auto_g2",
        text: `Владелец оспаривает остановку публикации ревизии ${a.revision} (${failed.join(", ")}).${comment ? ` Комментарий: ${comment}` : ""}`,
        sla_deadline: new Date(now.getTime() + ABUSE_SLA_MS),
        created_at: now,
      })
      .returning(["id", "sla_deadline"])
      .executeTakeFirstOrThrow();
    return { id: ins.id, sla: ins.sla_deadline, created: true };
  });
  if (row.created)
    await alertNewReport(
      d,
      { id: row.id, category: "auto_g2", systemId: a.systemId, sla: row.sla },
      "dispute",
    );
  return { reportId: row.id, created: row.created };
}
