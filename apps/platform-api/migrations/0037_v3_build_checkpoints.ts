// Checkpoints of the build harness v3 (V3-11; specs/agents/builder-v3.md §3 C6, product.yaml D77_v3 (10)): after each
// stage and each scenario of a build by the system brief its result is kept with the fingerprint of what it read, so a
// repeated build («Исправить», «Собрать» again) reuses what is done and never pays for it again. One row per system and
// key (stage id or scenario:<id>). Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.system_build_checkpoints (
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    key text NOT NULL CHECK (key ~ '^[a-z_]+(:[A-Za-z0-9_-]+)?$'),
    checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
    run_id uuid REFERENCES platform.runs(id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, key)
  )`.execute(db);
}
