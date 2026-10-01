// M2-05: systems.draft_purge_notice_at — when the owner of an inactive Free draft was warned that its test data will be
// purged (F5, workflows.yaml#retention_cron «за 7 дней письмо владельцу»). Not in db.yaml yet: justified in
// docs/reviews/impl-notes/M2-05.md. The purge waits ≥ 7 days after a notice newer than the last activity. Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.systems ADD COLUMN IF NOT EXISTS draft_purge_notice_at timestamptz`.execute(
    db,
  );
}
