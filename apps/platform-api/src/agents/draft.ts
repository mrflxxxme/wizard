// Build steps after G0 passed (workflows.yaml#workflows.build): migrate_draft, seed_draft, bundle_and_reload.
import { createHash } from "node:crypto";
import { type AppSpec, planMigration, quoteIdent, SYSTEM_ROLE, toDDL } from "@wizard/appspec";
import { buildSystem, writeArtifact } from "@wizard/build";
import { generateSeed } from "@wizard/gates";
import { schemaName } from "@wizard/runtime";
import type postgres from "postgres";
import { RunFailure } from "../runs/types.js";
import { upgradeSystemTables } from "./system-tables.js";

/** architecture.yaml#data_stores.db_roles: M0 migrator (not the platform owner, not a superuser) and runtime role. */
export const MIGRATOR_ROLE = "wizard_owner";
export const RUNTIME_ROLE = "wizard_runtime";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function schemaExists(pg: postgres.Sql, schema: string): Promise<boolean> {
  const rows = await pg`select 1 from pg_namespace where nspname = ${schema}`;
  return rows.length > 0;
}

async function asMigrator(pg: postgres.Sql, role: string, statements: readonly string[]): Promise<void> {
  await pg.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`);
    for (const st of statements) await tx.unsafe(st);
  });
}

export interface MigrateDraftInput {
  systemKey: string;
  spec: AppSpec;
  /** Spec the draft schema holds now (preview_revision), or null. */
  prevSpec: AppSpec | null;
  migratorRole?: string;
  runtimeRole?: string;
}

/**
 * migrate_draft: planMigration(prev, spec, draft) → toDDL + toRLS in app_<key>_draft as the migrator role. When the
 * schema is new, unknown (no preview) or the incremental plan cannot be applied, the schema is recreated (M0).
 * Returns created=true when the schema was (re)created — seed_draft runs only then (L2-04).
 */
export async function migrateDraft(pg: postgres.Sql, i: MigrateDraftInput): Promise<{ created: boolean }> {
  const role = i.migratorRole ?? MIGRATOR_ROLE;
  const runtimeRole = i.runtimeRole ?? RUNTIME_ROLE;
  const schema = schemaName(i.systemKey, "draft");
  const fresh = async () => {
    const ddl = toDDL(planMigration(null, i.spec, { env: "draft" }), schema, { runtimeRole });
    await asMigrator(pg, role, [`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`, ...ddl]);
    return { created: true };
  };
  try {
    if (!(await schemaExists(pg, schema)) || i.prevSpec === null) return await fresh();
    const plan = planMigration(i.prevSpec, i.spec, { env: "draft" });
    if (plan.errors.length > 0) return await fresh();
    try {
      await asMigrator(pg, role, [...upgradeSystemTables(schema), ...toDDL(plan, schema, { runtimeRole })]);
      return { created: false };
    } catch {
      return await fresh(); // e.g. incompatible column types: draft data is disposable
    }
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    throw new RunFailure(
      "MIGRATION_FAILED",
      `Не удалось обновить базу черновика${code ? ` (${code})` : ""}. Попробуйте ещё раз.`,
      true,
    );
  }
}

async function insertRow(
  tx: postgres.TransactionSql,
  schema: string,
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const cols = Object.keys(row);
  const values = cols.map((c) => {
    const v = row[c];
    return (v !== null && typeof v === "object" ? JSON.stringify(v) : v) as never;
  });
  await tx.unsafe(
    `insert into ${quoteIdent(schema)}.${quoteIdent(table)} (${cols.map(quoteIdent).join(", ")}) values (${cols
      .map((_, n) => `$${n + 1}`)
      .join(", ")}) on conflict do nothing`,
    values,
  );
}

/** seed_draft: generateSeed(spec, sha256(systemKey)) (qa.yaml#seed) + a dev-<role> user per login role. */
export async function seedDraft(
  pg: postgres.Sql,
  i: { systemKey: string; spec: AppSpec; migratorRole?: string },
): Promise<{ users: number; rows: number }> {
  const schema = schemaName(i.systemKey, "draft");
  const seed = generateSeed(i.spec, sha256(i.systemKey));
  let rows = 0;
  let users = 0;
  await pg.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(i.migratorRole ?? MIGRATOR_ROLE)}`);
    await tx.unsafe("select set_config('wizard.role', $1, true)", [SYSTEM_ROLE]);
    for (const u of seed.users) {
      await insertRow(tx, schema, "users", { ...u });
      users += 1;
    }
    // Same identity as the runtime's dev-login (apps/runtime auth/session.ts devUser).
    for (const r of i.spec.roles.filter((x) => x.access === "login")) {
      await insertRow(tx, schema, "users", {
        role: r.name,
        display_name: `dev-${r.name}`,
        email: `dev-${r.name}@dev.localhost`,
      });
      users += 1;
    }
    for (const name of seed.order)
      for (const row of seed.rows[name] ?? []) {
        await insertRow(tx, schema, name, row);
        rows += 1;
      }
  });
  return { users, rows };
}

export interface BundleDraftInput {
  artifactsDir: string;
  systemKey: string;
  revision: number;
  /** The spec the draft runs (consentText filled by the platform). */
  spec: AppSpec;
  files: ReadonlyMap<string, string>;
  platformOrigin: string;
  /** platform.deployments.spec_hash of the revision: the runtime checks manifest.specHash against it. */
  specHash: string;
}

/** bundle_and_reload: packages/build → writeArtifact in runtime.yaml#system_loading.artifact_layout. */
export async function bundleDraft(i: BundleDraftInput): Promise<{ bundleKey: string; dir: string }> {
  const result = await buildSystem({
    spec: i.spec,
    files: i.files,
    env: "draft",
    platformOrigin: i.platformOrigin,
  });
  if (!result.ok)
    throw new RunFailure(
      "INTERNAL",
      "Не удалось собрать превью, хотя проверки прошли. Запустите сборку ещё раз.",
      true,
    );
  const written = writeArtifact(i.artifactsDir, i.systemKey, i.revision, {
    ...result,
    manifest: { ...result.manifest, specHash: i.specHash },
  });
  return { bundleKey: written.bundleKey, dir: written.dir };
}
