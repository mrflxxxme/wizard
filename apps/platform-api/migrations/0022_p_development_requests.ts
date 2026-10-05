// «Запросы на развитие» (D73, M2-59 mvp_scope): what a client asked for beyond the platform's abilities, recorded by
// the agents from a run (host.recordDevelopmentRequest): category, the quote after the PII scrub, the substitute the
// agent offered. Rows go with the org. One row per (run, category, quote): a retried step does not duplicate it.
// Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.development_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    system_id uuid REFERENCES platform.systems(id) ON DELETE SET NULL,
    run_id uuid REFERENCES platform.runs(id) ON DELETE SET NULL,
    user_id uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    category text NOT NULL CHECK (category IN ('payments','subscriptions','integration','messaging','design',
      'domain','media','data','mobile','ai','other')),
    quote text NOT NULL CHECK (length(quote) BETWEEN 1 AND 1000),
    offered text CHECK (length(offered) <= 1000),
    created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS development_requests_run_quote_uq
    ON platform.development_requests (run_id, category, md5(quote)) WHERE run_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS development_requests_created_idx
    ON platform.development_requests (created_at)`.execute(db);
}
