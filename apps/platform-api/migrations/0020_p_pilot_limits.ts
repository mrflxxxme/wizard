// Pilot limit of an organization (D70, M2-34 mvp_scope): 5 builds and 20 edits in a rolling 30 days, the founder raises
// them in /admin; NULL — the default of billing/pilot-limits.ts. Usage is counted from platform.runs (kind=build by
// mode), so only the overrides are stored. Index for the count. Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.orgs
    ADD COLUMN IF NOT EXISTS pilot_builds_limit integer CHECK (pilot_builds_limit BETWEEN 0 AND 1000),
    ADD COLUMN IF NOT EXISTS pilot_edits_limit integer CHECK (pilot_edits_limit BETWEEN 0 AND 1000)`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS runs_org_build_created_idx
    ON platform.runs (org_id, created_at) WHERE kind = 'build'`.execute(db);
}
