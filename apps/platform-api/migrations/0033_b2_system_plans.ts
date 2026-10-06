// System plans of beta v2 (B2-20; product.yaml#decisions.D76_beta_v2, docs/reviews/grill-6.md № 5): revisions of the
// SystemPlan a system waits on before its build — produced by the planner (source planner) or by a deterministic edit on
// the plan screen (source edit); one awaiting approval at a time, the approved one starts the build. messages.kind gets
// 'plan' (the chat entry of a plan). Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.system_plans (
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision >= 1),
    status text NOT NULL CHECK (status IN ('awaiting_approval','approved','superseded')),
    source text NOT NULL CHECK (source IN ('planner','edit')),
    plan jsonb NOT NULL,
    errors jsonb NOT NULL DEFAULT '[]',
    fingerprint text CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    run_id uuid REFERENCES platform.runs(id) ON DELETE SET NULL,
    build_run_id uuid REFERENCES platform.runs(id) ON DELETE SET NULL,
    author_user_id uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    approved_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    approved_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, revision)
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS system_plans_awaiting_uq
    ON platform.system_plans (system_id) WHERE status = 'awaiting_approval'`.execute(db);
  await sql`ALTER TABLE platform.messages DROP CONSTRAINT IF EXISTS messages_kind_check`.execute(db);
  await sql`ALTER TABLE platform.messages ADD CONSTRAINT messages_kind_check
    CHECK (kind IN ('text','questions','answers','card','run_report','notice','plan'))`.execute(db);
}
