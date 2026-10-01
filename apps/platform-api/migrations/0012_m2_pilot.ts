// M2-15 pilot mode (product.yaml#decisions.D24_pilot_free, billing.yaml#plans.pilot): plan «pilot» in orgs.plan,
// founder invitations of the invite-only registration (db.yaml#tables.pilot_invites) and once-per-period founder
// alerts (db.yaml#tables.ops_alerts: the 80 % / 100 % platform LLM cap of the month). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `ALTER TABLE platform.orgs DROP CONSTRAINT IF EXISTS orgs_plan_check`,
  `ALTER TABLE platform.orgs ADD CONSTRAINT orgs_plan_check CHECK (plan IN ('free','pilot','start','business'))`,
  `CREATE TABLE platform.pilot_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL CHECK (email = lower(email)),
    org_name text,
    credits integer NOT NULL DEFAULT 0 CHECK (credits >= 0),
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    accepted_user_id uuid REFERENCES platform.users,
    org_id uuid REFERENCES platform.orgs,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX pilot_invites_active_idx ON platform.pilot_invites (email)
    WHERE accepted_at IS NULL AND revoked_at IS NULL`,
  `CREATE TABLE platform.ops_alerts (
    key text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
