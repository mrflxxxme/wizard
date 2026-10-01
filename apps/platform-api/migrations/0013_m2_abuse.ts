// M2-08: complaints and takedown (db.yaml#tables.abuse_reports, security/abuse.yaml#report, #takedown), the staff
// journal (db.yaml#tables.staff_audit_log, compliance.yaml#platform.security_org) and staff MFA state
// (users.totp_last_step — replay guard of RFC 6238 codes, users.mfa_recovery_hashes — hashed recovery codes,
// sessions.mfa_verified_at — step-up of the session, api.yaml#info.x-auth.M2). Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.abuse_reports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid REFERENCES platform.systems,
    publication_id uuid REFERENCES platform.publications,
    url text NOT NULL,
    category text NOT NULL CHECK (category IN ('phishing','fraud','brand_impersonation','illegal_content','pd_violation','spam','other','auto_g2')),
    text text,
    contact_email text,
    reporter_ip_hash text,
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','triaged','takedown','dismissed','restored')),
    sla_deadline timestamptz NOT NULL,
    assignee uuid REFERENCES platform.users,
    resolution_note text,
    resolved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX abuse_reports_status_sla_idx ON platform.abuse_reports (status, sla_deadline)`,
  `CREATE INDEX abuse_reports_system_idx ON platform.abuse_reports (system_id)`,
  `CREATE INDEX abuse_reports_ip_created_idx ON platform.abuse_reports (reporter_ip_hash, created_at)`,
  `CREATE TABLE platform.staff_audit_log (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor uuid NOT NULL REFERENCES platform.users,
    action text NOT NULL,
    target text NOT NULL,
    note text,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX staff_audit_log_target_idx ON platform.staff_audit_log (target, created_at DESC)`,
  `CREATE INDEX staff_audit_log_actor_idx ON platform.staff_audit_log (actor, action, created_at DESC)`,
  `ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS totp_last_step bigint`,
  `ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS mfa_recovery_hashes jsonb`,
  `ALTER TABLE platform.sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
