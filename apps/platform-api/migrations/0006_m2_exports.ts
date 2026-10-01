// M2-10: platform.exports (db.yaml#tables.exports) — data exports and their journal; the ZIP itself is stored
// encrypted outside the database (src/exports/storage.ts). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.exports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES platform.systems ON DELETE CASCADE,
    env text NOT NULL CHECK (env IN ('draft','prod')),
    run_id uuid REFERENCES platform.runs,
    status text NOT NULL CHECK (status IN ('running','ready','failed','expired')),
    storage_key text,
    size bigint,
    download_token_hash text,
    download_token_expires_at timestamptz,
    downloads integer NOT NULL DEFAULT 0,
    expires_at timestamptz NOT NULL,
    created_by uuid NOT NULL REFERENCES platform.users,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX exports_system_created_idx ON platform.exports (system_id, created_at DESC)`,
  `CREATE INDEX exports_expires_idx ON platform.exports (expires_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
