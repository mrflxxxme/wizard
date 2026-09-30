import { Kysely, type Migration, type MigrationProvider, Migrator, type RawBuilder, sql } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import * as m0001 from "../../migrations/0001_m0.js";
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

const MIGRATIONS: Record<string, Migration> = { "0001_m0": m0001 };

const provider: MigrationProvider = { getMigrations: async () => MIGRATIONS };

/** Applies pending migrations (one transaction; each migration sets its lock_timeout) and the M0 seed. */
export async function migrate(db: Db): Promise<void> {
  const migrator = new Migrator({
    db,
    provider,
    migrationTableSchema: "platform",
  });
  const { error, results } = await migrator.migrateToLatest();
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
    .values({ id: DEFAULT_ORG_ID, name: "Локальная организация", plan: "free" })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await db
    .insertInto("platform.memberships")
    .values({ org_id: DEFAULT_ORG_ID, user_id: DEV_USER_ID, role: "owner" })
    .onConflict((oc) => oc.doNothing())
    .execute();
}
