import { Kysely, type Migration, type MigrationProvider, Migrator, type RawBuilder, sql } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import * as m0001 from "../../migrations/0001_m0.js";
import * as m0002 from "../../migrations/0002_m1_accounts.js";
import * as m0003 from "../../migrations/0003_m1_publications.js";
import * as m0004 from "../../migrations/0004_m1_credits.js";
import * as m0005 from "../../migrations/0005_m1_imports.js";
import * as m0006 from "../../migrations/0006_m2_exports.js";
import * as m0007 from "../../migrations/0007_m1_secrets.js";
import * as m0008 from "../../migrations/0008_m2_deletion_log.js";
import * as m0009 from "../../migrations/0009_m2_billing.js";
import * as m0010 from "../../migrations/0010_m2_moderation.js";
import * as m0011 from "../../migrations/0011_m2_draft_purge_notice.js";
import * as m0012 from "../../migrations/0012_m2_pilot.js";
import * as m0013 from "../../migrations/0013_m2_abuse.js";
import * as m0014 from "../../migrations/0014_m2_pilot_ops.js";
import * as m0015 from "../../migrations/0015_m2_ops_cleanup.js";
import * as m0016 from "../../migrations/0016_m3_ai_actions.js";
import * as m0017 from "../../migrations/0017_m2_pilot_admin.js";
import * as m0018 from "../../migrations/0018_db_roles.js";
import * as m0019 from "../../migrations/0019_g1_checks.js";
import * as m0020 from "../../migrations/0020_p_pilot_limits.js";
import * as m0021 from "../../migrations/0021_p_support.js";
import * as m0022 from "../../migrations/0022_p_development_requests.js";
import * as m0024 from "../../migrations/0024_m2_notify_owners.js";
import * as m0025 from "../../migrations/0025_p_destructive.js";
import * as m0031 from "../../migrations/0031_b2_org_kind.js";
import * as m0032 from "../../migrations/0032_b2_demo_replay.js";
import * as m0033 from "../../migrations/0033_b2_system_plans.js";
import * as m0034 from "../../migrations/0034_b2_build_checkpoints.js";
import * as m0035 from "../../migrations/0035_b2_module_factory.js";
import * as m0036 from "../../migrations/0036_v3_system_briefs.js";
import * as m0037 from "../../migrations/0037_v3_build_checkpoints.js";
import * as m0038 from "../../migrations/0038_v3_site_fingerprints.js";
import * as m0040 from "../../migrations/0040_v3_system_repos.js";
import type { DB } from "./types.js";

export type { DB } from "./types.js";
export type Db = Kysely<DB>;

export const DEFAULT_DB_URL = "postgres://wizard@localhost:5433/wizard";
export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
export const DEV_USER_ID = "00000000-0000-0000-0000-0000000000aa";
export const DEV_USER_EMAIL = "dev@wizard.local";

export interface DbHandle {
  db: Db;
  pg: postgres.Sql;
  close(): Promise<void>;
}

export function createDb(url: string = DEFAULT_DB_URL, max = 10): DbHandle {
  const pg = postgres(url, { max, onnotice: () => {} });
  const db = new Kysely<DB>({ dialect: new PostgresJSDialect({ postgres: pg }) });
  return { db, pg, close: () => db.destroy() };
}

/** jsonb parameter as text → jsonb (a bare jsonb-typed param would be JSON-encoded twice by postgres.js). */
export function json(value: unknown): RawBuilder<unknown> {
  return sql`cast(cast(${JSON.stringify(value ?? null)} as text) as jsonb)`;
}

const MIGRATIONS: Record<string, Migration> = {
  "0001_m0": m0001,
  "0002_m1_accounts": m0002,
  "0003_m1_publications": m0003,
  "0004_m1_credits": m0004,
  "0005_m1_imports": m0005,
  "0006_m2_exports": m0006,
  "0007_m1_secrets": m0007,
  "0008_m2_deletion_log": m0008,
  "0009_m2_billing": m0009,
  "0010_m2_moderation": m0010,
  "0011_m2_draft_purge_notice": m0011,
  "0012_m2_pilot": m0012,
  "0013_m2_abuse": m0013,
  "0014_m2_pilot_ops": m0014,
  "0015_m2_ops_cleanup": m0015,
  "0016_m3_ai_actions": m0016,
  "0017_m2_pilot_admin": m0017,
  "0018_db_roles": m0018,
  "0019_g1_checks": m0019,
  "0020_p_pilot_limits": m0020,
  "0021_p_support": m0021,
  "0022_p_development_requests": m0022,
  "0024_m2_notify_owners": m0024,
  "0025_p_destructive": m0025,
  "0031_b2_org_kind": m0031,
  "0032_b2_demo_replay": m0032,
  "0033_b2_system_plans": m0033,
  "0034_b2_build_checkpoints": m0034,
  "0035_b2_module_factory": m0035,
  "0036_v3_system_briefs": m0036,
  "0037_v3_build_checkpoints": m0037,
  "0038_v3_site_fingerprints": m0038,
  "0040_v3_system_repos": m0040,
};

const provider: MigrationProvider = { getMigrations: async () => MIGRATIONS };

/** Applies pending migrations (one transaction; each migration sets its lock_timeout) and the M0 seed. */
export async function migrate(db: Db): Promise<void> {
  const migrator = new Migrator({
    db,
    provider,
    migrationTableSchema: "platform",
  });
  let { error, results } = await migrator.migrateToLatest();
  // Kysely introspects every table of the database before migrating; a system schema dropped concurrently
  // (G1 ephemeral schemas, rollbacks) makes that query fail. Nothing was applied then, so retrying is safe.
  for (
    let i = 0;
    i < 3 && error && !results?.length && /schema ".*" does not exist/.test(String(error));
    i++
  ) {
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    ({ error, results } = await migrator.migrateToLatest());
  }
  if (error) {
    const failed = results?.find((r) => r.status === "Error")?.migrationName;
    throw new Error(`migration ${failed ?? "?"} failed: ${String(error)}`);
  }
  await seed(db);
}

/** db.yaml#seed_M0 — idempotent. */
export async function seed(db: Db): Promise<void> {
  await db
    .insertInto("platform.users")
    .values({ id: DEV_USER_ID, email: DEV_USER_EMAIL, name: "Разработчик" })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto("platform.orgs")
    // region_code 77 (Moscow): the local org is not T1-restricted by an unknown region (docs/reviews/impl-notes/M0-26.md).
    .values({ id: DEFAULT_ORG_ID, name: "Локальная организация", plan: "free", region_code: "77" })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto("platform.memberships")
    .values({ org_id: DEFAULT_ORG_ID, user_id: DEV_USER_ID, role: "owner" })
    .onConflict((oc) => oc.doNothing())
    .execute();
}
