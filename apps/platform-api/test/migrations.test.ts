// Acceptance M0-15: after migrate, columns of M0 tables match specs/platform/db.yaml (the test parses the YAML).
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
/** Columns beyond db.yaml (none: card_fingerprint, payments.meta and draft_purge_notice_at are in db.yaml since the 2026-10-01 spec sync). */
const EXTRA_COLUMNS: Record<string, Record<string, { type: string; notNull: boolean }>> = {};
const checked = [
  ...m0,
  ...Object.entries(dbYaml.tables).filter(
    ([n]) => M1_TABLES.includes(n) || M2_TABLES.includes(n) || M3_TABLES.includes(n) || B2_TABLES.includes(n),
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
});
