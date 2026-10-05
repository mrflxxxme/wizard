// M2-50 (D69): emails of the org owners of each system for notify `$owner` — the runtime reads this view (as it
// reads platform.deployments) to deliver «новая заявка» to an owner who has no account in the system itself.
// Deleted users and systems are left out. Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE OR REPLACE VIEW platform.system_owner_emails AS
    SELECT s.schema_key AS system_id, u.email
      FROM platform.systems s
      JOIN platform.memberships m ON m.org_id = s.org_id AND m.role = 'owner'
      JOIN platform.users u ON u.id = m.user_id
     WHERE s.deleted_at IS NULL AND u.deleted_at IS NULL`.execute(db);
}
