// V3-32 agent for compatible repositories (product.yaml#decisions.D77_v3 (4); db.yaml agent_repo*, system_repo_pr_previews):
// a client's repository connected to an org for the agent (GitHub App installation or GitLab OAuth, tokens only sealed —
// as system_repo_links), its compatibility report, and the agent's tasks — the compatibility check, the rules proposal
// (AGENTS.md by a separate PR) and the owner's changes, each ending in a draft PR into a wizard/_agent/* branch that only
// a human merges. Also the V3-31 leftover: previews of the client's developers' PRs before the merge (gates of the
// candidate as checks in the PR) — a job kind of the sync queue and a row per open PR. Rows are visible only within the
// org set by pg_catalog.set_config('wizard.org_id', …, true) (RLS, FORCE); the task worker finds due tasks across orgs
// with a read-only policy under wizard.repo_dispatch = 'on' (repositories and tasks, SELECT only). Forward-only.
import { type Kysely, sql } from "kysely";

const ORG = "NULLIF(pg_catalog.current_setting('wizard.org_id', true), '')::uuid";
const DISPATCH = "pg_catalog.current_setting('wizard.repo_dispatch', true) = 'on'";
const OID = "'^[0-9a-f]{40}$'";
const TABLES = ["agent_repos", "agent_repo_tasks", "system_repo_pr_previews"];

const STATEMENTS = [
  `CREATE TABLE platform.agent_repos (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('github','gitlab')),
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','checking','ready','incompatible','unchecked','error')),
    host_url text NOT NULL CHECK (host_url ~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'),
    repo_path text CHECK (repo_path ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$'),
    repo_id text CHECK (repo_id ~ '^[0-9]{1,20}$'),
    installation_id text CHECK (installation_id ~ '^[0-9]{1,20}$'),
    default_branch text CHECK (default_branch ~ '^[A-Za-z0-9._/-]{1,200}$'),
    clone_url text CHECK (clone_url ~ '^https?://'),
    web_url text CHECK (web_url ~ '^https?://'),
    secret_ref text NOT NULL CHECK (secret_ref ~ '^secret://repo/[a-z]+$'),
    ciphertext text CHECK (ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
    wrapped_dek text CHECK (wrapped_dek ~ '^(vault|local):v[0-9]+:'),
    kek_backend text CHECK (kek_backend IN ('local','openbao')),
    kek_name text CHECK (kek_name ~ '^[A-Za-z0-9_.-]{1,64}$'),
    head_oid text CHECK (head_oid ~ ${OID}),
    compat jsonb CHECK (compat IS NULL OR pg_catalog.jsonb_typeof(compat) = 'object'),
    checked_at timestamptz,
    rules_pr_url text CHECK (rules_pr_url ~ '^https?://'),
    last_error_code text CHECK (last_error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    last_error_ru text CHECK (pg_catalog.length(last_error_ru) <= 1000),
    connected_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT agent_repos_sealed CHECK ((ciphertext IS NULL) = (wrapped_dek IS NULL)
      AND (ciphertext IS NULL) = (kek_backend IS NULL) AND (ciphertext IS NULL) = (kek_name IS NULL)),
    CONSTRAINT agent_repos_repo CHECK (status = 'pending'
      OR (repo_path IS NOT NULL AND repo_id IS NOT NULL AND default_branch IS NOT NULL AND clone_url IS NOT NULL)),
    CONSTRAINT agent_repos_github CHECK (provider <> 'github' OR status = 'pending' OR installation_id IS NOT NULL)
  )`,
  `CREATE UNIQUE INDEX agent_repos_repo_idx ON platform.agent_repos (org_id, provider, host_url, repo_id)
     WHERE repo_id IS NOT NULL`,
  `CREATE INDEX agent_repos_org_idx ON platform.agent_repos (org_id, created_at DESC)`,
  `CREATE TABLE platform.agent_repo_tasks (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    repo_id uuid NOT NULL REFERENCES platform.agent_repos(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('check','rules','change')),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
    task_ru text CHECK (pg_catalog.length(task_ru) BETWEEN 1 AND 4000),
    base_oid text CHECK (base_oid ~ ${OID}),
    head_oid text CHECK (head_oid ~ ${OID}),
    branch text CHECK (branch ~ '^wizard/_agent/[a-z0-9-]{1,64}$'),
    pr_number integer CHECK (pr_number >= 1),
    pr_url text CHECK (pr_url ~ '^https?://'),
    draft boolean NOT NULL DEFAULT true,
    result jsonb NOT NULL DEFAULT '{}' CHECK (pg_catalog.jsonb_typeof(result) = 'object'),
    credits_milli bigint NOT NULL DEFAULT 0 CHECK (credits_milli >= 0),
    error_code text CHECK (error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    error_ru text CHECK (pg_catalog.length(error_ru) <= 2000),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    locked_until timestamptz,
    created_by uuid REFERENCES platform.users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT agent_repo_tasks_text CHECK ((kind = 'change') = (task_ru IS NOT NULL)),
    CONSTRAINT agent_repo_tasks_pr CHECK ((pr_number IS NULL) = (pr_url IS NULL)
      AND (pr_number IS NULL OR (branch IS NOT NULL AND head_oid IS NOT NULL))),
    CONSTRAINT agent_repo_tasks_no_check_pr CHECK (kind <> 'check' OR pr_number IS NULL)
  )`,
  // One waiting or running check and one rules proposal per repository; changes queue up (one runs at a time per
  // repository — the claim's rule, repo-agent/store.ts claimTask).
  `CREATE UNIQUE INDEX agent_repo_tasks_once_idx ON platform.agent_repo_tasks (repo_id, kind)
     WHERE status IN ('queued','running') AND kind IN ('check','rules')`,
  `CREATE INDEX agent_repo_tasks_due_idx ON platform.agent_repo_tasks (next_attempt_at)
     WHERE status IN ('queued','running')`,
  `CREATE INDEX agent_repo_tasks_repo_idx ON platform.agent_repo_tasks (repo_id, created_at DESC)`,
  // V3-31 leftover: previews of the client's developers' PRs (a job kind of the sync queue and a row per PR).
  `ALTER TABLE platform.system_repo_jobs DROP CONSTRAINT system_repo_jobs_kind_check`,
  `ALTER TABLE platform.system_repo_jobs ADD CONSTRAINT system_repo_jobs_kind_check
     CHECK (kind IN ('push','statuses','import','reconcile','pr_preview'))`,
  `CREATE TABLE platform.system_repo_pr_previews (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES platform.orgs(id) ON DELETE CASCADE,
    system_id uuid NOT NULL REFERENCES platform.systems(id) ON DELETE CASCADE,
    link_id uuid NOT NULL REFERENCES platform.system_repo_links(id) ON DELETE CASCADE,
    number integer NOT NULL CHECK (number >= 1),
    branch text CHECK (pg_catalog.length(branch) BETWEEN 1 AND 250),
    url text CHECK (url ~ '^https?://'),
    head_oid text NOT NULL CHECK (head_oid ~ ${OID}),
    status text NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','passed','failed','rejected','noop','closed')),
    base_revision integer CHECK (base_revision >= 1),
    reason_code text CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
    reason_ru text CHECK (pg_catalog.length(reason_ru) <= 2000),
    checks jsonb NOT NULL DEFAULT '{}' CHECK (pg_catalog.jsonb_typeof(checks) = 'object'),
    details jsonb NOT NULL DEFAULT '{}' CHECK (pg_catalog.jsonb_typeof(details) = 'object'),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
    CONSTRAINT system_repo_pr_previews_number_key UNIQUE (link_id, number),
    CONSTRAINT system_repo_pr_previews_reason CHECK (status NOT IN ('failed','rejected') OR reason_ru IS NOT NULL)
  )`,
  ...TABLES.flatMap((t) => [
    `ALTER TABLE platform.${t} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE platform.${t} FORCE ROW LEVEL SECURITY`,
    `CREATE POLICY ${t}_org ON platform.${t} USING (org_id = ${ORG}) WITH CHECK (org_id = ${ORG})`,
  ]),
  ...["agent_repos", "agent_repo_tasks"].map(
    (t) => `CREATE POLICY ${t}_dispatch ON platform.${t} FOR SELECT USING (${DISPATCH})`,
  ),
];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout = '3s'`.execute(db);
  for (const stmt of STATEMENTS) await sql.raw(stmt).execute(db);
}
