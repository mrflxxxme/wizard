// M1-07: platform.imports (db.yaml#tables.imports) — table import state; the source file itself is stored encrypted
// outside the database (src/imports/storage.ts). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES platform.systems ON DELETE CASCADE,
    source_sha text NOT NULL,
    profile jsonb,
    mapping jsonb,
    status text NOT NULL CHECK (status IN ('profiling','mapping','awaiting_confirm','importing','done','failed','expired')),
    rows_imported integer,
    expires_at timestamptz NOT NULL,
    created_by uuid NOT NULL REFERENCES platform.users,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX imports_system_created_idx ON platform.imports (system_id, created_at DESC)`,
  `CREATE INDEX imports_expires_idx ON platform.imports (expires_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
