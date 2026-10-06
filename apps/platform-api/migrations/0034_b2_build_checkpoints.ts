// Stage checkpoints of the builder v2 (B2-21; specs/agents/builder.yaml#v2.checkpoints): after each stage of a build by
// a system plan (plan, texts, design, compile, custom, gates) its result is kept with the plan revision, so «Исправить»
// continues from the last stage done and never pays for the finished ones again. No PII: the plan is scrubbed.
// Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.system_plans ADD COLUMN IF NOT EXISTS checkpoints jsonb NOT NULL DEFAULT '{}'`.execute(
    db,
  );
}
