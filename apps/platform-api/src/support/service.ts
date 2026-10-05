// «Написать команде» (product.yaml#decisions.D68_support_button, M2-35 mvp_scope): a client message goes to the founder
// in Telegram through the platform bot (the founder alert channel: WIZARD_OPS_ALERT_URL + WIZARD_OPS_ALERT_CHAT_ID) with
// the org name, the client's address and a link to the system; a copy is kept for /admin (db.yaml#support_requests).
// The founder answers by letter himself — there is no conversation in the cabinet. The promised reply time counts 2
// hours of working time, Mon–Fri 10:00–19:00 Moscow (D60); holidays are not known to the platform.
import { scrub } from "@wizard/pii";
import { sql } from "kysely";
import type { Db } from "../db/index.js";
import { ApiError, notFound } from "../errors.js";
import type { OpsAlertFn } from "../ops/alert.js";

/** Moscow has no DST since 2014. */
const MSK_MS = 3 * 3600_000;
const HOUR_MS = 3600_000;
export const WORK_START_HOUR = 10;
export const WORK_END_HOUR = 19;
/** Reply within this much working time (D32 «ответ до 2 часов», D60 working hours). */
export const REPLY_WORKING_MS = 2 * HOUR_MS;
/** Rate limits of sending (≤ per hour). */
export const SUPPORT_PER_USER_HOUR = 5;
export const SUPPORT_PER_ORG_HOUR = 10;
/** Telegram message: the client's text is cut to this length (the full text is in /admin). */
const TELEGRAM_TEXT_MAX = 1500;

/** Working window [start, end) of the Moscow day containing `t`, or null on a weekend. */
function windowOf(t: number): { start: number; end: number } | null {
  const msk = new Date(t + MSK_MS);
  const dow = msk.getUTCDay();
  if (dow === 0 || dow === 6) return null;
  const day = Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate()) - MSK_MS;
  return { start: day + WORK_START_HOUR * HOUR_MS, end: day + WORK_END_HOUR * HOUR_MS };
}

/** Start of the next working window at or after `t`. */
function nextWorkStart(t: number): number {
  for (let day = 0; day < 8; day++) {
    const w = windowOf(t + day * 24 * HOUR_MS);
    if (!w) continue;
    if (day === 0 && t >= w.end) continue;
    return Math.max(w.start, day === 0 ? t : w.start);
  }
  throw new Error("no working day within a week");
}

/** Deadline of a reply: `now` + 2 working hours (Mon–Fri 10–19 MSK). */
export function replyDeadline(now: Date, workMs = REPLY_WORKING_MS): Date {
  let t = now.getTime();
  let left = workMs;
  for (let i = 0; i < 16; i++) {
    t = nextWorkStart(t);
    const w = windowOf(t) as { start: number; end: number };
    if (t + left <= w.end) return new Date(t + left);
    left -= w.end - t;
    t = w.end;
  }
  throw new Error("reply deadline overflow");
}

const WEEKDAY_ACC = [
  "в воскресенье",
  "в понедельник",
  "во вторник",
  "в среду",
  "в четверг",
  "в пятницу",
  "в субботу",
];

/** «сегодня до 14:30», «завтра до 12:00», «в понедельник до 12:00» — Moscow time. */
export function deadlineRu(deadline: Date, now: Date): string {
  const d = new Date(deadline.getTime() + MSK_MS);
  const n = new Date(now.getTime() + MSK_MS);
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const dayN = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) / 86_400_000;
  const diff = dayN(d) - dayN(n);
  const when = diff === 0 ? "сегодня" : diff === 1 ? "завтра" : (WEEKDAY_ACC[d.getUTCDay()] as string);
  return `${when} до ${hhmm}`;
}

/** Confirmation shown to the client (D60: concrete term, working hours). */
export function confirmationRu(email: string, deadline: Date, now: Date): string {
  return `Сообщение отправлено. Ответим письмом на ${email} ${deadlineRu(deadline, now)} по московскому времени. Команда работает по будням с 10 до 19.`;
}

export interface SupportInput {
  orgId: string;
  userId: string;
  email: string;
  systemId: string | null;
  screen: string | null;
  text: string;
  wantsTeam: boolean;
}

export interface SupportDeps {
  db: Db;
  platformOrigin: string;
  alert?: OpsAlertFn | undefined;
  now: Date;
}

export interface SupportCreated {
  id: string;
  replyBy: Date;
  message_ru: string;
}

const RATE_LIMITED_RU =
  "Сообщений за последний час слишком много. Мы уже получили ваши обращения и ответим на них. Новое можно отправить через час.";

/**
 * Saves the copy, checks the limits and sends the founder the Telegram message (never throws on delivery). The limit
 * of a user counts their messages in every org; the check and the insert run in one transaction under transaction-level
 * advisory locks of the user and the org, so parallel requests cannot all pass the same count.
 */
export async function createSupportRequest(d: SupportDeps, i: SupportInput): Promise<SupportCreated> {
  const since = new Date(d.now.getTime() - HOUR_MS);
  const org = await d.db
    .selectFrom("platform.orgs")
    .select("name")
    .where("id", "=", i.orgId)
    .executeTakeFirst();
  if (!org) throw notFound("Организация");
  const system = i.systemId
    ? await d.db
        .selectFrom("platform.systems")
        .select(["id", "name"])
        .where("id", "=", i.systemId)
        .where("org_id", "=", i.orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst()
    : undefined;
  if (i.systemId && !system) throw notFound("Система");
  const replyBy = replyDeadline(d.now);
  const row = await d.db.transaction().execute(async (trx) => {
    // Always user, then org: one order, no deadlock. Released at commit or rollback.
    await sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`support:user:${i.userId}`}, 0))`.execute(
      trx,
    );
    await sql`select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`support:org:${i.orgId}`}, 0))`.execute(
      trx,
    );
    const recent = await trx
      .selectFrom("platform.support_requests")
      .select([
        sql<number>`count(*) filter (where user_id = ${i.userId})::int`.as("byUser"),
        sql<number>`count(*) filter (where org_id = ${i.orgId})::int`.as("byOrg"),
      ])
      .where((eb) => eb.or([eb("user_id", "=", i.userId), eb("org_id", "=", i.orgId)]))
      .where("created_at", ">", since)
      .executeTakeFirstOrThrow();
    if (Number(recent.byUser) >= SUPPORT_PER_USER_HOUR || Number(recent.byOrg) >= SUPPORT_PER_ORG_HOUR)
      throw new ApiError("RATE_LIMITED", RATE_LIMITED_RU);
    return trx
      .insertInto("platform.support_requests")
      .values({
        org_id: i.orgId,
        user_id: i.userId,
        system_id: system?.id ?? null,
        screen: i.screen,
        text: i.text,
        wants_team: i.wantsTeam,
        reply_by: replyBy,
        created_at: d.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  });
  await d.alert?.({
    level: "warn",
    event: "support_request",
    text: telegramText(d, {
      id: row.id,
      orgName: org.name,
      email: i.email,
      system: system ?? null,
      screen: i.screen,
      text: i.text,
      wantsTeam: i.wantsTeam,
      replyBy,
    }),
    fields: { kind: i.wantsTeam ? "wants_team" : "message" },
  });
  return { id: row.id, replyBy, message_ru: confirmationRu(i.email, replyBy, d.now) };
}

/**
 * The founder's Telegram message: org, client address (D68), system link, deadline and the text with personal data
 * patterns masked by @wizard/pii scrub (the full text stays in /admin).
 */
export function telegramText(
  d: Pick<SupportDeps, "platformOrigin" | "now">,
  m: {
    id: string;
    orgName: string;
    email: string;
    system: { id: string; name: string } | null;
    screen: string | null;
    text: string;
    wantsTeam: boolean;
    replyBy: Date;
  },
): string {
  // Single-line fields come from users (org and system names, address, screen): a line break there would forge
  // lines of the message («Система: …»), so it becomes a space.
  const line = (v: string) => v.replace(/[\r\n\u2028\u2029]+/g, " ");
  const masked = scrub(m.text).text;
  const body = masked.length > TELEGRAM_TEXT_MAX ? `${masked.slice(0, TELEGRAM_TEXT_MAX)}…` : masked;
  const msk = new Date(m.replyBy.getTime() + MSK_MS);
  const dd = (n: number) => String(n).padStart(2, "0");
  const due = `${dd(msk.getUTCDate())}.${dd(msk.getUTCMonth() + 1)} ${dd(msk.getUTCHours())}:${dd(msk.getUTCMinutes())} МСК`;
  return [
    m.wantsTeam ? "Написать команде · хочет, чтобы доделала команда" : "Написать команде",
    `Организация: ${line(m.orgName)}`,
    `Клиент: ${line(m.email)}`,
    m.system
      ? `Система: ${line(m.system.name)} — ${d.platformOrigin}/s/${m.system.id}`
      : "Система: не открыта",
    ...(m.screen ? [`Экран: ${line(m.screen)}`] : []),
    `Ответить письмом до ${due}`,
    "",
    body,
    "",
    `Все обращения: ${d.platformOrigin}/admin?tab=support`,
  ].join("\n");
}

export interface SupportRow {
  id: string;
  orgId: string;
  orgName: string;
  email: string | null;
  systemId: string | null;
  systemName: string | null;
  screen: string | null;
  text: string;
  wantsTeam: boolean;
  createdAt: Date;
  replyBy: Date;
  answeredAt: Date | null;
}

/** /admin «Обращения»: open first (oldest deadline first), then answered (newest first); at most `limit`. */
export async function listSupportRequests(
  db: Db,
  o: { status: "open" | "all"; limit?: number },
): Promise<SupportRow[]> {
  let q = db
    .selectFrom("platform.support_requests as s")
    .innerJoin("platform.orgs as o", "o.id", "s.org_id")
    .leftJoin("platform.users as u", "u.id", "s.user_id")
    .leftJoin("platform.systems as y", "y.id", "s.system_id")
    .select([
      "s.id",
      "s.org_id",
      "o.name as org_name",
      "u.email",
      "s.system_id",
      "y.name as system_name",
      "s.screen",
      "s.text",
      "s.wants_team",
      "s.created_at",
      "s.reply_by",
      "s.answered_at",
    ]);
  if (o.status === "open") q = q.where("s.answered_at", "is", null);
  const rows = await q
    .orderBy(sql`s.answered_at is not null`)
    .orderBy(sql`case when s.answered_at is null then s.reply_by end`)
    .orderBy("s.created_at", "desc")
    .limit(o.limit ?? 200)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    email: r.email ?? null,
    systemId: r.system_id,
    systemName: r.system_name ?? null,
    screen: r.screen,
    text: r.text,
    wantsTeam: r.wants_team,
    createdAt: new Date(r.created_at),
    replyBy: new Date(r.reply_by),
    answeredAt: r.answered_at ? new Date(r.answered_at) : null,
  }));
}

/** Marks a request answered (or open again); null — no such request. */
export async function markSupportAnswered(
  db: Db,
  o: { id: string; answered: boolean; by: string; now: Date },
): Promise<{ id: string; answeredAt: Date | null } | null> {
  const row = await db
    .updateTable("platform.support_requests")
    .set(o.answered ? { answered_at: o.now, answered_by: o.by } : { answered_at: null, answered_by: null })
    .where("id", "=", o.id)
    .returning(["id", "answered_at"])
    .executeTakeFirst();
  if (!row) return null;
  return { id: row.id, answeredAt: row.answered_at ? new Date(row.answered_at) : null };
}
