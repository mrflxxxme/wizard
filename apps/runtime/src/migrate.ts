// Schema helper for previews, G1 and tests: runs planMigration + toDDL for a system schema in ONE transaction,
// one statement per call (ops.yaml#migrations.sql_values). The runtime itself never runs DDL: call this with the
// migration role's connection (M0: wizard_owner), not with wizard_runtime.
import { type AppSpec, type MigrationPlan, planMigration, toDDL } from "@wizard/appspec";
import type postgres from "postgres";
import type { SystemEnv } from "./registry.js";

/** app_<systemId>_<env> (architecture.yaml#data_stores.apps_db). */
export function schemaName(systemId: string, env: SystemEnv): string {
  return `app_${systemId}_${env}`;
}

export interface MigrateOptions {
  systemId: string;
  env: SystemEnv;
  spec: AppSpec;
  prev?: AppSpec | null;
  /** Receives USAGE + DML grants (runtime.yaml#postgres.roles). Default: wizard_runtime. */
  runtimeRole?: string;
}

export async function migrateSystem(sql: postgres.Sql, o: MigrateOptions): Promise<MigrationPlan> {
  const plan = planMigration(o.prev ?? null, o.spec, { env: o.env });
  const statements = toDDL(plan, schemaName(o.systemId, o.env), {
    runtimeRole: o.runtimeRole ?? "wizard_runtime",
  });
  await sql.begin(async (tx) => {
    for (const s of statements) await tx.unsafe(s);
  });
  return plan;
}
