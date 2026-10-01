// M2-05: platform.deletion_log (db.yaml#tables.deletion_log) — journal of personal-data erasure in systems, counters
// only (security/compliance.yaml#system_package.retention.deletion_log). No FK to systems: the journal outlives the
// purge of a deleted system (workflows.yaml#delete_system). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.deletion_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    system_id uuid NOT NULL,
    env text NOT NULL CHECK (env IN ('draft','prod')),
    entity text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('delete','anonymize','retention','subject_request','draft_purged','system_deleted','user_deleted','consent_revoked')),
    cutoff timestamptz,
    rows_affected integer NOT NULL,
    run_id uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX deletion_log_system_created_idx ON platform.deletion_log (system_id, created_at DESC)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
