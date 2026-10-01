// M3-02 (runtime.yaml#ai_actions, billing.yaml#run_charging.runtime_ai): journal of runtime AI calls — the monthly
// limit aiAction.monthlyLimit counts it, the ledger charge is keyed by its call id (idempotent per call) — and the
// one-time backfills of old records requested by a change card (db.yaml#tables.ai_action_calls, #ai_backfills).
// Neither table holds record values or model answers. Forward-only.
import { type Kysely, sql } from "kysely";

const STATEMENTS = [
  `CREATE TABLE platform.ai_action_calls (
    id text PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES platform.orgs(id),
    system_id uuid NOT NULL REFERENCES platform.systems(id),
    env text NOT NULL CHECK (env IN ('draft', 'prod')),
    action text NOT NULL,
    call_type text NOT NULL CHECK (call_type IN ('runtime_ai_extract', 'runtime_ai_generate')),
    source text NOT NULL CHECK (source IN ('button', 'workflow', 'backfill')),
    status text NOT NULL CHECK (status IN ('pending', 'ok', 'error')),
    error_code text,
    credits_milli bigint NOT NULL DEFAULT 0,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  "CREATE INDEX ai_action_calls_month ON platform.ai_action_calls (system_id, action, created_at)",
  `CREATE TABLE platform.ai_backfills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES platform.systems(id),
    env text NOT NULL CHECK (env IN ('draft', 'prod')),
    action text NOT NULL,
    run_id uuid REFERENCES platform.runs(id),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    filled integer NOT NULL DEFAULT 0,
    skipped integer NOT NULL DEFAULT 0,
    stop_code text,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  "CREATE UNIQUE INDEX ai_backfills_pending ON platform.ai_backfills (system_id, env, action) WHERE status = 'pending'",
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
