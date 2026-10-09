// Integrations harness of v3 (V3-20; product.yaml#decisions.D77_v3 (15), D37): keys of a system's own API for the
// client's external systems (1С and others) — sha256 only, shown once, one spec role and scopes each, revocable,
// deleted with the system — and the audit of their requests (no values); the versions of outgoing integration
// contracts the brief refers to (contract://<integration>@<version>#<sha>) with the mock tests and the key check
// that switches an integration from the mock to the live API. Forward-only.
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS platform.system_api_keys (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    env text NOT NULL CHECK (env IN ('draft','prod')),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    role text NOT NULL CHECK (role ~ '^[a-z][a-z0-9_]{0,39}$'),
    scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
    prefix text NOT NULL CHECK (prefix ~ '^wzk_[a-z2-7]{8}$'),
    key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    rate_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_per_minute BETWEEN 1 AND 600),
    created_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS system_api_keys_key_hash_key ON platform.system_api_keys (key_hash)`.execute(
    db,
  );
  await sql`CREATE INDEX IF NOT EXISTS system_api_keys_system_idx
    ON platform.system_api_keys (system_id, created_at DESC)`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS platform.system_api_calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key_id uuid NOT NULL REFERENCES platform.system_api_keys(id) ON DELETE CASCADE,
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    method text NOT NULL CHECK (method IN ('GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS')),
    target text NOT NULL CHECK (char_length(target) BETWEEN 1 AND 120),
    status integer NOT NULL CHECK (status BETWEEN 100 AND 599),
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS system_api_calls_key_idx
    ON platform.system_api_calls (key_id, created_at DESC)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS system_api_calls_system_idx
    ON platform.system_api_calls (system_id, created_at DESC)`.execute(db);

  await sql`CREATE TABLE IF NOT EXISTS platform.system_integration_contracts (
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    integration_id text NOT NULL CHECK (integration_id ~ '^[a-z][a-z0-9_]{0,39}$'),
    version integer NOT NULL CHECK (version >= 1),
    contract jsonb NOT NULL CHECK (jsonb_typeof(contract) = 'object'),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    status text NOT NULL DEFAULT 'mock' CHECK (status IN ('mock','live','failed')),
    tests jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(tests) = 'object'),
    key_check jsonb CHECK (key_check IS NULL OR jsonb_typeof(key_check) = 'object'),
    checked_at timestamptz,
    created_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    run_id uuid REFERENCES platform.runs(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (system_id, integration_id, version)
  )`.execute(db);
}
