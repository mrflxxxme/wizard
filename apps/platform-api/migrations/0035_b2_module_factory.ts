// Module factory (B2-26; docs/reviews/grill-6.md decision 4, db.yaml#module_candidates): the weekly rating of
// «Запросы на развитие» and successful custom parts grouped by category and a normalized wording, the founder's
// decision on each candidate (approve / disable / module ready with the catalog module id), the «done» mark of the
// requests a ready module covers, the one-time «Теперь умеем» letter per client and module, and the client's consent
// to letters about new abilities (users.updates_consent_at). Forward-only.
import { type Kysely, sql } from "kysely";

const CATEGORIES = sql.raw(
  "'payments','subscriptions','integration','messaging','design','domain','media','data','mobile','ai','other'",
);

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`ALTER TABLE platform.users ADD COLUMN IF NOT EXISTS updates_consent_at timestamptz`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.module_candidates (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key text NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 200),
    category text NOT NULL CHECK (category IN (${CATEGORIES})),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','disabled','ready')),
    module_id text CHECK (module_id ~ '^[a-z][a-z0-9_]{0,63}$'),
    rank integer CHECK (rank >= 1),
    week_start timestamptz,
    week_requests integer NOT NULL DEFAULT 0,
    week_custom integer NOT NULL DEFAULT 0,
    total_requests integer NOT NULL DEFAULT 0,
    total_custom integer NOT NULL DEFAULT 0,
    systems integer NOT NULL DEFAULT 0,
    clients integer NOT NULL DEFAULT 0,
    examples jsonb NOT NULL DEFAULT '[]',
    last_seen_at timestamptz,
    computed_at timestamptz,
    note text CHECK (length(note) <= 500),
    decided_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    decided_at timestamptz,
    ready_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'ready' OR module_id IS NOT NULL)
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS module_candidates_status_rank_idx
    ON platform.module_candidates (status, rank)`.execute(db);
  await sql`ALTER TABLE platform.development_requests
    ADD COLUMN IF NOT EXISTS candidate_id uuid REFERENCES platform.module_candidates(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
    ADD COLUMN IF NOT EXISTS done_at timestamptz`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS development_requests_candidate_idx
    ON platform.development_requests (candidate_id) WHERE candidate_id IS NOT NULL`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.module_announcements (
    module_id text NOT NULL CHECK (module_id ~ '^[a-z][a-z0-9_]{0,63}$'),
    user_id uuid NOT NULL REFERENCES platform.users(id) ON DELETE CASCADE,
    candidate_id uuid REFERENCES platform.module_candidates(id) ON DELETE SET NULL,
    system_id uuid REFERENCES platform.systems(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (module_id, user_id)
  )`.execute(db);
}
