// M1-02 tables of specs/platform/db.yaml: auth_otps, sessions, invites. Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.auth_otps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL,
    code_hash text NOT NULL,
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts <= 5),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    ip_hash text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX auth_otps_email_created_idx ON platform.auth_otps (email, created_at DESC)`,
  // Not in db.yaml: the per-IP rate limit (api.yaml#requestOtp) counts rows by ip_hash.
  `CREATE INDEX auth_otps_ip_created_idx ON platform.auth_otps (ip_hash, created_at DESC)`,
  `CREATE TABLE platform.sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES platform.users ON DELETE CASCADE,
    token_hash text NOT NULL,
    csrf_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)
  )`,
  `CREATE INDEX sessions_user_id_idx ON platform.sessions (user_id)`,
  `CREATE TABLE platform.invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs ON DELETE CASCADE,
    email text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
    token_hash text NOT NULL,
    invited_by uuid NOT NULL REFERENCES platform.users,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT invites_token_hash_key UNIQUE (token_hash)
  )`,
  `CREATE INDEX invites_org_active_idx ON platform.invites (org_id) WHERE accepted_at IS NULL AND revoked_at IS NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
