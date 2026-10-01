// Staff console «Пилот» (docs/reviews/impl-notes/pilot-admin.md): the founder-review flag chosen at the invitation
// (db.yaml#pilot_invites.require_founder_review, default true as before) is applied to the pilot org at acceptance.
// Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.pilot_invites ADD COLUMN IF NOT EXISTS require_founder_review boolean NOT NULL DEFAULT true`.execute(
    db,
  );
}
