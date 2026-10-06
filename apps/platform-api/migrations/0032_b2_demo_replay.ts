// Demo replay of staff orgs (B2-02; product.yaml#decisions.D76_beta_v2, docs/reviews/grill-6.md № 12): orgs.demo_replay
// — runs of a staff org replay recorded model answers for free (runs/demo-replay.ts); systems.demo_scenario — the
// recorded scenario (tools/fixtures/demo/<name>.jsonl) the system was created from in that mode. Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.orgs ADD COLUMN IF NOT EXISTS demo_replay boolean NOT NULL DEFAULT false`.execute(
    db,
  );
  await sql`ALTER TABLE platform.systems ADD COLUMN IF NOT EXISTS demo_scenario text
    CHECK (demo_scenario ~ '^[a-z][a-z0-9_-]{0,39}$')`.execute(db);
}
