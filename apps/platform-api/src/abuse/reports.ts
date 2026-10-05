// «Пожаловаться» and takedown (security/abuse.yaml#report, #takedown; db.yaml#abuse_reports; M2-08): public reports
// with per-IP limits, the staff queue by sla_deadline, ticket actions (triage → takedown | dismiss, takedown → restore),
// staff access to system data only by a ticket for 24 h (compliance.yaml#platform.security_org staff_access, L3-43),
// owner and reporter letters, founder alerts (new report, SLA < 2 h) and the 1-year retention of the reporter e-mail.
import { quoteIdent, systemRoleName } from "@wizard/appspec";
import { schemaName } from "@wizard/runtime";
import { sql, type Transaction } from "kysely";
import type { Mailer } from "../auth/mailer.js";
import type { Config } from "../config.js";
import type { DB, Db } from "../db/index.js";
import type { AbuseCategory, AbuseStatus } from "../db/types.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { planExport } from "../exports/csv.js";
import { alertOnce, type OpsAlertFn } from "../ops/alert.js";
import { orgOwnerEmails } from "../publish/moderation.js";
import { prodUrl } from "../publish/prod.js";
import { loadSpec } from "../services/revisions.js";
import type { BlobStore } from "../storage/blobs.js";

const HOUR_MS = 3600_000;
/** abuse.yaml#report.storage: sla_deadline = created_at + 24 h. */
export const ABUSE_SLA_MS = 24 * HOUR_MS;
/** abuse.yaml#takedown.sla: alert when < 2 h are left. */
export const ABUSE_SLA_ALERT_MS = 2 * HOUR_MS;
/** abuse.yaml#report.endpoint: 10 reports an hour per IP (IPv6 by /64). */
export const REPORTS_PER_IP_HOUR = 10;
/** Flood guard without a captcha: all reports of the platform an hour. */
export const REPORTS_GLOBAL_HOUR = 300;
/** compliance.yaml#platform.security_org staff_access: TTL of staff access by a ticket. */
export const STAFF_ACCESS_TTL_MS = 24 * HOUR_MS;
/** db.yaml#abuse_reports.contact_email: removed one year after the ticket is closed. */
export const CONTACT_RETENTION_DAYS = 365;
/** Rows of one entity on the staff data screen. */
export const STAFF_DATA_ROWS = 50;

/** api.yaml#createAbuseReport categories (auto_g2 is set by the platform only). */
export const REPORT_CATEGORIES = [
  "phishing",
  "fraud",
  "brand_impersonation",
  "illegal_content",
  "pd_violation",
  "spam",
  "other",
] as const satisfies readonly AbuseCategory[];

export const CATEGORY_RU: Readonly<Record<AbuseCategory, string>> = {
  phishing: "фишинг (выманивание паролей, кодов или данных карт)",
  fraud: "мошенничество",
  brand_impersonation: "выдача себя за известный бренд или организацию",
  illegal_content: "незаконный контент",
  pd_violation: "нарушение правил обработки персональных данных",
  spam: "спам",
  other: "другое нарушение",
  auto_g2: "автоматическая проверка платформы",
};

export type AbuseAction = "triage" | "takedown" | "dismiss" | "restore";

const FROM: Readonly<Record<AbuseAction, readonly AbuseStatus[]>> = {
  triage: ["new"],
  takedown: ["new", "triaged"],
  dismiss: ["new", "triaged"],
  restore: ["takedown"],
};
const OPEN: readonly AbuseStatus[] = ["new", "triaged", "takedown"];

export const reportTarget = (id: string): string => `abuse_report:${id}`;

export interface AbuseDeps {
  db: Db;
  pg: import("postgres").Sql;
  config: Config;
  mailer: Mailer;
  alert?: OpsAlertFn | undefined;
  log?: ((msg: string, err?: unknown) => void) | undefined;
  /** Revision files for the antifraud re-check of the auto-suspension (abuse.yaml#takedown.auto_suspend). */
  blobs?: BlobStore | undefined;
  /**
   * Failed G2 antifraud blockers of the live revision (default: abuse/escalation.ts antifraudRecheck — runG2 with
   * G2-AF-01…07 on the stored revision and current patterns); tests may replace it.
   */
  antifraudRecheck?: ((s: { systemId: string; revision: number }) => Promise<string[]>) | undefined;
}

type Q = Db | Transaction<DB>;

/** One staff_audit_log row (compliance.yaml#platform.security_org). */
export async function staffAudit(
  q: Q,
  actor: string,
  action: string,
  target: string,
  note: string | null = null,
): Promise<void> {
  await q.insertInto("platform.staff_audit_log").values({ actor, action, target, note }).execute();
}

/** slug and env of a URL on the systems domain (runtime.yaml#routing), or null. */
export function systemOfUrl(
  config: Pick<Config, "systemsDomain">,
  raw: string,
): { slug: string; env: "draft" | "prod" } | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const domain = (config.systemsDomain || "localhost").toLowerCase();
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(`.${domain}`)) return null;
  const label = host.slice(0, -(domain.length + 1));
  if (label.includes(".")) return null;
  const draft = label.endsWith("--draft");
  const slug = draft ? label.slice(0, -"--draft".length) : label;
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(slug) || slug.includes("--")) return null;
  return { slug, env: draft ? "draft" : "prod" };
}

export interface NewReport {
  url: string;
  category: (typeof REPORT_CATEGORIES)[number];
  text?: string | undefined;
  contactEmail?: string | undefined;
  /** HMAC of the client IP limit key (IPv6 by /64). */
  ipHash: string;
}

/** Stores a report (limits: REPORTS_PER_IP_HOUR, REPORTS_GLOBAL_HOUR); alerts staff after commit. */
export async function createAbuseReport(
  d: AbuseDeps,
  r: NewReport,
  now = new Date(),
): Promise<{ id: string; systemId: string | null; slaDeadline: Date }> {
  const host = systemOfUrl(d.config, r.url);
  if (!host) throw invalid("Укажите адрес системы, на которую жалуетесь (страница с кнопкой «Пожаловаться»)");
  const row = await d.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`abuse:${r.ipHash}`}))`.execute(trx);
    const since = new Date(now.getTime() - HOUR_MS);
    const [byIp, all] = await Promise.all([
      trx
        .selectFrom("platform.abuse_reports")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("reporter_ip_hash", "=", r.ipHash)
        .where("created_at", ">", since)
        .executeTakeFirstOrThrow(),
      trx
        .selectFrom("platform.abuse_reports")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("created_at", ">", since)
        .executeTakeFirstOrThrow(),
    ]);
    if (Number(byIp.n) >= REPORTS_PER_IP_HOUR || Number(all.n) >= REPORTS_GLOBAL_HOUR)
      throw new ApiError("RATE_LIMITED", "Слишком много жалоб — попробуйте через час");
    const sys = await trx
      .selectFrom("platform.systems")
      .select("id")
      .where("slug", "=", host.slug)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const pub =
      sys && host.env === "prod"
        ? await trx
            .selectFrom("platform.publications")
            .select("id")
            .where("system_id", "=", sys.id)
            .where("status", "in", ["live", "suspended"])
            .orderBy("created_at", "desc")
            .limit(1)
            .executeTakeFirst()
        : undefined;
    return trx
      .insertInto("platform.abuse_reports")
      .values({
        system_id: sys?.id ?? null,
        publication_id: pub?.id ?? null,
        url: r.url,
        category: r.category,
        text: r.text?.trim() || null,
        contact_email: r.contactEmail ?? null,
        reporter_ip_hash: r.ipHash,
        sla_deadline: new Date(now.getTime() + ABUSE_SLA_MS),
        created_at: now,
      })
      .returning(["id", "system_id", "sla_deadline"])
      .executeTakeFirstOrThrow();
  });
  await alertNewReport(d, {
    id: row.id,
    category: r.category,
    systemId: row.system_id,
    sla: row.sla_deadline,
  });
  return { id: row.id, systemId: row.system_id, slaDeadline: row.sla_deadline };
}

export const mskTime = (d: Date): string =>
  `${d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} МСК`;

/**
 * Founder alert (log + webhook) and a letter to every staff account about a new ticket — a complaint or the owner's
 * «Оспорить» (kind dispute, category auto_g2); no reporter data leaves the DB.
 */
export async function alertNewReport(
  d: AbuseDeps,
  r: { id: string; category: AbuseCategory; systemId: string | null; sla: Date },
  kind: "report" | "dispute" = "report",
): Promise<void> {
  const link = `${d.config.platformOrigin}/admin?report=${r.id}`;
  const text =
    kind === "dispute"
      ? `Владелец оспаривает остановку публикации проверкой безопасности. Ответ — до ${mskTime(r.sla)}. ${link}`
      : `Новая жалоба: ${CATEGORY_RU[r.category]}. Решение — до ${mskTime(r.sla)}. ${link}`;
  try {
    await d.alert?.({
      level: r.category === "phishing" ? "error" : "warn",
      event: kind === "dispute" ? "abuse_dispute_new" : "abuse_report_new",
      text,
      fields: { kind: "abuse_report", code: r.category, reason: r.id, systemId: r.systemId },
    });
    const staff = await d.db
      .selectFrom("platform.users")
      .select("email")
      .where("is_staff", "=", true)
      .where("deleted_at", "is", null)
      .execute();
    const subject = kind === "dispute" ? "Владелец оспаривает блокировку" : "Новая жалоба на систему";
    for (const s of staff) await d.mailer.send({ kind: "notice", to: s.email, subject, text });
  } catch (e) {
    d.log?.("abuse report alert failed", e);
  }
}

/** Open reports whose SLA ends within 2 h (or is over): one alert per report (db.yaml#ops_alerts). */
export async function checkAbuseSla(d: Pick<AbuseDeps, "db" | "alert">, now = new Date()): Promise<number> {
  const due = await d.db
    .selectFrom("platform.abuse_reports")
    .select(["id", "category", "sla_deadline", "system_id"])
    .where("status", "in", ["new", "triaged"])
    .where("sla_deadline", "<", new Date(now.getTime() + ABUSE_SLA_ALERT_MS))
    .orderBy("sla_deadline")
    .limit(100)
    .execute();
  let sent = 0;
  for (const r of due)
    if (
      await alertOnce(d.db, `abuse_sla:${r.id}`, d.alert, {
        level: "error",
        event: "abuse_sla_at_risk",
        text: `Жалоба (${CATEGORY_RU[r.category]}) без решения, срок — ${mskTime(r.sla_deadline)}`,
        fields: { kind: "abuse_report", code: r.category, reason: r.id, systemId: r.system_id },
      })
    )
      sent++;
  return sent;
}

/** db.yaml#abuse_reports.contact_email: NULL one year after the ticket was closed. */
export async function purgeAbuseContacts(db: Db, now: Date): Promise<number> {
  const r = await db
    .updateTable("platform.abuse_reports")
    .set({ contact_email: null })
    .where("contact_email", "is not", null)
    .where("status", "in", ["dismissed", "restored", "takedown"])
    .where("resolved_at", "<", new Date(now.getTime() - CONTACT_RETENTION_DAYS * 24 * HOUR_MS))
    .executeTakeFirst();
  return Number(r.numUpdatedRows);
}

/** Expiry of the open staff access by this ticket, or null (closed ticket or none opened in the last 24 h). */
export async function staffAccessUntil(q: Q, reportId: string, now = new Date()): Promise<Date | null> {
  const rep = await q
    .selectFrom("platform.abuse_reports")
    .select("status")
    .where("id", "=", reportId)
    .executeTakeFirst();
  if (!rep || !OPEN.includes(rep.status)) return null;
  const last = await q
    .selectFrom("platform.staff_audit_log")
    .select("created_at")
    .where("target", "=", reportTarget(reportId))
    .where("action", "=", "staff_access_open")
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!last) return null;
  const until = new Date(new Date(last.created_at).getTime() + STAFF_ACCESS_TTL_MS);
  return until > now ? until : null;
}

/** Report row as api.yaml#AbuseReport (+ staff-only fields of the ticket view). */
export function toAbuseReport(r: {
  id: string;
  system_id: string | null;
  category: AbuseCategory;
  status: AbuseStatus;
  sla_deadline: Date;
  created_at: Date;
  url: string;
  resolved_at: Date | null;
}) {
  return {
    id: r.id,
    systemId: r.system_id,
    category: r.category,
    status: r.status,
    slaDeadline: new Date(r.sla_deadline).toISOString(),
    createdAt: new Date(r.created_at).toISOString(),
    url: r.url,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
  };
}

const reportColumns = [
  "ar.id",
  "ar.system_id",
  "ar.category",
  "ar.status",
  "ar.sla_deadline",
  "ar.created_at",
  "ar.url",
  "ar.resolved_at",
] as const;

/** The moderation queue: open tickets first by sla_deadline, then closed ones (newest first). */
export async function listAbuseReports(db: Db, status?: AbuseStatus) {
  let q = db
    .selectFrom("platform.abuse_reports as ar")
    .leftJoin("platform.systems as s", "s.id", "ar.system_id")
    .select([...reportColumns, "s.name as system_name"]);
  if (status) q = q.where("ar.status", "=", status);
  const rows = await q
    .orderBy(sql`case when ar.status in ('new','triaged') then 0 else 1 end`)
    .orderBy(sql`case when ar.status in ('new','triaged') then ar.sla_deadline end`)
    .orderBy("ar.created_at", "desc")
    .limit(200)
    .execute();
  return rows.map((r) => ({ ...toAbuseReport(r), systemName: r.system_name }));
}

/** Ticket view for staff: report, system, open access and the ticket's staff journal. */
export async function abuseTicket(d: Pick<AbuseDeps, "db" | "config">, id: string, now = new Date()) {
  const r = await d.db
    .selectFrom("platform.abuse_reports as ar")
    .leftJoin("platform.systems as s", "s.id", "ar.system_id")
    .leftJoin("platform.orgs as o", "o.id", "s.org_id")
    .select([
      ...reportColumns,
      "ar.text",
      "ar.contact_email",
      "ar.resolution_note",
      "s.name as system_name",
      "s.slug",
      "s.org_id",
      "s.suspended_at",
      "s.prod_revision",
      "o.suspended_at as org_suspended_at",
    ])
    .where("ar.id", "=", id)
    .executeTakeFirst();
  if (!r) throw notFound("Жалоба");
  const journal = await d.db
    .selectFrom("platform.staff_audit_log as l")
    .innerJoin("platform.users as u", "u.id", "l.actor")
    .select(["l.action", "l.note", "l.created_at", "u.email"])
    .where("l.target", "in", [
      reportTarget(id),
      ...(r.system_id ? [`system:${r.system_id}`] : []),
      ...(r.org_id ? [`org:${r.org_id}`] : []),
    ])
    .orderBy("l.created_at", "desc")
    .limit(100)
    .execute();
  const until = await staffAccessUntil(d.db, id, now);
  return {
    ...toAbuseReport(r),
    text: r.text,
    contactEmail: r.contact_email,
    resolutionNote: r.resolution_note,
    system: r.system_id
      ? {
          id: r.system_id,
          name: r.system_name,
          orgId: r.org_id,
          prodUrl: r.slug && r.prod_revision !== null ? prodUrl(d.config, r.slug) : null,
          suspended: r.suspended_at !== null,
          orgSuspended: r.org_suspended_at !== null,
        }
      : null,
    access: until ? { until: until.toISOString() } : null,
    journal: journal.map((j) => ({
      action: j.action,
      note: j.note,
      actor: j.email,
      at: new Date(j.created_at).toISOString(),
    })),
  };
}

/** Letter to every owner of the system's org (subject and text from the system name); failures are logged. */
export async function mailOwners(
  d: Pick<AbuseDeps, "db" | "mailer" | "log">,
  systemId: string,
  letter: (name: string) => [string, string],
) {
  try {
    const sys = await d.db
      .selectFrom("platform.systems")
      .select(["name", "org_id"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    const [subject, text] = letter(sys.name);
    for (const to of await orgOwnerEmails(d.db, sys.org_id))
      await d.mailer.send({ kind: "notice", to, subject, text });
  } catch (e) {
    d.log?.("abuse owner notice failed", e);
  }
}

/** The answer to the owner's «Оспорить» (abuse.yaml#messages_ru.dispute «Ответим на почту владельца»). */
export function disputeAnswerLetter(name: string, note: string): [string, string] {
  return [
    `Проверка блокировки системы «${name}» завершена`,
    [
      `Модератор Born to Build рассмотрел вашу заявку на проверку остановки публикации системы «${name}».`,
      `Ответ модератора: ${note}`,
      "Если вопросы остались, ответьте на это письмо.",
    ].join("\n"),
  ];
}

/** abuse.yaml#takedown.flow «Уведомление владельцу сразу при takedown: причина, как оспорить». */
export function takedownLetter(name: string, category: AbuseCategory): [string, string] {
  return [
    `Система «${name}» временно недоступна по жалобе`,
    [
      `Публикация системы «${name}» приостановлена по жалобе. Причина: ${CATEGORY_RU[category]}.`,
      "Посетители видят страницу «Система временно недоступна по жалобе». Данные системы сохранены и не удаляются.",
      "Если вы не согласны с решением, ответьте на это письмо — мы рассмотрим обращение в течение 24 часов.",
    ].join("\n"),
  ];
}

/** compliance.yaml staff_access: the owner learns about staff access, except while phishing is investigated. */
async function noticeStaffAccess(
  d: AbuseDeps,
  rep: { id: string; system_id: string | null; category: AbuseCategory },
) {
  if (!rep.system_id || rep.category === "phishing") return;
  await mailOwners(d, rep.system_id, (name) => [
    `Доступ к данным системы «${name}» для проверки обращения`,
    [
      `Сотрудник Born to Build открыл доступ к данным системы «${name}» на 24 часа, чтобы проверить обращение №${rep.id.slice(0, 8)}.`,
      "Доступ только на чтение, персональные данные пользователей скрыты, каждое действие записывается в журнал.",
      "Если у вас есть вопросы, ответьте на это письмо.",
    ].join("\n"),
  ]);
}

/** Opens staff access to the ticket's system for 24 h (audit row + owner notice except phishing). */
export async function openStaffAccess(
  d: AbuseDeps,
  a: { reportId: string; actor: string; note: string },
): Promise<Date> {
  const rep = await d.db.transaction().execute(async (trx) => {
    const r = await trx
      .selectFrom("platform.abuse_reports")
      .select(["id", "system_id", "category", "status"])
      .where("id", "=", a.reportId)
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw notFound("Жалоба");
    if (!OPEN.includes(r.status)) throw invalid("Тикет закрыт — доступ к данным по нему не открывается");
    if (!r.system_id) throw invalid("Жалоба не относится к системе платформы");
    await staffAudit(trx, a.actor, "staff_access_open", reportTarget(r.id), a.note);
    return r;
  });
  await noticeStaffAccess(d, rep);
  return (await staffAccessUntil(d.db, rep.id)) as Date;
}

/**
 * api.yaml#adminAbuseAction. triage opens staff access (24 h) and may fix the category; takedown suspends the prod
 * publication and the system (runtime → 451, data kept) and mails the owner; restore puts the publication back live;
 * dismiss closes the ticket. The reporter (if left an e-mail) gets a neutral letter on the decision.
 */
export async function applyAbuseAction(
  d: AbuseDeps,
  a: {
    reportId: string;
    action: AbuseAction;
    note: string;
    actor: string;
    category?: AbuseCategory | undefined;
  },
  now = new Date(),
) {
  const rep = await d.db.transaction().execute(async (trx) => {
    const r = await trx
      .selectFrom("platform.abuse_reports")
      .selectAll()
      .where("id", "=", a.reportId)
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw notFound("Жалоба");
    if (!FROM[a.action].includes(r.status))
      throw invalid("Это действие недоступно для тикета в текущем статусе", { status: r.status });
    const category = a.action === "triage" && a.category ? a.category : r.category;
    let status: AbuseStatus = r.status;
    let resolved: Date | null = r.resolved_at;
    if (a.action === "triage") {
      if (!r.system_id) throw invalid("Жалоба не относится к системе платформы — отклоните её");
      status = "triaged";
      await staffAudit(trx, a.actor, "staff_access_open", reportTarget(r.id), a.note);
    } else if (a.action === "takedown") {
      if (!r.system_id) throw invalid("Жалоба не относится к системе платформы — снимать нечего");
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`abuse-system:${r.system_id}`}))`.execute(trx);
      await trx
        .updateTable("platform.publications")
        .set({ status: "suspended", suspended_reason: category })
        .where("system_id", "=", r.system_id)
        .where("status", "=", "live")
        .execute();
      await trx
        .updateTable("platform.systems")
        .set({ suspended_at: now })
        .where("id", "=", r.system_id)
        .where("suspended_at", "is", null)
        .execute();
      status = "takedown";
      resolved = now;
    } else if (a.action === "dismiss") {
      status = "dismissed";
      resolved = now;
    } else {
      const systemId = r.system_id as string;
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`abuse-system:${systemId}`}))`.execute(trx);
      // Another ticket that took the system down keeps it down.
      const other = await trx
        .selectFrom("platform.abuse_reports")
        .select("id")
        .where("system_id", "=", systemId)
        .where("status", "=", "takedown")
        .where("id", "<>", r.id)
        .executeTakeFirst();
      if (!other) {
        const live = await trx
          .selectFrom("platform.publications")
          .select("id")
          .where("system_id", "=", systemId)
          .where("status", "=", "live")
          .executeTakeFirst();
        const last = live
          ? undefined
          : await trx
              .selectFrom("platform.publications")
              .select("id")
              .where("system_id", "=", systemId)
              .where("status", "=", "suspended")
              .orderBy("created_at", "desc")
              .limit(1)
              .executeTakeFirst();
        if (last)
          await trx
            .updateTable("platform.publications")
            .set({ status: "live", suspended_reason: null })
            .where("id", "=", last.id)
            .execute();
        await trx
          .updateTable("platform.systems")
          .set({ suspended_at: null })
          .where("id", "=", systemId)
          .execute();
      }
      status = "restored";
      resolved = now;
    }
    const updated = await trx
      .updateTable("platform.abuse_reports")
      .set({
        status,
        category,
        assignee: a.actor,
        resolved_at: resolved,
        ...(a.action === "triage" ? {} : { resolution_note: a.note }),
      })
      .where("id", "=", r.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await staffAudit(
      trx,
      a.actor,
      `abuse_${a.action}`,
      reportTarget(r.id),
      category !== r.category ? `${a.note} [категория: ${r.category} → ${category}]` : a.note,
    );
    return updated;
  });

  if (a.action === "triage") await noticeStaffAccess(d, rep);
  if (a.action === "takedown" && rep.system_id)
    await mailOwners(d, rep.system_id, (name) => takedownLetter(name, rep.category));
  // «Оспорить» (category auto_g2): the owner asked for a check, so the staff note answers them when the ticket closes.
  if (a.action === "dismiss" && rep.category === "auto_g2" && rep.system_id)
    await mailOwners(d, rep.system_id, (name) => disputeAnswerLetter(name, a.note));
  if (a.action === "restore" && rep.system_id)
    await mailOwners(d, rep.system_id, (name) => [
      `Система «${name}» снова доступна`,
      `Проверка завершена, публикация системы «${name}» восстановлена.`,
    ]);
  if ((a.action === "takedown" || a.action === "dismiss") && rep.contact_email)
    await d.mailer
      .send({
        kind: "notice",
        to: rep.contact_email,
        subject: "Ваша жалоба рассмотрена",
        text: "Спасибо за сообщение. Мы проверили жалобу и приняли меры, если нарушение подтвердилось.",
      })
      .catch((e) => d.log?.("abuse reporter notice failed", e));
  return toAbuseReport(rep);
}

/**
 * Staff view of the ticket's system data (read-only, personal-data columns left out — planExport includePii=false):
 * only with an open access by the ticket; every read is written to staff_audit_log.
 */
export async function staffSystemData(
  d: AbuseDeps,
  a: { reportId: string; actor: string; entity?: string | undefined },
  now = new Date(),
) {
  const rep = await d.db
    .selectFrom("platform.abuse_reports")
    .select(["id", "system_id"])
    .where("id", "=", a.reportId)
    .executeTakeFirst();
  if (!rep) throw notFound("Жалоба");
  const until = await staffAccessUntil(d.db, rep.id, now);
  if (!until || !rep.system_id)
    throw new ApiError("FORBIDDEN", "Доступ к данным системы открывается только по тикету и на 24 часа");
  const sys = await d.db
    .selectFrom("platform.systems")
    .select(["id", "name", "schema_key", "prod_revision", "preview_revision"])
    .where("id", "=", rep.system_id)
    .executeTakeFirstOrThrow();
  const env = sys.prod_revision !== null ? "prod" : "draft";
  const revision = sys.prod_revision ?? sys.preview_revision;
  const base = { env, revision, accessUntil: until.toISOString(), omittedPii: 0 };
  if (revision === null) {
    await staffAudit(
      d.db,
      a.actor,
      "staff_data_read",
      `system:${sys.id}`,
      `${reportTarget(rep.id)} (нет данных)`,
    );
    return { ...base, entities: [], entity: null, columns: [], rows: [] };
  }
  const spec = await loadSpec(d.db, sys, revision);
  const plan = planExport(spec, { includePii: false });
  const schema = schemaName(sys.schema_key, env);
  const labels = new Map(spec.entities.map((e) => [e.name, e.label ?? e.name]));
  const wanted = a.entity && plan.tables.some((t) => t.table === a.entity) ? a.entity : plan.tables[0]?.table;
  const out = await d.pg.begin("isolation level repeatable read, read only", async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(systemRoleName(schema))}`);
    await tx.unsafe("select set_config('TimeZone', 'UTC', true)");
    const colRows = await tx<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns where table_schema = ${schema}`;
    const have = new Map<string, Set<string>>();
    for (const r of colRows) have.set(r.table_name, (have.get(r.table_name) ?? new Set()).add(r.column_name));
    const entities: { name: string; label: string; rows: number }[] = [];
    for (const t of plan.tables) {
      if (!have.has(t.table)) continue;
      const [c] = await tx.unsafe(
        `select count(*)::int as n from ${quoteIdent(schema)}.${quoteIdent(t.table)}`,
      );
      entities.push({ name: t.table, label: labels.get(t.table) ?? t.table, rows: Number(c?.n ?? 0) });
    }
    const t = plan.tables.find((x) => x.table === wanted);
    const cols = t ? t.columns.filter((c) => have.get(t.table)?.has(c.name)) : [];
    let rows: Record<string, string | null>[] = [];
    if (t && cols.length > 0) {
      const order = ["created_at", "id"].filter((c) => have.get(t.table)?.has(c));
      rows = (await tx.unsafe(
        `select ${cols.map((c) => `to_jsonb(${quoteIdent(c.name)}) #>> '{}' as ${quoteIdent(c.name)}`).join(", ")}
         from ${quoteIdent(schema)}.${quoteIdent(t.table)}${order.length ? ` order by ${order.map((c) => `${quoteIdent(c)} desc`).join(", ")}` : ""}
         limit ${STAFF_DATA_ROWS}`,
      )) as unknown as Record<string, string | null>[];
    }
    return { entities, entity: t ? t.table : null, columns: cols.map((c) => c.name), rows };
  });
  await staffAudit(
    d.db,
    a.actor,
    "staff_data_read",
    `system:${sys.id}`,
    `${reportTarget(rep.id)} entity=${out.entity ?? "-"}`,
  );
  return { ...base, omittedPii: plan.omittedPii, ...out, rows: out.rows.map((r) => ({ ...r })) };
}
