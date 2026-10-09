// V3-31 sync of a system repository with GitHub and GitLab through pull requests (product.yaml#decisions.D77_v3 (3);
// db.yaml system_repo_*): the connection of a system to an external repository (GitHub App installation or GitLab OAuth,
// tokens only sealed — envelope encryption as BYOK, the KEK in OpenBao Transit or the local store), the PR of each pushed
// revision with the gate statuses posted to it, the imports of the default branch, the retry queue and the webhook
// deliveries seen (idempotency). Rows are visible only within the org set by
// pg_catalog.set_config('wizard.org_id', …, true) in the transaction (RLS, FORCE). The webhook router and the queue
// worker find their link and job across orgs with a read-only policy under wizard.repo_dispatch = 'on' (links and jobs
// only, SELECT only); every write runs with the org of the row. Everything goes with the system. Forward-only.
import { type Kysely, sql } from "kysely";

const ORG = "NULLIF(pg_catalog.current_setting('wizard.org_id', true), '')::uuid";
const DISPATCH = "pg_catalog.current_setting('wizard.repo_dispatch', true) = 'on'";
const OID = "'^[0-9a-f]{40}$'";
const TABLES = [
  "system_repo_links",
  "system_repo_prs",
  "system_repo_imports",
  "system_repo_jobs",
  "system_repo_deliveries",
];

const STATEMENTS = [
  `CREATE TABLE platform.system_repo_links (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('github','gitlab')),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paused','error')),
    host_url text NOT NULL CHECK (host_url ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'),
    repo_path text CHECK (repo_path ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$'),
    repo_id text CHECK (repo_id ~ '^[0-9]{1,20}$'),
    installation_id text CHECK (installation_id ~ '^[0-9]{1,20}$'),
    default_branch text CHECK (default_branch ~ '^[A-Za-z0-9._/-]{1,200}$'),
    clone_url text CHECK (clone_url ~ '^https?://'),
    web_url text CHECK (web_url ~ '^https?://'),
    auto_merge boolean NOT NULL DEFAULT false,
    secret_ref text NOT NULL CHECK (secret_ref ~ '^secret://repo/[a-z]+$'),
    ciphertext text CHECK (ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
    wrapped_dek text CHECK (wrapped_dek ~ '^(vault|local):v[0-9]+:'),
    kek_backend text CHECK (kek_backend IN ('local','openbao')),
    kek_name text CHECK (kek_name ~ '^[A-Za-z0-9_.-]{1,64}$'),
    remote_head_oid text CHECK (remote_head_oid ~ ${OID}),
    remote_head_revision integer CHECK (remote_head_revision >= 1),
    last_pushed_revision integer NOT NULL DEFAULT 0 CHECK (last_pushed_revision >= 0),
    last_reconcile_at timestamptz,
    last_sync_at timestamptz,
    last_error_code text CHECK (last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    last_error_ru text CHECK (pg_catalog.length(last_error_ru) <= 1000),
    connected_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT system_repo_links_system_key UNIQUE (system_id),
    CONSTRAINT system_repo_links_sealed CHECK ((ciphertext IS NULL) = (wrapped_dek IS NULL)
      AND (ciphertext IS NULL) = (kek_backend IS NULL) AND (ciphertext IS NULL) = (kek_name IS NULL)),
    CONSTRAINT system_repo_links_repo CHECK (status = 'pending'
      OR (repo_path IS NOT NULL AND repo_id IS NOT NULL AND default_branch IS NOT NULL AND clone_url IS NOT NULL)),
    CONSTRAINT system_repo_links_github CHECK (provider <> 'github' OR status = 'pending' OR installation_id IS NOT NULL)
  )`,
  `CREATE UNIQUE INDEX system_repo_links_repo_idx ON platform.system_repo_links (provider, host_url, repo_id)
     WHERE repo_id IS NOT NULL`,
  `CREATE INDEX system_repo_links_installation_idx ON platform.system_repo_links (installation_id)
     WHERE installation_id IS NOT NULL`,
  `CREATE INDEX system_repo_links_org_idx ON platform.system_repo_links (org_id)`,
  `CREATE TABLE platform.system_repo_prs (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    link_id uuid NOT NULL REFERENCES platform.system_repo_links(id) ON DELETE CASCADE,
    revision integer NOT NULL CHECK (revision >= 1),
    branch text NOT NULL CHECK (branch ~ '^[A-Za-z0-9._/-]{1,250}$'),
    head_oid text NOT NULL CHECK (head_oid ~ ${OID}),
    base_oid text CHECK (base_oid ~ ${OID}),
    number integer CHECK (number >= 1),
    url text CHECK (url ~ '^https?://'),
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','merged','closed','superseded','direct')),
    checks jsonb NOT NULL DEFAULT '{}' CHECK (pg_catalog.jsonb_typeof(checks) = 'object'),
    body_sha256 text CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
    merged_at timestamptz,
    merge_oid text CHECK (merge_oid ~ ${OID}),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT system_repo_prs_revision_key UNIQUE (link_id, revision),
    CONSTRAINT system_repo_prs_number CHECK (state = 'direct' OR number IS NOT NULL),
    FOREIGN KEY (system_id, revision) REFERENCES platform.revisions (system_id, version) ON DELETE CASCADE
  )`,
  `CREATE INDEX system_repo_prs_open_idx ON platform.system_repo_prs (link_id, state, revision DESC)`,
  `CREATE INDEX system_repo_prs_system_idx ON platform.system_repo_prs (system_id, revision)`,
  `CREATE TABLE platform.system_repo_imports (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    link_id uuid NOT NULL REFERENCES platform.system_repo_links(id) ON DELETE CASCADE,
    head_oid text NOT NULL CHECK (head_oid ~ ${OID}),
    source text NOT NULL CHECK (source IN ('webhook','reconcile','merge')),
    pr_number integer CHECK (pr_number >= 1),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','noop','imported','rejected')),
    base_revision integer CHECK (base_revision >= 1),
    revision integer CHECK (revision >= 1),
    reason_code text CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    reason_ru text CHECK (pg_catalog.length(reason_ru) <= 2000),
    details jsonb NOT NULL DEFAULT '{}' CHECK (pg_catalog.jsonb_typeof(details) = 'object'),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT system_repo_imports_head_key UNIQUE (link_id, head_oid),
    CONSTRAINT system_repo_imports_revision CHECK ((status = 'imported') = (revision IS NOT NULL)),
    CONSTRAINT system_repo_imports_reason CHECK (status <> 'rejected' OR reason_ru IS NOT NULL)
  )`,
  `CREATE INDEX system_repo_imports_link_idx ON platform.system_repo_imports (link_id, created_at DESC)`,
  `CREATE TABLE platform.system_repo_jobs (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    link_id uuid NOT NULL REFERENCES platform.system_repo_links(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('push','statuses','import','reconcile')),
    dedupe_key text NOT NULL CHECK (pg_catalog.length(dedupe_key) BETWEEN 1 AND 200),
    payload jsonb NOT NULL DEFAULT '{}' CHECK (pg_catalog.jsonb_typeof(payload) = 'object'),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','dead')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    locked_until timestamptz,
    last_error_code text CHECK (last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    last_error_ru text CHECK (pg_catalog.length(last_error_ru) <= 1000),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()
  )`,
  // One waiting job per key (a webhook during a running import queues the next one); one running job per link is the
  // claim's rule (git-sync/store.ts claimJob, under the link row lock).
  `CREATE UNIQUE INDEX system_repo_jobs_dedupe_idx ON platform.system_repo_jobs (link_id, dedupe_key)
     WHERE status = 'queued'`,
  `CREATE INDEX system_repo_jobs_due_idx ON platform.system_repo_jobs (next_attempt_at)
     WHERE status IN ('queued','running')`,
  `CREATE INDEX system_repo_jobs_link_idx ON platform.system_repo_jobs (link_id, created_at DESC)`,
  `CREATE TABLE platform.system_repo_deliveries (
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    link_id uuid NOT NULL REFERENCES platform.system_repo_links(id) ON DELETE CASCADE,
    delivery_id text NOT NULL CHECK (pg_catalog.length(delivery_id) BETWEEN 1 AND 200),
    event text NOT NULL CHECK (pg_catalog.length(event) BETWEEN 1 AND 100),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    PRIMARY KEY (link_id, delivery_id)
  )`,
  `CREATE INDEX system_repo_deliveries_created_idx ON platform.system_repo_deliveries (created_at)`,
  ...TABLES.flatMap((t) => [
    `ALTER TABLE platform.${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE platform.${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${t}_org ON platform.${t} USING (org_id = ${ORG}) WITH CHECK (org_id = ${ORG})`,
  ]),
  ...["system_repo_links", "system_repo_jobs"].map(
    (t) => `CREATE POLICY ${t}_dispatch ON platform.${t} FOR SELECT USING (${DISPATCH})`,
  ),
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
