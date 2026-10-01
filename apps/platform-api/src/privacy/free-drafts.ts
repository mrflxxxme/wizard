// F5 (product.yaml#decisions, billing.yaml#plans.free.inactive_drafts, workflows.yaml#retention_cron): a system of a Free
// org without activity for 60 days loses only its test schema app_<key>_draft — the owner is warned 7 days before;
// spec, code, revisions and prod stay; the next build recreates the schema (migrate_draft on a missing schema).
import { quoteIdent, SYSTEM_ROLE } from "@wizard/appspec";
import { schemaName } from "@wizard/runtime";
import type postgres from "postgres";
import { MIGRATOR_ROLE } from "../agents/draft.js";
import type { Mailer } from "../auth/mailer.js";
import type { Db } from "../db/index.js";
import { collectDeletionLogs } from "./deletion-log.js";

const DAY_MS = 86_400_000;
/** Inactivity before the purge (F5). */
export const FREE_DRAFT_INACTIVE_DAYS = 60;
/** The warning goes out this many days before the purge. */
export const FREE_DRAFT_NOTICE_DAYS = 7;

export interface FreeDraftDeps {
  db: Db;
  pg: postgres.Sql;
  mailer?: Mailer;
  migratorRole?: string;
  log?: (msg: string, err?: unknown) => void;
  /** Platform URL for the link in the letter (config.platformOrigin). */
  platformOrigin?: string;
}

export interface FreeDraftReport {
  /** Systems whose owners were warned in this pass. */
  noticed: string[];
  /** Systems whose draft schema was dropped. */
  purged: { systemId: string; rows: number }[];
}

const fmtDate = (d: Date) =>
  d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });

async function draftExists(pg: postgres.Sql, schemaKey: string): Promise<boolean> {
  const rows =
    await pg`select 1 from pg_catalog.pg_namespace where nspname = ${schemaName(schemaKey, "draft")}`;
  return rows.length > 0;
}

/** Free systems inactive since `before` whose draft data were not purged after their last activity. */
function inactiveFree(db: Db, before: Date) {
  return db
    .selectFrom("platform.systems as s")
    .innerJoin("platform.orgs as o", "o.id", "s.org_id")
    .select(["s.id", "s.org_id", "s.name", "s.schema_key", "s.last_activity_at", "s.draft_purge_notice_at"])
    .where("o.plan", "=", "free")
    .where("s.deleted_at", "is", null)
    .where("s.last_activity_at", "<=", before)
    .where((eb) =>
      eb.or([
        eb("s.draft_data_purged_at", "is", null),
        eb("s.draft_data_purged_at", "<", eb.ref("s.last_activity_at")),
      ]),
    )
    .orderBy("s.last_activity_at")
    .limit(200)
    .execute();
}

async function ownerEmails(db: Db, orgId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("platform.memberships as m")
    .innerJoin("platform.users as u", "u.id", "m.user_id")
    .select("u.email")
    .where("m.org_id", "=", orgId)
    .where("m.role", "=", "owner")
    .where("u.deleted_at", "is", null)
    .execute();
  return rows.map((r) => r.email);
}

/** One F5 pass: warnings at 53 days of inactivity, purges ≥ 7 days after a warning newer than the last activity. */
export async function purgeInactiveFreeDrafts(d: FreeDraftDeps, now = new Date()): Promise<FreeDraftReport> {
  const out: FreeDraftReport = { noticed: [], purged: [] };
  const noticeBefore = new Date(now.getTime() - (FREE_DRAFT_INACTIVE_DAYS - FREE_DRAFT_NOTICE_DAYS) * DAY_MS);
  const purgeBefore = new Date(now.getTime() - FREE_DRAFT_INACTIVE_DAYS * DAY_MS);
  const role = d.migratorRole ?? MIGRATOR_ROLE;

  for (const s of await inactiveFree(d.db, noticeBefore)) {
    try {
      if (!(await draftExists(d.pg, s.schema_key))) continue;
      const lastActivity = new Date(s.last_activity_at);
      const notice = s.draft_purge_notice_at ? new Date(s.draft_purge_notice_at) : null;
      const warned = notice !== null && notice.getTime() >= lastActivity.getTime();
      if (!warned) {
        // The warning of this inactivity period; the purge waits at least 7 days after it.
        const purgeAt = new Date(
          Math.max(
            lastActivity.getTime() + FREE_DRAFT_INACTIVE_DAYS * DAY_MS,
            now.getTime() + FREE_DRAFT_NOTICE_DAYS * DAY_MS,
          ),
        );
        const link = d.platformOrigin ? ` ${d.platformOrigin}/s/${s.id}` : "";
        for (const to of await ownerEmails(d.db, s.org_id))
          await d.mailer?.send({
            kind: "notice",
            to,
            subject: `Тестовые данные черновика «${s.name}» будут удалены ${fmtDate(purgeAt)}`,
            text: `В системе «${s.name}» не было активности с ${fmtDate(lastActivity)}. На тарифе Free тестовая база черновика неактивной системы очищается через ${FREE_DRAFT_INACTIVE_DAYS} дней: ${fmtDate(purgeAt)} тестовые данные черновика будут удалены. Спека, код, ревизии и опубликованная версия сохранятся, следующая сборка создаст тестовую базу заново. Чтобы данные остались, продолжите работу с системой (сообщение или сборка) или перейдите на платный тариф.${link}`,
          });
        await d.db
          .updateTable("platform.systems")
          .set({ draft_purge_notice_at: now })
          .where("id", "=", s.id)
          .execute();
        out.noticed.push(s.id);
        continue;
      }
      if (lastActivity.getTime() > purgeBefore.getTime()) continue;
      if ((notice?.getTime() ?? now.getTime()) > now.getTime() - FREE_DRAFT_NOTICE_DAYS * DAY_MS) continue;

      // The runtime journal of the draft first: it is the record of what was erased before.
      await collectDeletionLogs(d.pg, {
        systemId: s.id,
        migratorRole: role,
        ...(d.log ? { log: d.log } : {}),
      });
      const schema = schemaName(s.schema_key, "draft");
      const rows = await d.pg.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`);
        await tx.unsafe("select set_config('wizard.role', $1, true)", [SYSTEM_ROLE]);
        const tables = await tx<{ tablename: string }[]>`
          select tablename from pg_catalog.pg_tables where schemaname = ${schema} and tablename not like '\\_w\\_%'`;
        let n = 0;
        for (const t of tables) {
          const [r] = await tx.unsafe(
            `select count(*)::int as n from ${quoteIdent(schema)}.${quoteIdent(t.tablename)}`,
          );
          n += Number((r as { n?: number } | undefined)?.n ?? 0);
        }
        await tx.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
        await tx.unsafe("SET LOCAL ROLE NONE");
        await tx`update platform.systems set draft_data_purged_at = ${now} where id = ${s.id}`;
        await tx`
          insert into platform.deletion_log (system_id, env, entity, mode, cutoff, rows_affected)
          values (${s.id}, 'draft', '*', 'draft_purged', ${purgeBefore}, ${n})`;
        return n;
      });
      out.purged.push({ systemId: s.id, rows });
    } catch (e) {
      d.log?.("free draft purge failed", e);
    }
  }
  return out;
}
