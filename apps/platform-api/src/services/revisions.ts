// Revisions (db.yaml#revisions): each ops batch or file commit is one transaction creating one revision.
import { type ApplyOpsResult, type AppSpec, applyOps, emptySpec } from "@wizard/appspec";
import type { Kysely, Selectable } from "kysely";
import { type DB, json } from "../db/index.js";
import type { SystemsTable } from "../db/types.js";
import { appendEvent, type TxCtx } from "../runs/events.js";
import { type BlobStore, sha256 } from "../storage/blobs.js";

export type Manifest = Record<string, string>;
type Q = Kysely<DB>;

const OP_RU: Record<string, string> = {
  set_app: "Настройки приложения",
  set_theme: "Оформление",
  add_entity: "Добавлена сущность",
  update_entity: "Изменена сущность",
  remove_entity: "Удалена сущность",
  add_field: "Добавлено поле",
  update_field: "Изменено поле",
  remove_field: "Удалено поле",
  add_role: "Добавлена роль",
  update_role: "Изменена роль",
  remove_role: "Удалена роль",
  set_permission: "Права доступа",
  remove_permission: "Удалены права",
  add_workflow: "Добавлен процесс",
  update_workflow: "Изменён процесс",
  remove_workflow: "Удалён процесс",
  add_integration: "Добавлено подключение",
  update_integration: "Изменено подключение",
  remove_integration: "Удалено подключение",
  add_function: "Добавлена функция",
  remove_function: "Удалена функция",
  add_page: "Добавлена страница",
  update_page: "Изменена страница",
  remove_page: "Удалена страница",
  add_ai_action: "Добавлено ИИ-действие",
  set_acceptance: "Критерии приёмки",
  set_compliance: "Сведения об операторе ПДн",
};

/** Human diff lines (ops_applied.summary_ru). */
export function describeOps(ops: readonly unknown[]): string[] {
  return ops.map((raw) => {
    const op = (raw ?? {}) as Record<string, unknown>;
    const label = OP_RU[String(op.op)] ?? String(op.op);
    const target = [op.entity, op.name, op.field, op.role].filter((v) => typeof v === "string").join(".");
    return target ? `${label}: ${target}` : label;
  });
}

const EMPTY_MANIFEST = "{}";

export function manifestBytes(m: Manifest): Buffer {
  const sorted: Manifest = {};
  for (const k of Object.keys(m).sort()) sorted[k] = m[k] as string;
  return Buffer.from(JSON.stringify(sorted));
}

export async function loadRevision(q: Q, systemId: string, version: number) {
  return q
    .selectFrom("platform.revisions")
    .selectAll()
    .where("system_id", "=", systemId)
    .where("version", "=", version)
    .executeTakeFirst();
}

export async function loadSpec(
  q: Q,
  system: { id: string; name: string },
  version: number,
): Promise<AppSpec> {
  if (version === 0) return emptySpec(system.name);
  const rev = await loadRevision(q, system.id, version);
  if (!rev) throw new Error(`revision ${version} not found`);
  return rev.spec as unknown as AppSpec;
}

export async function loadManifest(
  q: Q,
  blobs: BlobStore,
  systemId: string,
  version: number,
): Promise<Manifest> {
  if (version === 0) return {};
  const rev = await loadRevision(q, systemId, version);
  if (!rev) throw new Error(`revision ${version} not found`);
  if (rev.files_manifest_sha === sha256(EMPTY_MANIFEST)) return {};
  return JSON.parse((await blobs.get(rev.files_manifest_sha)).toString("utf8")) as Manifest;
}

export async function lockSystem(t: TxCtx, systemId: string): Promise<Selectable<SystemsTable>> {
  return t.trx
    .selectFrom("platform.systems")
    .selectAll()
    .where("id", "=", systemId)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

interface InsertRevision {
  system: Selectable<SystemsTable>;
  kind: "ops" | "files" | "style" | "revert" | "compliance";
  author: "user" | "agent" | "system";
  authorUserId?: string | null;
  runId?: string | null;
  spec: unknown;
  ops: readonly unknown[];
  manifestSha: string;
  idempotencyKey?: string | null;
  summaryRu: string | null;
}

async function insertRevision(t: TxCtx, r: InsertRevision): Promise<number> {
  const version = r.system.draft_revision + 1;
  await t.trx
    .insertInto("platform.revisions")
    .values({
      system_id: r.system.id,
      version,
      parent_version: r.system.draft_revision === 0 ? null : r.system.draft_revision,
      kind: r.kind,
      author: r.author,
      author_user_id: r.authorUserId ?? null,
      run_id: r.runId ?? null,
      spec: json(r.spec),
      ops: json(r.ops),
      files_manifest_sha: r.manifestSha,
      idempotency_key: r.idempotencyKey ?? null,
      summary_ru: r.summaryRu,
    })
    .execute();
  await t.trx
    .updateTable("platform.systems")
    .set({ draft_revision: version, updated_at: new Date(), last_activity_at: new Date() })
    .where("id", "=", r.system.id)
    .execute();
  return version;
}

async function parentManifestSha(
  t: TxCtx,
  blobs: BlobStore,
  system: Selectable<SystemsTable>,
): Promise<string> {
  if (system.draft_revision > 0) {
    const parent = await loadRevision(t.trx, system.id, system.draft_revision);
    if (parent) return parent.files_manifest_sha;
  }
  return (await blobs.put(t.trx, Buffer.from(EMPTY_MANIFEST), "application/json")).sha256;
}

export interface ApplyOpsArgs {
  systemId: string;
  ops: readonly unknown[];
  expectedVersion: number;
  kind: "ops" | "style";
  author: "user" | "agent" | "system";
  authorUserId?: string | null;
  runId?: string | null;
  idempotencyKey?: string | null;
  env?: "draft" | "prod";
}

/** One ops batch = one revision; emits ops_applied when run-bound. Errors come back structurally. */
export async function applyOpsRevision(t: TxCtx, blobs: BlobStore, a: ApplyOpsArgs): Promise<ApplyOpsResult> {
  const system = await lockSystem(t, a.systemId);
  if (a.idempotencyKey) {
    const prev = await t.trx
      .selectFrom("platform.revisions")
      .selectAll()
      .where("system_id", "=", a.systemId)
      .where("idempotency_key", "=", a.idempotencyKey)
      .executeTakeFirst();
    if (prev) {
      const hit = {
        ok: true as const,
        spec: prev.spec as unknown as AppSpec,
        version: prev.version,
        revision: {
          version: prev.version,
          parentVersion: prev.parent_version ?? 0,
          kind: prev.kind as "ops",
          author: prev.author as "agent",
          ops: prev.ops as never,
          createdAt: new Date(prev.created_at).toISOString(),
          ...(prev.run_id ? { runId: prev.run_id } : {}),
        },
      };
      return hit;
    }
  }
  const spec = await loadSpec(t.trx, system, system.draft_revision);
  const res = applyOps(spec, a.ops, a.expectedVersion, {
    currentVersion: system.draft_revision,
    env: a.env ?? "draft",
    author: a.author,
    ...(a.runId ? { runId: a.runId } : {}),
  });
  if (!res.ok) return res;
  const summary = describeOps(a.ops);
  const version = await insertRevision(t, {
    system,
    kind: a.kind,
    author: a.author,
    authorUserId: a.authorUserId ?? null,
    runId: a.runId ?? null,
    spec: res.spec,
    ops: a.ops,
    manifestSha: await parentManifestSha(t, blobs, system),
    idempotencyKey: a.idempotencyKey ?? null,
    summaryRu: summary.join("; ").slice(0, 2000),
  });
  if (a.runId) {
    await appendEvent(t, a.runId, "ops_applied", {
      revision: version,
      opsCount: a.ops.length,
      opTypes: [...new Set(a.ops.map((o) => String((o as { op?: unknown }).op)))],
      summary_ru: summary,
    });
  }
  return { ...res, version, revision: { ...res.revision, version } };
}

export type FileChange = { path: string; content: Uint8Array | null };

/** Commits a set of file changes as one revision kind=files (or style); file_written per file when run-bound. */
export async function commitFilesRevision(
  t: TxCtx,
  blobs: BlobStore,
  a: {
    systemId: string;
    changes: FileChange[];
    runId?: string | null;
    author: "user" | "agent" | "system";
    authorUserId?: string | null;
    kind?: "files" | "style";
    spec?: unknown;
    ops?: readonly unknown[];
    summaryRu?: string;
    idempotencyKey?: string | null;
  },
): Promise<{ version: number; written: { path: string; action: string; sha256?: string; size?: number }[] }> {
  const system = await lockSystem(t, a.systemId);
  const manifest = await loadManifest(t.trx, blobs, system.id, system.draft_revision);
  const written: { path: string; action: string; sha256?: string; size?: number }[] = [];
  for (const ch of a.changes) {
    if (ch.content === null) {
      if (manifest[ch.path] !== undefined) {
        delete manifest[ch.path];
        written.push({ path: ch.path, action: "delete" });
      }
      continue;
    }
    const { sha256: sha, size } = await blobs.put(t.trx, ch.content, contentTypeOf(ch.path));
    const action = manifest[ch.path] === undefined ? "create" : "update";
    if (manifest[ch.path] === sha) continue;
    manifest[ch.path] = sha;
    written.push({ path: ch.path, action, sha256: sha, size });
  }
  const mBytes = manifestBytes(manifest);
  const mSha =
    Object.keys(manifest).length === 0
      ? (await blobs.put(t.trx, Buffer.from(EMPTY_MANIFEST), "application/json")).sha256
      : (await blobs.put(t.trx, mBytes, "application/json")).sha256;
  const spec = a.spec ?? (await loadSpec(t.trx, system, system.draft_revision));
  const version = await insertRevision(t, {
    system,
    kind: a.kind ?? "files",
    author: a.author,
    authorUserId: a.authorUserId ?? null,
    runId: a.runId ?? null,
    spec,
    ops: a.ops ?? [],
    manifestSha: mSha,
    idempotencyKey: a.idempotencyKey ?? null,
    summaryRu: a.summaryRu ?? `Файлы: ${written.map((w) => w.path).join(", ")}`.slice(0, 2000),
  });
  if (a.runId) {
    for (const w of written) await appendEvent(t, a.runId, "file_written", { ...w, revision: version });
  }
  return { version, written };
}

export function contentTypeOf(path: string): string {
  if (/\.(tsx?|jsx?|mjs|css|json|md|txt|html|svg)$/.test(path)) return "text/plain";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

/** Revision file paths: relative, no '..', no NUL, no backslash (api.yaml getFile x-path-wildcard). */
export function isSafePath(p: string): boolean {
  if (!p || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
