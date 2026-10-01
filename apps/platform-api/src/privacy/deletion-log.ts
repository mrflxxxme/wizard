// Platform side of the deletion journal (workflows.yaml#retention_cron, security/compliance.yaml#system_package.retention
// .deletion_log): rows of app_<key>_<env>._w_deletion_log written by the runtime (retention, consent withdrawal,
// subject requests) move into platform.deletion_log in one transaction; owners hear about consent withdrawals.
import { quoteIdent, SYSTEM_ROLE } from "@wizard/appspec";
import { schemaName } from "@wizard/runtime";
import type postgres from "postgres";
import { MIGRATOR_ROLE } from "../agents/draft.js";
import type { Mailer } from "../auth/mailer.js";
import type { Db } from "../db/index.js";

export type SystemEnv = "draft" | "prod";
export const ENVS: readonly SystemEnv[] = ["draft", "prod"];

export interface MovedEntry {
  systemId: string;
  env: SystemEnv;
  entity: string;
  mode: string;
  rows: number;
}

interface JournalRow {
  at: Date;
  entity: string;
  mode: string;
  cutoff: Date | null;
  rows_affected: number;
}

/** Schemas app_<key>_<env> that have a _w_deletion_log table, mapped to their system. */
async function journalSchemas(
  pg: postgres.Sql,
  systemId?: string,
): Promise<{ systemId: string; env: SystemEnv; schema: string }[]> {
  const systems = systemId
    ? await pg<{ id: string; schema_key: string }[]>`
        select id, schema_key from platform.systems where id = ${systemId}`
    : await pg<{ id: string; schema_key: string }[]>`select id, schema_key from platform.systems`;
  const bySchema = new Map<string, { systemId: string; env: SystemEnv }>();
  for (const s of systems)
    for (const env of ENVS) bySchema.set(schemaName(s.schema_key, env), { systemId: s.id, env });
  const rows = await pg<{ nspname: string }[]>`
    select n.nspname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.relname = '_w_deletion_log' and c.relkind = 'r' and n.nspname like 'app\\_%'`;
  return rows.flatMap((r) => {
    const s = bySchema.get(r.nspname);
    return s ? [{ ...s, schema: r.nspname }] : [];
  });
}

/** Moves the journal of one schema (counters only) into platform.deletion_log; returns the moved entries. */
export async function moveJournal(
  pg: postgres.Sql,
  t: { systemId: string; env: SystemEnv; schema: string },
  migratorRole = MIGRATOR_ROLE,
): Promise<MovedEntry[]> {
  return pg.begin(async (tx) => {
    // The schema owner under the context role __system (FORCE RLS, runtime.yaml#postgres.context).
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(migratorRole)}`);
    await tx.unsafe("select set_config('wizard.role', $1, true)", [SYSTEM_ROLE]);
    const rows = (await tx.unsafe(
      `delete from ${quoteIdent(t.schema)}."_w_deletion_log" returning at, entity, mode, cutoff, rows_affected`,
    )) as unknown as JournalRow[];
    await tx.unsafe("SET LOCAL ROLE NONE");
    const out: MovedEntry[] = [];
    for (const r of [...rows].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())) {
      await tx`
        insert into platform.deletion_log (system_id, env, entity, mode, cutoff, rows_affected, created_at)
        values (${t.systemId}, ${t.env}, ${r.entity}, ${r.mode}, ${r.cutoff}, ${r.rows_affected}, ${r.at})`;
      out.push({ systemId: t.systemId, env: t.env, entity: r.entity, mode: r.mode, rows: r.rows_affected });
    }
    return out;
  });
}

export interface CollectOptions {
  migratorRole?: string;
  /** Only this system (delete_system moves its journal before dropping the schemas). */
  systemId?: string;
  log?: (msg: string, err?: unknown) => void;
}

/** One pass over every system schema with a journal; a failing schema is logged and retried next pass. */
export async function collectDeletionLogs(pg: postgres.Sql, o: CollectOptions = {}): Promise<MovedEntry[]> {
  const out: MovedEntry[] = [];
  for (const t of await journalSchemas(pg, o.systemId)) {
    try {
      out.push(...(await moveJournal(pg, t, o.migratorRole)));
    } catch (e) {
      // e.g. the schema was dropped concurrently (G1 ephemeral, delete_system).
      o.log?.("deletion_log transfer failed", e);
    }
  }
  return out;
}

/**
 * compliance.yaml#consent.withdrawal «событие владельцу системы»: a letter to every owner of the org per system whose
 * journal brought consent_revoked rows. Counters only — no data of the end user.
 */
export async function notifyConsentWithdrawals(
  db: Db,
  mailer: Mailer,
  moved: readonly MovedEntry[],
  log?: (msg: string, err?: unknown) => void,
): Promise<number> {
  const bySystem = new Map<string, { users: number; rows: number }>();
  for (const m of moved) {
    if (m.mode !== "consent_revoked") continue;
    const cur = bySystem.get(m.systemId) ?? { users: 0, rows: 0 };
    if (m.entity === "users") cur.users += m.rows;
    cur.rows += m.rows;
    bySystem.set(m.systemId, cur);
  }
  let sent = 0;
  for (const [systemId, n] of bySystem) {
    const sys = await db
      .selectFrom("platform.systems")
      .select(["name", "org_id"])
      .where("id", "=", systemId)
      .executeTakeFirst();
    if (!sys) continue;
    const owners = await db
      .selectFrom("platform.memberships as m")
      .innerJoin("platform.users as u", "u.id", "m.user_id")
      .select("u.email")
      .where("m.org_id", "=", sys.org_id)
      .where("m.role", "=", "owner")
      .where("u.deleted_at", "is", null)
      .execute();
    const who = n.users > 1 ? `Пользователи системы (${n.users}) отозвали` : "Пользователь системы отозвал";
    for (const o of owners) {
      try {
        await mailer.send({
          kind: "notice",
          to: o.email,
          subject: `Отзыв согласия на обработку персональных данных — «${sys.name}»`,
          text: `${who} согласие на обработку персональных данных в системе «${sys.name}». Вход для них закрыт, их данные обезличены (записей: ${n.rows}). Подробности — в журнале удалений в настройках системы (раздел «Персональные данные»).`,
        });
        sent++;
      } catch (e) {
        log?.("consent withdrawal notice failed", e);
      }
    }
  }
  return sent;
}
