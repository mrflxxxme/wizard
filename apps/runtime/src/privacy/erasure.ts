// Erasure of personal data inside a system schema and the deletion journal _w_deletion_log (counters only):
// consent withdrawal (security/compliance.yaml#system_package.consent.withdrawal, L3-33), retention of end users
// (#retention.users) and subject requests (#subject_requests). The platform moves the journal into
// platform.deletion_log (workflows.yaml#retention_cron).
import {
  type Entity,
  type Field,
  isFileFieldType,
  quoteIdent,
  SYSTEM_ROLE,
  textLiteral,
} from "@wizard/appspec";
import type postgres from "postgres";
import { SYSTEM_SUBJECT } from "../data/access.js";
import type { LoadedSystem } from "../system.js";
import { piiFieldsOf, USERS_RETENTION_DAYS } from "./policy.js";

type Tx = postgres.TransactionSql;

export type DeletionMode = "delete" | "anonymize" | "retention" | "consent_revoked" | "subject_request";

export interface DeletionEntry {
  entity: string;
  mode: DeletionMode;
  rows: number;
  cutoff?: Date | null;
  /** Anonymized fields (names, never values); empty for delete. */
  fields?: string[];
  /** fileIds of file fields this erasure cleared (their objects are deleted after the commit; never journaled). */
  files?: string[];
}

/** Deletes the objects of erased file fields after the commit (runtime.yaml#files.pii_and_retention). */
export async function releaseErasedFiles(
  sys: LoadedSystem,
  entries: readonly DeletionEntry[],
): Promise<void> {
  const ids = entries.flatMap((e) => e.files ?? []);
  // A storage failure leaves the objects unreferenced: the sweep of the next retention pass deletes them.
  if (ids.length && sys.files) await sys.files.release(ids).catch(() => 0);
}

const withoutFiles = (e: DeletionEntry): DeletionEntry => {
  const { files: _f, ...rest } = e;
  return rest;
};

/** Maximum delay between withdrawal and anonymization (ст. 21 ч. 5 152-ФЗ). */
export const MAX_WITHDRAWAL_DAYS = 30;
const DAY_MS = 86_400_000;
const USER_PII = ["email", "phone", "telegram_id", "telegram_chat_id", "display_name"] as const;

const T = (schema: string, table: string) => `${quoteIdent(schema)}.${quoteIdent(table)}`;

/** Journal rows with rows > 0 (same transaction as the erasure). */
export async function logDeletions(
  tx: Tx,
  schema: string,
  entries: readonly DeletionEntry[],
  at?: Date,
): Promise<void> {
  for (const d of entries) {
    if (d.rows <= 0) continue;
    await tx.unsafe(
      `insert into ${T(schema, "_w_deletion_log")} (at, entity, mode, cutoff, rows_affected, fields)
       values (coalesce($1::timestamptz, now()), $2, $3, $4::timestamptz, $5, string_to_array($6::text, ','))`,
      [
        at?.toISOString() ?? null,
        d.entity,
        d.mode,
        d.cutoff?.toISOString() ?? null,
        d.rows,
        (d.fields ?? []).join(","),
      ],
    );
  }
}

/** Placeholder for NOT NULL pii columns that satisfies the format checks of appspec (FORMAT_RE). */
function placeholder(f: Field): string | null {
  switch (f.type) {
    case "string":
    case "text":
      return "Удалено";
    case "email":
      return "deleted@anonymized.invalid";
    case "phone":
      return "+70000000000";
    default:
      return null;
  }
}

/**
 * pii fields of rows matching `where` → NULL (NOT NULL columns → placeholders). Only rows that still hold data are
 * counted. A failure (constraints) rolls back to a savepoint and returns null.
 */
export async function anonymizeRows(
  tx: Tx,
  schema: string,
  e: Entity,
  where: string,
  params: readonly unknown[],
): Promise<{ rows: number; fields: string[]; files: string[] } | null> {
  const pii = piiFieldsOf(e);
  if (pii.length === 0) return { rows: 0, fields: [], files: [] };
  const cols = await tx.unsafe<{ column_name: string; is_nullable: string }[]>(
    `select column_name, is_nullable from information_schema.columns where table_schema = $1 and table_name = $2`,
    [schema, e.name],
  );
  const nullable = new Map(cols.map((c) => [c.column_name, c.is_nullable === "YES"]));
  const sets: string[] = [];
  const changed: string[] = [];
  const fields: string[] = [];
  for (const f of pii) {
    if (!nullable.has(f.name)) continue;
    const col = quoteIdent(f.name);
    if (nullable.get(f.name)) {
      sets.push(`${col} = null`);
      changed.push(`${col} is not null`);
    } else {
      const v = placeholder(f);
      if (v === null) continue;
      sets.push(`${col} = ${textLiteral(v)}`);
      changed.push(`${col}::text is distinct from ${textLiteral(v)}`);
    }
    fields.push(f.name);
  }
  if (sets.length === 0) return { rows: 0, fields: [], files: [] };
  const fileCols = pii.filter((f) => isFileFieldType(f.type) && nullable.get(f.name)).map((f) => f.name);
  try {
    return await tx.savepoint(async (sp) => {
      const held = fileCols.length
        ? await sp.unsafe(
            `select ${fileCols.map(quoteIdent).join(", ")} from ${T(schema, e.name)} where (${where}) and (${changed.join(" or ")})`,
            params as never[],
          )
        : [];
      const res = await sp.unsafe(
        `update ${T(schema, e.name)} set ${sets.join(", ")} where (${where}) and (${changed.join(" or ")})`,
        params as never[],
      );
      const files = held.flatMap((r) =>
        fileCols.map((c) => r[c]).filter((v): v is string => typeof v === "string"),
      );
      return { rows: res.count, fields, files };
    });
  } catch {
    return null;
  }
}

/** Contacts of `users` → NULL; `block` also closes the login. Sessions and Telegram links are removed. */
export async function anonymizeUsers(tx: Tx, schema: string, ids: readonly string[], block: boolean) {
  if (ids.length === 0) return 0;
  await tx.unsafe(`delete from ${T(schema, "_w_sessions")} where user_id = any($1::uuid[])`, [ids as never]);
  await tx.unsafe(`delete from ${T(schema, "_w_telegram_links")} where user_id = any($1::uuid[])`, [
    ids as never,
  ]);
  const res = await tx.unsafe(
    `update ${T(schema, "users")} set ${USER_PII.map((c) => `${quoteIdent(c)} = null`).join(", ")},
       attrs = '{}'::jsonb${block ? ", blocked_at = coalesce(blocked_at, now())" : ""}
     where id = any($1::uuid[]) and (${USER_PII.map((c) => `${quoteIdent(c)} is not null`).join(" or ")}
       or attrs <> '{}'::jsonb)`,
    [ids as never],
  );
  return res.count;
}

/** The user's login data and pii of rows where the user is the ownerField. */
async function eraseUser(tx: Tx, sys: LoadedSystem, userId: string, mode: DeletionMode) {
  const entries: DeletionEntry[] = [];
  const pending: string[] = [];
  entries.push({
    entity: "users",
    mode,
    rows: await anonymizeUsers(tx, sys.schema, [userId], true),
    fields: [...USER_PII],
  });
  for (const e of sys.spec.entities) {
    if (!e.ownerField) continue;
    const r = await anonymizeRows(tx, sys.schema, e, `${quoteIdent(e.ownerField)} = $1::uuid`, [userId]);
    if (r === null) pending.push(e.name);
    else entries.push({ entity: e.name, mode, rows: r.rows, fields: r.fields, files: r.files });
  }
  await logDeletions(tx, sys.schema, entries);
  return { entries, pending };
}

export interface RevokeResult {
  /** Anonymized now (withdrawalDays = 0); empty when scheduled. */
  entities: { entity: string; rows: number }[];
  /** Entities that could not be anonymized (constraints): retried by the job. */
  pending: string[];
  /** When anonymization runs (null — done at once). */
  scheduledAt: string | null;
}

/**
 * Consent withdrawal: sessions are revoked and the login is blocked at once; the data is anonymized at once
 * (withdrawalDays = 0) or by a _w_jobs task (kind retention) after `withdrawalDays` (≤ 30).
 */
export async function revokeConsent(
  sys: LoadedSystem,
  userId: string,
  o: { withdrawalDays?: number; now?: Date } = {},
): Promise<RevokeResult> {
  const days = Math.min(MAX_WITHDRAWAL_DAYS, Math.max(0, Math.floor(o.withdrawalDays ?? 0)));
  const now = o.now ?? new Date();
  let erased: DeletionEntry[] = [];
  const result = await sys.data.transaction("default", SYSTEM_SUBJECT, async (d) => {
    const tx = d.sql;
    const s = sys.schema;
    await tx.unsafe(`delete from ${T(s, "_w_sessions")} where user_id = $1`, [userId]);
    await tx.unsafe(`delete from ${T(s, "_w_telegram_links")} where user_id = $1`, [userId]);
    await tx.unsafe(`update ${T(s, "users")} set blocked_at = coalesce(blocked_at, now()) where id = $1`, [
      userId,
    ]);
    const out: RevokeResult = { entities: [], pending: [], scheduledAt: null };
    let job = days > 0;
    if (!job) {
      const r = await eraseUser(tx, sys, userId, "consent_revoked");
      erased = r.entries;
      out.entities = r.entries.map((x) => ({ entity: x.entity, rows: x.rows }));
      out.pending = r.pending;
      job = r.pending.length > 0;
    }
    if (job) {
      const at = new Date(now.getTime() + days * DAY_MS);
      out.scheduledAt = at.toISOString();
      await tx.unsafe(
        `insert into ${T(s, "_w_jobs")} (kind, payload, run_at, idempotency_key)
         values ('retention', cast($1::text as jsonb), $2::timestamptz, $3)
         on conflict (idempotency_key) do nothing`,
        [JSON.stringify({ task: "consent_revoked", userId }), at.toISOString(), `consent_revoked:${userId}`],
      );
    }
    await tx.unsafe(
      `insert into ${T(s, "_w_audit")} (actor_user_id, role, entity, record_id, op, fields)
       values ($1, $2, 'users', $1, $3, string_to_array($4::text, ','))`,
      [
        userId,
        SYSTEM_ROLE,
        out.pending.length ? "consent_revoked_pending" : "consent_revoked",
        out.pending.join(","),
      ],
    );
    return out;
  });
  await releaseErasedFiles(sys, erased);
  return result;
}

/** Due consent-withdrawal tasks (_w_jobs kind retention); returns journal entries of this pass. */
export async function runDueErasures(sys: LoadedSystem, now: Date): Promise<DeletionEntry[]> {
  const all = await sys.data.transaction("default", SYSTEM_SUBJECT, async (d) => {
    const tx = d.sql;
    const s = sys.schema;
    const jobs = await tx.unsafe(
      `select id::text as id, payload from ${T(s, "_w_jobs")}
       where kind = 'retention' and run_at <= $1::timestamptz and locked_until is null
         and payload->>'task' = 'consent_revoked'
       order by run_at, id limit 100 for update skip locked`,
      [now.toISOString()],
    );
    const all: DeletionEntry[] = [];
    for (const j of jobs) {
      const userId = String((j.payload as Record<string, unknown>).userId ?? "");
      const r = await eraseUser(tx, sys, userId, "consent_revoked");
      all.push(...r.entries);
      if (r.pending.length) {
        // Retried next day; the 30-day bound is watched by the platform (retention_cron alert).
        await tx.unsafe(
          `update ${T(s, "_w_jobs")} set attempts = attempts + 1, run_at = $2::timestamptz,
           payload = payload || cast($3::text as jsonb) where id = $1::uuid`,
          [j.id, new Date(now.getTime() + DAY_MS).toISOString(), JSON.stringify({ pending: r.pending })],
        );
      } else {
        await tx.unsafe(
          `update ${T(s, "_w_jobs")} set locked_until = 'infinity',
           payload = payload || cast($2::text as jsonb) where id = $1::uuid`,
          [j.id, JSON.stringify({ state: "done" })],
        );
      }
    }
    return all;
  });
  await releaseErasedFiles(sys, all);
  return all.map(withoutFiles);
}

/** compliance.yaml#retention.users: no login for 3 years → contacts anonymized (journal mode retention). */
export async function retainUsers(sys: LoadedSystem, now: Date): Promise<DeletionEntry> {
  const cutoff = new Date(now.getTime() - USERS_RETENTION_DAYS * DAY_MS);
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (d) => {
    const tx = d.sql;
    const s = sys.schema;
    const rows = await tx.unsafe(
      `select id::text as id from ${T(s, "users")}
       where coalesce(last_login_at, created_at) < $1::timestamptz
         and (${USER_PII.map((c) => `${quoteIdent(c)} is not null`).join(" or ")})`,
      [cutoff.toISOString()],
    );
    const entry: DeletionEntry = {
      entity: "users",
      mode: "retention",
      cutoff,
      rows: await anonymizeUsers(
        tx,
        s,
        rows.map((r) => String(r.id)),
        false,
      ),
      fields: [...USER_PII],
    };
    if (entry.rows > 0) {
      await logDeletions(tx, s, [entry], now);
      await tx.unsafe(
        `insert into ${T(s, "_w_audit")} (role, entity, op, fields) values ($1, 'users', 'retention', $2::text[])`,
        [SYSTEM_ROLE, [...USER_PII] as never],
      );
    }
    return entry;
  });
}
