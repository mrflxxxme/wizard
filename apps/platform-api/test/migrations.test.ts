// Acceptance M0-15: after migrate, columns of M0 tables match specs/platform/db.yaml (the test parses the YAML).
import type { TransactionSql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDb, type DbHandle, DEFAULT_ORG_ID, DEV_USER_ID, migrate } from "../src/db/index.js";
import { createTestDb, loadYaml } from "./helpers.js";

type TableDef = { milestone?: string; columns: Record<string, string>; primary_key?: string[] };
const dbYaml = loadYaml("specs/platform/db.yaml") as {
  tables: Record<string, TableDef>;
  views: Record<string, unknown>;
};
const NO_CREATED_AT = new Set(["shards", "subscriptions", "locks", "run_events"]);
const TYPE: Record<string, string> = {
  uuid: "uuid",
  text: "text",
  boolean: "boolean",
  timestamptz: "timestamp with time zone",
  integer: "integer",
  bigint: "bigint",
  smallint: "smallint",
  jsonb: "jsonb",
  numeric: "numeric",
  bytea: "bytea",
};

function expected(name: string, t: TableDef) {
  const cols: Record<string, { type: string; notNull: boolean }> = {};
  for (const [col, def] of Object.entries(t.columns)) {
    const raw = /^([a-z]+)/.exec(def)?.[1] ?? "";
    cols[col] = {
      type: TYPE[raw] ?? `?${raw}`,
      notNull: /\bnot null\b|\bpk\b/.test(def) || (t.primary_key ?? []).includes(col),
    };
  }
  if (!NO_CREATED_AT.has(name)) cols.created_at = { type: "timestamp with time zone", notNull: true };
  return { ...cols, ...EXTRA_COLUMNS[name] };
}

const m0 = Object.entries(dbYaml.tables).filter(([, t]) => t.milestone === "M0");
// M1 tables created so far (M1-02 accounts, M1-03 credits, M1-04 publications, M1-07 imports, M1-01 secrets_refs); the
// column check covers them as well.
const M1_TABLES = [
  "auth_otps",
  "sessions",
  "invites",
  "credit_ledger",
  "publications",
  "imports",
  "secrets_refs",
];
// M1 views created so far (M1-03).
const M1_VIEWS = ["credit_buckets"];
// M2 views created so far (M2-50 owners of a system for notify $owner).
const M2_VIEWS = ["system_owner_emails"];
// M2 tables created so far (M2-10 exports, M2-05 deletion_log, M2-07 billing, M2-04 G2 at publish: moderation, M2-15
// pilot invitations and founder alerts, M2-08 abuse, M2-09 platform settings).
const M2_TABLES = [
  "exports",
  "deletion_log",
  "subscriptions",
  "payment_methods",
  "payments",
  "founder_reviews",
  "brand_allowlist",
  "pilot_invites",
  "ops_alerts",
  "platform_settings",
  "abuse_reports",
  "staff_audit_log",
  "g1_checks",
  // M2P (MVP release cut): «Написать команде», «Запросы на развитие».
  "support_requests",
  "development_requests",
  "destructive_changes",
];
// M3 tables created so far (M3-02 runtime AI actions: call journal and backfills).
const M3_TABLES = ["ai_action_calls", "ai_backfills"];
// B2 tables created so far (B2-20 system plans awaiting approval, B2-26 module factory).
const B2_TABLES = ["system_plans", "module_candidates", "module_announcements"];
// V3 tables created so far (V3-02 system briefs, V3-11 build checkpoints, V3-14 site fingerprints, V3-30 system
// repositories).
const V3_TABLES = [
  "system_briefs",
  "system_build_checkpoints",
  "system_site_fingerprints",
  "system_git_objects",
  "system_git_refs",
  "system_git_commits",
];
// V3-33 own model keys (migration 0041).
V3_TABLES.push("byok_consents", "byok_keys");
// V3-20: system API keys, their audit, outgoing integration contracts (migration 0039).
V3_TABLES.push("system_api_keys", "system_api_calls", "system_integration_contracts");
// V3-21: key windows and the keys they left (migration 0042).
V3_TABLES.push("secret_windows", "secret_bindings");
// V3-31: sync of system repositories with GitHub and GitLab (migration 0043).
V3_TABLES.push(
  "system_repo_links",
  "system_repo_prs",
  "system_repo_imports",
  "system_repo_jobs",
  "system_repo_deliveries",
);
// V3-32: the agent for compatible repositories, previews of developers' PRs (migration 0044).
V3_TABLES.push("agent_repos", "agent_repo_tasks", "system_repo_pr_previews");
/** Columns beyond db.yaml (none: card_fingerprint, payments.meta and draft_purge_notice_at are in db.yaml since the 2026-10-01 spec sync). */
const EXTRA_COLUMNS: Record<string, Record<string, { type: string; notNull: boolean }>> = {};
const checked = [
  ...m0,
  ...Object.entries(dbYaml.tables).filter(
    ([n]) =>
      M1_TABLES.includes(n) ||
      M2_TABLES.includes(n) ||
      M3_TABLES.includes(n) ||
      B2_TABLES.includes(n) ||
      V3_TABLES.includes(n),
  ),
];

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let h: DbHandle;

beforeAll(async () => {
  tdb = await createTestDb("mig");
  h = createDb(tdb.url, 2);
  await migrate(h.db);
  await migrate(h.db); // idempotent
});

afterAll(async () => {
  await h?.close();
  await tdb?.drop();
});

describe("migrations vs db.yaml", () => {
  test("db.yaml has M0 tables", () => {
    expect(m0.map(([n]) => n)).toEqual(
      expect.arrayContaining(["users", "orgs", "systems", "runs", "run_events", "gate_reports", "locks"]),
    );
  });

  for (const [name, def] of checked) {
    test(`platform.${name}: columns, types and nullability`, async () => {
      const rows = await h.pg<{ column_name: string; data_type: string; is_nullable: string }[]>`
        select column_name, data_type, is_nullable from information_schema.columns
        where table_schema = 'platform' and table_name = ${name}`;
      const actual = Object.fromEntries(
        rows.map((r) => [r.column_name, { type: r.data_type, notNull: r.is_nullable === "NO" }]),
      );
      expect(actual).toEqual(expected(name, def));
    });
  }

  test("every M0 and M1-02/M1-04 table exists; no tables outside db.yaml (besides the migrator's own)", async () => {
    const rows = await h.pg<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'platform' and table_type = 'BASE TABLE'`;
    const names = rows.map((r) => r.table_name).filter((n) => !n.startsWith("kysely_"));
    expect(names).toEqual(expect.arrayContaining(checked.map(([n]) => n)));
    for (const n of names) expect(Object.keys(dbYaml.tables)).toContain(n);
  });

  test("M0 views (deployments) and M1-03 credit_buckets exist", async () => {
    const views = Object.entries(dbYaml.views as Record<string, { milestone?: string }>)
      .filter(([n, v]) => v.milestone === "M0" || M1_VIEWS.includes(n) || M2_VIEWS.includes(n))
      .map(([n]) => n);
    const rows = await h.pg<{ table_name: string }[]>`
      select table_name from information_schema.views where table_schema = 'platform'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual(views.sort());
    const cols = await h.pg<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'platform' and table_name = 'deployments'`;
    expect(cols.map((c) => c.column_name).sort()).toEqual(
      [
        "bundle_key",
        "env",
        "features",
        "published_at",
        "revision",
        "slug",
        "spec_hash",
        "suspended",
        "system_id",
      ].sort(),
    );
  });

  test("0015: indexes for the hourly failure share (runs.finished_at) and the LLM cap month (llm_calls.created_at)", async () => {
    const rows = await h.pg<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where schemaname = 'platform' and indexname in ('runs_finished_at_idx', 'llm_calls_created_at_idx')
      order by indexname`;
    expect(rows.map((r) => r.indexname)).toEqual(["llm_calls_created_at_idx", "runs_finished_at_idx"]);
    expect(rows[1]?.indexdef).toContain("WHERE (finished_at IS NOT NULL)");
    const plan = await h.pg.begin(async (tx) => {
      await tx`set local enable_seqscan = off`;
      return tx.unsafe(
        "explain select count(*) from platform.runs where status in ('succeeded','failed') and finished_at >= now() - interval '1 hour'",
      );
    });
    expect(JSON.stringify(plan)).toContain("runs_finished_at_idx");
  });

  test("seed_M0: dev user, local org, owner membership", async () => {
    const [m] =
      await h.pg`select role from platform.memberships where org_id = ${DEFAULT_ORG_ID} and user_id = ${DEV_USER_ID}`;
    expect(m?.role).toBe("owner");
    const [u] = await h.pg`select email from platform.users where id = ${DEV_USER_ID}`;
    expect(u?.email).toBe("dev@wizard.local");
  });

  test("0041 (V3-33): byok_* under forced RLS by org; llm_calls.byok rows must be free and scrubbed", async () => {
    const rls = await h.pg<{ relname: string; on: boolean; forced: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'platform' and c.relname in ('byok_consents', 'byok_keys') order by c.relname`;
    expect(rls).toEqual([
      { relname: "byok_consents", on: true, forced: true },
      { relname: "byok_keys", on: true, forced: true },
    ]);
    const row = (byok: boolean, cost: number) => h.pg`
      insert into platform.llm_calls (org_id, call_type, tier, provider, model_id, status, route_reason, policy_version,
        scrubbed, cost_rub, credits_milli, billable, mode, byok)
      values (${DEFAULT_ORG_ID}, 'page_compose', 'T1', 'byok:openai', 'byok:m', 'ok', 'default_T1', 'v', true,
        ${cost}, 0, false, 'live', ${byok})`;
    await row(true, 0);
    await expect(row(true, 1.5)).rejects.toThrow(/llm_calls_byok_free/);
  });

  test("0042 (V3-21): secret_* under forced RLS by org; one open window per key; a closed window keeps no key; gone with the system", async () => {
    const rls = await h.pg<{ relname: string; on: boolean; forced: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'platform' and c.relname in ('secret_bindings', 'secret_windows') order by c.relname`;
    expect(rls).toEqual([
      { relname: "secret_bindings", on: true, forced: true },
      { relname: "secret_windows", on: true, forced: true },
    ]);
    const [sys] = await h.pg`
      insert into platform.systems (org_id, slug, schema_key, name, pending_questions, created_by)
      values (${DEFAULT_ORG_ID}, 'key-window-mig', 'a0b1c2d3e4f5', 'Окно ключа', '[]'::jsonb, ${DEV_USER_ID})
      returning id`;
    const systemId = sys?.id as string;
    // A role without SUPERUSER/BYPASSRLS, as the platform login is in the cloud (the test login is a superuser).
    await h.pg.unsafe(`DO $$ BEGIN
      CREATE ROLE wz_secret_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
    await h.pg.unsafe("GRANT USAGE ON SCHEMA platform TO wz_secret_rls_probe");
    await h.pg.unsafe(
      "GRANT SELECT, INSERT, UPDATE ON platform.secret_windows, platform.secret_bindings TO wz_secret_rls_probe",
    );
    const as = <T>(org: string | null, fn: (tx: typeof h.pg) => Promise<T>) =>
      h.pg.begin(async (tx) => {
        await tx`set local role wz_secret_rls_probe`;
        if (org) await tx`select pg_catalog.set_config('wizard.org_id', ${org}, true)`;
        return fn(tx as unknown as typeof h.pg);
      }) as Promise<T>;
    const scoped = <T>(fn: (tx: typeof h.pg) => Promise<T>) => as(DEFAULT_ORG_ID, fn);
    const visible = async (org: string | null) =>
      (await as(org, (tx) => tx`select id from platform.secret_windows where system_id = ${systemId}`))
        .length;
    const window = (tx: typeof h.pg, extra = "") =>
      tx.unsafe(
        `insert into platform.secret_windows (org_id, system_id, env, name, integration_id, hosts, purpose, requested_by,
           expires_at, public_jwk, sealed_private, wrapped_dek, kek_backend, kek_name ${extra ? ", status, closed_at" : ""})
         values ($1, $2, 'draft', 'crm_key', 'crm', '["api.partner-crm.ru"]', 'Подключить CRM', 'agent',
           pg_catalog.now() + interval '1 day', '{"kty":"EC"}', 'AAAA', 'local:v1:AAAA', 'local', 'secret-window'
           ${extra ? ", 'filled', pg_catalog.now()" : ""})
         returning id`,
        [DEFAULT_ORG_ID, systemId],
      );
    const [w] = await scoped((tx) => window(tx));
    expect(w?.id).toBeTruthy();
    // Outside the org scope (or in another org's) the rows are invisible and cannot be written.
    expect(await visible(DEFAULT_ORG_ID)).toBe(1);
    expect(await visible(null)).toBe(0);
    expect(await visible("00000000-0000-4000-8000-0000000000aa")).toBe(0);
    await expect(as(null, (tx) => window(tx))).rejects.toThrow(/row-level security/);
    // One open window per (system, env, name); a used window keeps neither half of the key pair.
    await expect(scoped((tx) => window(tx))).rejects.toThrow(/secret_windows_open_key/);
    await expect(scoped((tx) => window(tx, "filled"))).rejects.toThrow(/secret_windows_shredded/);
    await scoped(
      (tx) => tx`
        insert into platform.secret_bindings (org_id, system_id, env, name, integration_id, hosts, last4, status, window_id)
        values (${DEFAULT_ORG_ID}, ${systemId}, 'draft', 'crm_key', 'crm', '["api.partner-crm.ru"]'::jsonb, 'abcd', 'ok',
                ${w?.id as string})`,
    );
    await expect(
      scoped(
        (tx) => tx`
          insert into platform.secret_bindings (org_id, system_id, env, name, hosts, last4, status)
          values (${DEFAULT_ORG_ID}, ${systemId}, 'prod', 'crm_key', '["a.ru"]'::jsonb, 'abcde', 'ok')`,
      ),
    ).rejects.toThrow(/last4/);
    await h.pg`delete from platform.systems where id = ${systemId}`;
    const left = await scoped(
      (tx) => tx`
        select (select count(*) from platform.secret_windows where system_id = ${systemId})::int as w,
               (select count(*) from platform.secret_bindings where system_id = ${systemId})::int as b`,
    );
    expect(left[0]).toEqual({ w: 0, b: 0 });
  });
});

describe("0043 (V3-31): repository sync", () => {
  const T = [
    "system_repo_deliveries",
    "system_repo_imports",
    "system_repo_jobs",
    "system_repo_links",
    "system_repo_prs",
  ];

  test("forced RLS by org on every table; the dispatch read policy only on links and jobs, SELECT only", async () => {
    const rls = await h.pg<{ relname: string; on: boolean; forced: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'platform' and c.relname in ${h.pg(T)} order by c.relname`;
    expect(rls).toEqual(T.map((relname) => ({ relname, on: true, forced: true })));
    const pol = await h.pg<{ tablename: string; policyname: string; cmd: string }[]>`
      select tablename, policyname, cmd from pg_catalog.pg_policies
      where schemaname = 'platform' and tablename in ${h.pg(T)} order by tablename, policyname`;
    expect(pol.filter((p) => p.policyname.endsWith("_dispatch"))).toEqual([
      { tablename: "system_repo_jobs", policyname: "system_repo_jobs_dispatch", cmd: "SELECT" },
      { tablename: "system_repo_links", policyname: "system_repo_links_dispatch", cmd: "SELECT" },
    ]);
    expect(pol.filter((p) => p.policyname.endsWith("_org")).map((p) => p.cmd)).toEqual(T.map(() => "ALL"));
  });

  test("tokens only sealed, one waiting job per key, an imported head names its revision, all go with the link", async () => {
    const [sys] = await h.pg<{ id: string }[]>`
      insert into platform.systems (org_id, slug, schema_key, name, pending_questions, created_by)
      values (${DEFAULT_ORG_ID}, 'mig-repo-sync', 'migreposync1', 'Синхронизация', '[]', ${DEV_USER_ID}) returning id`;
    const systemId = sys?.id as string;
    const inOrg = async <R>(fn: (sql: TransactionSql) => Promise<R>): Promise<R> => {
      let out: R | undefined;
      await h.pg.begin(async (sql) => {
        await sql`select pg_catalog.set_config('wizard.org_id', ${DEFAULT_ORG_ID}, true)`;
        out = await fn(sql);
      });
      return out as R;
    };
    await expect(
      inOrg(
        (
          sql,
        ) => sql`insert into platform.system_repo_links (org_id, system_id, provider, host_url, secret_ref, ciphertext)
          values (${DEFAULT_ORG_ID}, ${systemId}, 'gitlab', 'https://gitlab.example.ru', 'secret://repo/gitlab', 'Z2xh')`,
      ),
    ).rejects.toThrow(/system_repo_links_sealed/);
    const [link] = await inOrg(
      (sql) => sql<
        { id: string }[]
      >`insert into platform.system_repo_links (org_id, system_id, provider, host_url, secret_ref)
        values (${DEFAULT_ORG_ID}, ${systemId}, 'gitlab', 'https://gitlab.example.ru', 'secret://repo/gitlab') returning id`,
    );
    const linkId = link?.id as string;
    const job = () =>
      inOrg(
        (sql) => sql`insert into platform.system_repo_jobs (org_id, system_id, link_id, kind, dedupe_key)
          values (${DEFAULT_ORG_ID}, ${systemId}, ${linkId}, 'push', 'push')`,
      );
    await job();
    await expect(job()).rejects.toThrow(/system_repo_jobs_dedupe_idx/);
    await inOrg(
      (sql) => sql`update platform.system_repo_jobs set status = 'running' where link_id = ${linkId}`,
    );
    await job();
    await expect(
      inOrg(
        (
          sql,
        ) => sql`insert into platform.system_repo_imports (org_id, system_id, link_id, head_oid, source, status)
          values (${DEFAULT_ORG_ID}, ${systemId}, ${linkId}, ${"b".repeat(40)}, 'webhook', 'imported')`,
      ),
    ).rejects.toThrow(/system_repo_imports_revision/);
    await inOrg(
      (
        sql,
      ) => sql`insert into platform.system_repo_imports (org_id, system_id, link_id, head_oid, source, status)
        values (${DEFAULT_ORG_ID}, ${systemId}, ${linkId}, ${"a".repeat(40)}, 'webhook', 'noop')`,
    );
    const left = await inOrg(async (sql) => {
      await sql`delete from platform.system_repo_links where id = ${linkId}`;
      return sql<{ n: number }[]>`
        select ((select count(*) from platform.system_repo_jobs where system_id = ${systemId})
              + (select count(*) from platform.system_repo_imports where system_id = ${systemId}))::int as n`;
    });
    expect(left[0]?.n).toBe(0);
  });
});

describe("0044 (V3-32): the agent for compatible repositories, previews of developers' PRs", () => {
  const T = ["agent_repo_tasks", "agent_repos", "system_repo_pr_previews"];
  const inOrg = async <R>(fn: (sql: TransactionSql) => Promise<R>): Promise<R> => {
    let out: R | undefined;
    await h.pg.begin(async (sql) => {
      await sql`select pg_catalog.set_config('wizard.org_id', ${DEFAULT_ORG_ID}, true)`;
      out = await fn(sql);
    });
    return out as R;
  };

  test("forced RLS by org; the dispatch read policy only on agent_repos and agent_repo_tasks, SELECT only", async () => {
    const rls = await h.pg<{ relname: string; on: boolean; forced: boolean }[]>`
      select c.relname, c.relrowsecurity as on, c.relforcerowsecurity as forced
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'platform' and c.relname in ${h.pg(T)} order by c.relname`;
    expect(rls).toEqual(T.map((relname) => ({ relname, on: true, forced: true })));
    const pol = await h.pg<{ tablename: string; policyname: string; cmd: string }[]>`
      select tablename, policyname, cmd from pg_catalog.pg_policies
      where schemaname = 'platform' and tablename in ${h.pg(T)} order by tablename, policyname`;
    expect(pol.filter((p) => p.policyname.endsWith("_dispatch"))).toEqual([
      { tablename: "agent_repo_tasks", policyname: "agent_repo_tasks_dispatch", cmd: "SELECT" },
      { tablename: "agent_repos", policyname: "agent_repos_dispatch", cmd: "SELECT" },
    ]);
    expect(pol.filter((p) => p.policyname.endsWith("_org")).map((p) => p.cmd)).toEqual(T.map(() => "ALL"));
  });

  test("tokens only sealed; one waiting check per repository; a change has its words; tasks go with the repository", async () => {
    await expect(
      inOrg(
        (sql) => sql`insert into platform.agent_repos (org_id, provider, host_url, secret_ref, ciphertext)
          values (${DEFAULT_ORG_ID}, 'gitlab', 'https://gitlab.example.ru', 'secret://repo/gitlab', 'Z2xh')`,
      ),
    ).rejects.toThrow(/agent_repos_sealed/);
    await expect(
      inOrg(
        (sql) => sql`insert into platform.agent_repos (org_id, provider, host_url, secret_ref, status)
          values (${DEFAULT_ORG_ID}, 'gitlab', 'https://gitlab.example.ru', 'secret://repo/gitlab', 'ready')`,
      ),
    ).rejects.toThrow(/agent_repos_repo/);
    const [repo] = await inOrg(
      (sql) => sql<{ id: string }[]>`insert into platform.agent_repos (org_id, provider, host_url, secret_ref)
        values (${DEFAULT_ORG_ID}, 'gitlab', 'https://gitlab.example.ru', 'secret://repo/gitlab') returning id`,
    );
    const repoId = repo?.id as string;
    const check = () =>
      inOrg(
        (sql) =>
          sql`insert into platform.agent_repo_tasks (org_id, repo_id, kind) values (${DEFAULT_ORG_ID}, ${repoId}, 'check')`,
      );
    await check();
    await expect(check()).rejects.toThrow(/agent_repo_tasks_once_idx/);
    await expect(
      inOrg(
        (sql) =>
          sql`insert into platform.agent_repo_tasks (org_id, repo_id, kind) values (${DEFAULT_ORG_ID}, ${repoId}, 'change')`,
      ),
    ).rejects.toThrow(/agent_repo_tasks_text/);
    await expect(
      inOrg(
        (sql) => sql`insert into platform.agent_repo_tasks (org_id, repo_id, kind, task_ru, branch)
          values (${DEFAULT_ORG_ID}, ${repoId}, 'change', 'Кнопка', 'feature/x')`,
      ),
    ).rejects.toThrow(/agent_repo_tasks_branch_check/);
    await inOrg(
      (sql) => sql`insert into platform.agent_repo_tasks (org_id, repo_id, kind, task_ru)
        values (${DEFAULT_ORG_ID}, ${repoId}, 'change', 'Кнопка')`,
    );
    const left = await inOrg(async (sql) => {
      await sql`delete from platform.agent_repos where id = ${repoId}`;
      return sql<
        { n: number }[]
      >`select count(*)::int as n from platform.agent_repo_tasks where repo_id = ${repoId}`;
    });
    expect(left[0]?.n).toBe(0);
  });

  test("the sync queue knows pr_preview; a failed preview needs its reason; previews go with the link", async () => {
    const [sys] = await h.pg<{ id: string }[]>`
      insert into platform.systems (org_id, slug, schema_key, name, pending_questions, created_by)
      values (${DEFAULT_ORG_ID}, 'mig-pr-preview', 'migprpreview', 'Превью PR', '[]', ${DEV_USER_ID}) returning id`;
    const systemId = sys?.id as string;
    const [link] = await inOrg(
      (sql) => sql<
        { id: string }[]
      >`insert into platform.system_repo_links (org_id, system_id, provider, host_url, secret_ref)
        values (${DEFAULT_ORG_ID}, ${systemId}, 'gitlab', 'https://gitlab.example.ru', 'secret://repo/gitlab') returning id`,
    );
    const linkId = link?.id as string;
    await inOrg(
      (sql) => sql`insert into platform.system_repo_jobs (org_id, system_id, link_id, kind, dedupe_key)
        values (${DEFAULT_ORG_ID}, ${systemId}, ${linkId}, 'pr_preview', 'pr:7')`,
    );
    await expect(
      inOrg(
        (sql) => sql`insert into platform.system_repo_jobs (org_id, system_id, link_id, kind, dedupe_key)
          values (${DEFAULT_ORG_ID}, ${systemId}, ${linkId}, 'deploy', 'x')`,
      ),
    ).rejects.toThrow(/system_repo_jobs_kind_check/);
    await expect(
      inOrg(
        (
          sql,
        ) => sql`insert into platform.system_repo_pr_previews (org_id, system_id, link_id, number, head_oid, status)
          values (${DEFAULT_ORG_ID}, ${systemId}, ${linkId}, 7, ${"c".repeat(40)}, 'failed')`,
      ),
    ).rejects.toThrow(/system_repo_pr_previews_reason/);
    const left = await inOrg(async (sql) => {
      await sql`insert into platform.system_repo_pr_previews (org_id, system_id, link_id, number, head_oid)
        values (${DEFAULT_ORG_ID}, ${systemId}, ${linkId}, 7, ${"c".repeat(40)})`;
      await sql`delete from platform.system_repo_links where id = ${linkId}`;
      return sql<
        { n: number }[]
      >`select count(*)::int as n from platform.system_repo_pr_previews where system_id = ${systemId}`;
    });
    expect(left[0]?.n).toBe(0);
  });
});
