import { Kysely, type Migration, type MigrationProvider, Migrator, type RawBuilder, sql } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import * as m0001 from "../../migrations/0001_m0.js";
import * as m0002 from "../../migrations/0002_m1_accounts.js";
import * as m0003 from "../../migrations/0003_m1_publications.js";
import * as m0004 from "../../migrations/0004_m1_credits.js";
import * as m0005 from "../../migrations/0005_m1_imports.js";
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
