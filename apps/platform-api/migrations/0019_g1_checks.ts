// QA scenarios of a passed G1 (db.yaml#g1_checks): the publish G1 of a revision without its own G1 (a compliance edit
// on top of a build) reuses them per AC while the AC text is unchanged (runs/g1-checks.ts). Without them every system
// whose card ACs have no inline steps failed G1-AC-COVER at publish — found by the local rehearsal of the pilot
// (docs/ops/local-rehearsal.md). Rows go with their revision. Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.g1_checks (
    system_id uuid NOT NULL,
    revision integer NOT NULL,
    run_id uuid NOT NULL REFERENCES platform.runs(id) ON DELETE CASCADE,
    checks jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, revision),
    FOREIGN KEY (system_id, revision) REFERENCES platform.revisions (system_id, version) ON DELETE CASCADE
  )`.execute(db);
}
