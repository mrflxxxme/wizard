// Schema helper for previews, G1 and tests: runs planMigration + toDDL for a system schema in ONE transaction,
// one statement per call (ops.yaml#migrations.sql_values). The runtime itself never runs DDL: call this with the
// migration role's connection (M0: wizard_owner), not with wizard_runtime.
import {
  type AppSpec,
  dropSystemRoleDDL,
  type MigrationPlan,
  planMigration,
  systemRoleName,
  toDDL,
  toSystemRoleDDL,
} from "@wizard/appspec";
import type postgres from "postgres";
import type { SystemEnv } from "./registry.js";

/** app_<systemId>_<env> (architecture.yaml#data_stores.apps_db). */
export function schemaName(systemId: string, env: SystemEnv): string {
  return `app_${systemId}_${env}`;
}

/** sys_<systemId>_<env>_system: DB role of system access to app_<systemId>_<env> (isolation.yaml#db_access, L3-20). */
export function systemRoleOf(systemId: string, env: SystemEnv): string {
  return systemRoleName(schemaName(systemId, env));
}

export interface MigrateOptions {
  systemId: string;
  env: SystemEnv;
  spec: AppSpec;
  prev?: AppSpec | null;
  /** Receives USAGE + DML grants (runtime.yaml#postgres.roles). Default: wizard_runtime. */
  runtimeRole?: string;
  /** Extra roles allowed to switch to the system role besides runtimeRole (e.g. a platform migrator). */
  systemRoleMembers?: readonly string[];
}

/**
 * Creates the system role (connecting role needs CREATEROLE: locally the `wizard` owner; in the cloud the platform
 * provisioner) and grants SET on it to `members` and to the connecting session user (role switching is checked against
 * the session user: seeds, exports and deletion run on this connection). Idempotent; call before
 * toDDL(..., {systemRole}).
 */
export async function ensureSystemRole(
  sql: postgres.Sql,
  systemId: string,
  env: SystemEnv,
  members: readonly string[],
): Promise<string> {
  const [who] = await sql<{ u: string }[]>`select session_user as u`;
  const all = [...new Set([...members, ...(who ? [who.u] : [])])];
  for (const s of toSystemRoleDDL(schemaName(systemId, env), { members: all })) await sql.unsafe(s);
  return systemRoleOf(systemId, env);
}

/** Drops the system role after its schema is gone (delete_system, tests). */
export async function dropSystemRole(sql: postgres.Sql, systemId: string, env: SystemEnv): Promise<void> {
  for (const s of dropSystemRoleDDL(schemaName(systemId, env))) await sql.unsafe(s);
}

export async function migrateSystem(sql: postgres.Sql, o: MigrateOptions): Promise<MigrationPlan> {
  const plan = planMigration(o.prev ?? null, o.spec, { env: o.env });
  const runtimeRole = o.runtimeRole ?? "wizard_runtime";
  const systemRole = await ensureSystemRole(sql, o.systemId, o.env, [
    runtimeRole,
    ...(o.systemRoleMembers ?? []),
  ]);
  const statements = toDDL(plan, schemaName(o.systemId, o.env), { runtimeRole, systemRole });
  await sql.begin(async (tx) => {
    for (const s of statements) await tx.unsafe(s);
  });
  return plan;
}
