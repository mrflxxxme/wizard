// V4-04: the reasoning tokens of a call (usage.completion_tokens_details.reasoning_tokens; part of output_tokens, billed
// with them) — the build report shows input, cached, output and reasoning per call. Forward-only, default 0.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.llm_calls ADD COLUMN IF NOT EXISTS reasoning_tokens integer NOT NULL DEFAULT 0`.execute(
    db,
  );
}
