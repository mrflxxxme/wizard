// «Написать команде» (D68, M2-35 mvp_scope): a copy of every client message for /admin (the founder answers by letter;
// no conversation in the cabinet). Rows go with the org (retention of the org's data); the author's address is read
// from platform.users, not copied. Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.support_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    user_id uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    system_id uuid REFERENCES platform.systems(id) ON DELETE SET NULL,
    screen text CHECK (length(screen) <= 64),
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
    wants_team boolean NOT NULL DEFAULT false,
    reply_by timestamptz NOT NULL,
    answered_at timestamptz,
    answered_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS support_requests_created_idx
    ON platform.support_requests (created_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS support_requests_org_created_idx
    ON platform.support_requests (org_id, created_at)`.execute(db);
}
