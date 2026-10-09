// workflows.yaml#delete_system (L3-36): a system soft-deleted by its owner (systems.deleted_at) is purged 30 days later
// in the retention_cron pass: DROP SCHEMA app_<key>_{draft,prod}, artifacts (bundles, blobs no other system references),
// messages, imports, exports, secrets_refs and their stored values, objects of file fields (M2-14); deletion_log
// mode=system_deleted. No platform.runs row.
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { archiveSchemaName, dropSystemRoleDDL, quoteIdent, systemRoleName } from "@wizard/appspec";
import { createFileStorage, type FileStorage, purgeSchemaFiles, schemaName } from "@wizard/runtime";
import type postgres from "postgres";
import { MIGRATOR_ROLE } from "../agents/draft.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { ExportStore } from "../exports/storage.js";
import { ImportStore } from "../imports/storage.js";
import { SecretStore } from "../secrets/store.js";
import { BlobStore, sha256 } from "../storage/blobs.js";
import { collectDeletionLogs, ENVS } from "./deletion-log.js";

/** Days between systems.deleted_at and the purge (compliance.yaml#platform.retention). */
export const SYSTEM_PURGE_DAYS = 30;
const DAY_MS = 86_400_000;
const KEY_RE = /^[a-z0-9]+$/;
/** The empty files manifest is shared by every system and recreated on demand; never purged. */
const EMPTY_MANIFEST_SHA = sha256("{}");

export interface PurgeDeps {
  db: Db;
  pg: postgres.Sql;
  blobs: BlobStore;
  config: Pick<Config, "artifactsDir" | "importsDir" | "secretsFile" | "secretsKey">;
  migratorRole?: string;
  log?: (msg: string, err?: unknown) => void;
  /**
   * Storage of file fields shared with the runtime (runtime.yaml#files.storage); default from env
   * (WIZARD_FILES_STORAGE, folder <artifactsDir>/../files like the runtime).
   */
  files?: FileStorage;
}

/** The file storage of the deps or the env default (the runtime resolves the same one). */
export function fileStorageOf(d: Pick<PurgeDeps, "files" | "config">): FileStorage {
  return (
    d.files ?? createFileStorage(process.env, { defaultDir: join(dirname(d.config.artifactsDir), "files") })
  );
}

export interface PurgedSystem {
  systemId: string;
  schemas: string[];
  rows: number;
  blobs: number;
  /** Objects of file fields deleted (both envs). */
  files: number;
}

/** Blob shas a revision set references: files manifests and the files they list. Missing blobs are skipped. */
async function referencedBlobs(
  db: Db,
  blobs: BlobStore,
  scope: { only?: readonly string[]; except?: readonly string[] },
): Promise<Set<string>> {
  let q = db.selectFrom("platform.revisions").select("files_manifest_sha").distinct();
  if (scope.only) q = q.where("system_id", "in", scope.only.length ? [...scope.only] : [""]);
  if (scope.except?.length) q = q.where("system_id", "not in", [...scope.except]);
  const out = new Set<string>();
  for (const { files_manifest_sha: m } of await q.execute()) {
    out.add(m);
    if (m === EMPTY_MANIFEST_SHA) continue;
    try {
      const manifest = JSON.parse((await blobs.get(m)).toString("utf8")) as Record<string, string>;
      for (const sha of Object.values(manifest)) out.add(sha);
    } catch {
      // Already purged (a previous pass of a system sharing it) or unreadable: nothing more to collect.
    }
  }
  return out;
}

/** Rows of the system's own tables (users + entities) — the counter of the deletion_log entry. */
async function countRows(tx: postgres.TransactionSql, schema: string): Promise<number> {
  const tables = await tx<{ tablename: string }[]>`
    select tablename from pg_catalog.pg_tables where schemaname = ${schema} and tablename not like '\\_w\\_%'`;
  let n = 0;
  for (const t of tables) {
    const [r] = await tx.unsafe(
      `select count(*)::int as n from ${quoteIdent(schema)}.${quoteIdent(t.tablename)}`,
    );
    n += Number((r as { n: number } | undefined)?.n ?? 0);
  }
  return n;
}

/** Systems deleted more than 30 days ago and not purged yet (no system_deleted entry). */
export async function purgeCandidates(db: Db, now: Date): Promise<{ id: string; schema_key: string }[]> {
  return db
    .selectFrom("platform.systems as s")
    .select(["s.id", "s.schema_key"])
    .where("s.deleted_at", "is not", null)
    .where("s.deleted_at", "<=", new Date(now.getTime() - SYSTEM_PURGE_DAYS * DAY_MS))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("platform.deletion_log as l")
            .select("l.id")
            .whereRef("l.system_id", "=", "s.id")
            .where("l.mode", "=", "system_deleted"),
        ),
      ),
    )
    .orderBy("s.deleted_at")
    .limit(100)
    .execute();
}

/**
 * One delete_system pass. Files go first (idempotent), then one transaction drops the schemas, deletes the platform
 * rows and writes system_deleted — a crash in between repeats the pass, never leaves data behind a journal entry.
 */
export async function purgeDeletedSystems(d: PurgeDeps, now = new Date()): Promise<PurgedSystem[]> {
  const candidates = await purgeCandidates(d.db, now);
  if (candidates.length === 0) return [];
  const ids = candidates.map((c) => c.id);
  const shared = await referencedBlobs(d.db, d.blobs, { except: ids });
  const imports = new ImportStore(d.config.importsDir, d.config.secretsKey);
  const exports = new ExportStore(d.config.artifactsDir, d.config.secretsKey);
  const secrets = new SecretStore(d.config.secretsFile, d.config.secretsKey);
  const role = d.migratorRole ?? MIGRATOR_ROLE;
  const storage = fileStorageOf(d);
  const out: PurgedSystem[] = [];
  for (const s of candidates) {
    try {
      // The runtime's journal of this system first: it is the record of what was erased before.
      await collectDeletionLogs(d.pg, {
        systemId: s.id,
        migratorRole: role,
        ...(d.log ? { log: d.log } : {}),
      });
      const own = [...(await referencedBlobs(d.db, d.blobs, { only: [s.id] }))].filter(
        (sha) => !shared.has(sha) && sha !== EMPTY_MANIFEST_SHA,
      );
      for (const r of await d.db
        .selectFrom("platform.imports")
        .select("id")
        .where("system_id", "=", s.id)
        .execute())
        await imports.remove(r.id);
      for (const r of await d.db
        .selectFrom("platform.exports")
        .select("id")
        .where("system_id", "=", s.id)
        .execute())
        await exports.remove(r.id);
      secrets.removeSystem(s.id);
      let files = 0;
      if (KEY_RE.test(s.schema_key)) {
        await rm(join(d.config.artifactsDir, s.schema_key), { recursive: true, force: true });
        for (const env of ENVS) files += await purgeSchemaFiles(storage, schemaName(s.schema_key, env));
      }
      for (const sha of own) await rm(join(d.blobs.root, BlobStore.key(sha)), { force: true });

      const purged = await d.pg.begin(async (tx) => {
        const dropped: { env: string; schema: string; rows: number }[] = [];
        for (const env of ENVS) {
          const schema = schemaName(s.schema_key, env);
          const [exists] = await tx`select 1 from pg_catalog.pg_namespace where nspname = ${schema}`;
          if (!exists) continue;
          // Rows are counted as the system DB role (FORCE RLS, L3-20); the schema is dropped by its owner.
          await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(systemRoleName(schema))}`);
          dropped.push({ env, schema, rows: await countRows(tx, schema) });
          await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`);
          await tx.unsafe(`DROP SCHEMA ${quoteIdent(schema)} CASCADE`);
        }
        // M2-72: the prod archive (fields and entities removed by confirmed changes) goes with the system.
        await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(role)}`);
        await tx.unsafe(
          `DROP SCHEMA IF EXISTS ${quoteIdent(archiveSchemaName(schemaName(s.schema_key, "prod")))} CASCADE`,
        );
        await tx.unsafe("SET LOCAL ROLE NONE");
        // The system roles go with their schemas (dropped by the platform session, which created them).
        for (const env of ENVS)
          for (const st of dropSystemRoleDDL(schemaName(s.schema_key, env))) await tx.unsafe(st);
        await tx`delete from platform.messages where system_id = ${s.id}`;
        await tx`delete from platform.system_plans where system_id = ${s.id}`;
        await tx`delete from platform.system_briefs where system_id = ${s.id}`;
        await tx`delete from platform.system_build_checkpoints where system_id = ${s.id}`;
        // V3-30: the system repository (commits, refs, objects) goes with the system.
        await tx`delete from platform.system_git_commits where system_id = ${s.id}`;
        await tx`delete from platform.system_git_refs where system_id = ${s.id}`;
        await tx`delete from platform.system_git_objects where system_id = ${s.id}`;
        await tx`delete from platform.imports where system_id = ${s.id}`;
        await tx`delete from platform.exports where system_id = ${s.id}`;
        await tx`delete from platform.secrets_refs where system_id = ${s.id}`;
        if (own.length) await tx`delete from platform.files where sha256 in ${tx(own)}`;
        // One entry per dropped schema; a system that never got a schema still gets its marker.
        const entries = dropped.length ? dropped : [{ env: "draft", schema: "", rows: 0 }];
        for (const e of entries)
          await tx`
            insert into platform.deletion_log (system_id, env, entity, mode, cutoff, rows_affected)
            values (${s.id}, ${e.env}, '*', 'system_deleted', null, ${e.rows})`;
        return dropped;
      });
      out.push({
        systemId: s.id,
        schemas: purged.map((p) => p.schema),
        rows: purged.reduce((n, p) => n + p.rows, 0),
        blobs: own.length,
        files,
      });
    } catch (e) {
      d.log?.("delete_system failed", e);
    }
  }
  return out;
}
