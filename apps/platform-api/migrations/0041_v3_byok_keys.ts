// V3-33 BYOK (product.yaml#decisions.D77_v3 (14), (14б); security/data-boundary.yaml#byok; db.yaml byok_*): the org's
// own model keys and the consent to their terms. Only ciphertext is stored — the key sealed with a data key (AES-256-GCM)
// that OpenBao Transit (or the local KEK of the dev stand) wraps; the last 4 characters are kept for the UI. A revoked
// key loses its ciphertext and wrapped data key (crypto-shredding). Rows are visible only within the org set by
// pg_catalog.set_config('wizard.org_id', …, true) in the transaction (RLS, FORCE: the platform login owns the table).
// llm_calls.byok marks attempts on a user's key: free for the balance and scrubbed (checked by the database).
// Forward-only.
import { type Kysely, sql } from "kysely";

const ORG = "NULLIF(pg_catalog.current_setting('wizard.org_id', true), '')::uuid";

const STATEMENTS = [
  `CREATE TABLE platform.byok_consents (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    user_id uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    text_version text NOT NULL CHECK (text_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\\.[0-9]+$'),
    text_sha256 text NOT NULL CHECK (text_sha256 ~ '^[0-9a-f]{64}$'),
    accepted_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT byok_consents_org_version_key UNIQUE (org_id, text_version)
  )`,
  `CREATE TABLE platform.byok_keys (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,31}$'),
    model text NOT NULL CHECK (pg_catalog.length(model) BETWEEN 1 AND 128),
    gateway_url text CHECK (gateway_url IS NULL OR (pg_catalog.length(gateway_url) <= 512 AND gateway_url ~ '^https?://')),
    call_types jsonb NOT NULL DEFAULT '[]' CHECK (pg_catalog.jsonb_typeof(call_types) = 'array'),
    key_last4 text NOT NULL CHECK (pg_catalog.length(key_last4) = 4),
    ciphertext text CHECK (ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
    wrapped_dek text CHECK (wrapped_dek ~ '^(vault|local):v[0-9]+:'),
    kek_backend text NOT NULL CHECK (kek_backend IN ('local','openbao')),
    kek_name text NOT NULL CHECK (kek_name ~ '^[A-Za-z0-9_.-]{1,64}$'),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked')),
    check_status text NOT NULL DEFAULT 'pending' CHECK (check_status IN ('pending','ok','failed')),
    check_code text,
    checked_at timestamptz,
    last_used_at timestamptz,
    last_error_code text,
    consent_id uuid NOT NULL REFERENCES platform.byok_consents(id),
    created_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    revoked_at timestamptz,
    revoked_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT byok_keys_shredded CHECK ((status = 'revoked') = (ciphertext IS NULL AND wrapped_dek IS NULL)),
    CONSTRAINT byok_keys_sealed CHECK ((ciphertext IS NULL) = (wrapped_dek IS NULL)),
    CONSTRAINT byok_keys_revoked_at CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
  )`,
  `CREATE INDEX byok_keys_org_idx ON platform.byok_keys (org_id, created_at DESC)`,
  `CREATE INDEX byok_keys_consent_idx ON platform.byok_keys (consent_id)`,
  ...["byok_consents", "byok_keys"].flatMap((t) => [
    `ALTER TABLE platform.${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE platform.${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${t}_org ON platform.${t} USING (org_id = ${ORG}) WITH CHECK (org_id = ${ORG})`,
  ]),
  `ALTER TABLE platform.llm_calls ADD COLUMN byok boolean NOT NULL DEFAULT false`,
  // Every existing row has byok = false: NOT VALID skips the scan of the journal under the lock.
  `ALTER TABLE platform.llm_calls ADD CONSTRAINT llm_calls_byok_free
    CHECK (NOT byok OR (cost_rub = 0 AND credits_milli = 0 AND NOT billable AND scrubbed)) NOT VALID`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
