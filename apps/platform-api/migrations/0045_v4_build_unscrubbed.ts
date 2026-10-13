// V4-05 (product.yaml#decisions.D79_v4 (3)): build stages go to the allowlist models abroad without scrub, so a T1
// attempt is no longer always scrubbed — the M0 check «tier = 'T0' OR scrubbed» is dropped. llm_calls.scrubbed keeps
// recording what was sent; BYOK attempts stay scrubbed by their own check (llm_calls_byok_free, 0041). Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.llm_calls DROP CONSTRAINT IF EXISTS llm_calls_check`.execute(db);
}
