// V3-21 «Окно ключа в чате» (product.yaml#decisions.D77_v3 (15), D37; security/data-boundary.yaml#secret_window;
// db.yaml secret_windows, secret_bindings). A window is the platform's request of one key secret://<name> for a system:
// the recipient hosts shown to the owner, who asked (the build agent or the owner) and why, and a one-time P-256 key pair
// whose private half is sealed by the KMS (OpenBao Transit or the local KEK of the dev stand) — the browser encrypts the
// key to its public half. The private half is destroyed when the window is used, cancelled or expired (CHECK). A binding
// is what the window left: the hosts the key may go to, its last 4 characters, the version (rotation) and the check.
// The value itself lives only in the secret store (secrets_refs). Rows are visible only within the org set by
// pg_catalog.set_config('wizard.org_id', …, true) in the transaction (RLS, FORCE); deleted with the system. Forward-only.
import { type Kysely, sql } from "kysely";

const ORG = "NULLIF(pg_catalog.current_setting('wizard.org_id', true), '')::uuid";
const NAME = "'^[a-z][a-z0-9_]{0,63}$'";
const INTEGRATION = "'^[a-z][a-z0-9_]{0,39}$'";
const HOSTS = (c: string) =>
  `pg_catalog.jsonb_typeof(${c}) = 'array' AND pg_catalog.jsonb_array_length(${c}) BETWEEN 1 AND 10`;

const STATEMENTS = [
  `CREATE TABLE platform.secret_windows (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    env text NOT NULL CHECK (env IN ('draft','prod')),
    name text NOT NULL CHECK (name ~ ${NAME}),
    integration_id text CHECK (integration_id IS NULL OR integration_id ~ ${INTEGRATION}),
    hosts jsonb NOT NULL CHECK (${HOSTS("hosts")}),
    purpose text NOT NULL CHECK (pg_catalog.char_length(purpose) BETWEEN 1 AND 300),
    requested_by text NOT NULL CHECK (requested_by IN ('agent','user')),
    run_id uuid REFERENCES platform.runs(id) ON DELETE SET NULL,
    created_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled','expired')),
    public_jwk jsonb CHECK (public_jwk IS NULL OR pg_catalog.jsonb_typeof(public_jwk) = 'object'),
    sealed_private text CHECK (sealed_private IS NULL OR sealed_private ~ '^[A-Za-z0-9+/]+={0,2}$'),
    wrapped_dek text CHECK (wrapped_dek IS NULL OR wrapped_dek ~ '^(vault|local):v[0-9]+:'),
    kek_backend text CHECK (kek_backend IS NULL OR kek_backend IN ('local','openbao')),
    kek_name text CHECK (kek_name IS NULL OR kek_name ~ '^[A-Za-z0-9_.-]{1,64}$'),
    expires_at timestamptz NOT NULL,
    closed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT secret_windows_sealed CHECK ((sealed_private IS NULL) = (wrapped_dek IS NULL)),
    CONSTRAINT secret_windows_pair CHECK ((public_jwk IS NULL) = (sealed_private IS NULL)),
    CONSTRAINT secret_windows_shredded CHECK (status = 'open' OR (sealed_private IS NULL AND public_jwk IS NULL)),
    CONSTRAINT secret_windows_closed CHECK ((status = 'open') = (closed_at IS NULL))
  )`,
  `CREATE UNIQUE INDEX secret_windows_open_key ON platform.secret_windows (system_id, env, name) WHERE status = 'open'`,
  `CREATE INDEX secret_windows_system_idx ON platform.secret_windows (system_id, created_at DESC)`,
  `CREATE TABLE platform.secret_bindings (
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    env text NOT NULL CHECK (env IN ('draft','prod')),
    name text NOT NULL CHECK (name ~ ${NAME}),
    integration_id text CHECK (integration_id IS NULL OR integration_id ~ ${INTEGRATION}),
    hosts jsonb NOT NULL CHECK (${HOSTS("hosts")}),
    last4 text NOT NULL CHECK (pg_catalog.char_length(last4) <= 4),
    version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
    status text NOT NULL CHECK (status IN ('unchecked','ok','failed')),
    check_code text CHECK (check_code IS NULL OR check_code ~ '^[A-Z][A-Z_]{1,39}$'),
    check_message text CHECK (check_message IS NULL OR pg_catalog.char_length(check_message) <= 500),
    checked_at timestamptz,
    window_id uuid REFERENCES platform.secret_windows(id) ON DELETE SET NULL,
    created_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    rotated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    PRIMARY KEY (system_id, env, name)
  )`,
  ...["secret_windows", "secret_bindings"].flatMap((t) => [
    `ALTER TABLE platform.${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE platform.${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${t}_org ON platform.${t} USING (org_id = ${ORG}) WITH CHECK (org_id = ${ORG})`,
  ]),
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
