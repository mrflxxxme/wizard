// M2-09 (product.yaml#decisions.D24_pilot_free, backlog M2-09 acceptance «флаг beta_readiness»): platform switches set
// by the founder's CLI with who/when (db.yaml#tables.platform_settings) — beta_readiness gates partner invitations
// until M2-13 (lawyer, RKN notification) is done. Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.platform_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
