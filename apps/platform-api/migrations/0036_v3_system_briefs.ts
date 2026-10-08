// System briefs of v3 (V3-02; product.yaml#decisions.D77_v3 (9), specs/agents/builder-v3.md §3 C1): versions of the
// SystemBrief of a system. Every edit — by the interview agent (author agent) or by the owner in the panel or the chat
// (author owner) — adds version max+1 with its field-level diff to the previous one; the build stages read the latest.
// Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.system_briefs (
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    version integer NOT NULL CHECK (version >= 1),
    brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
    diff jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(diff) = 'array'),
    author text NOT NULL CHECK (author IN ('agent','owner')),
    author_user_id uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    run_id uuid REFERENCES platform.runs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, version)
  )`.execute(db);
}
