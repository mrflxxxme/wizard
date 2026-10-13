// V4-15 instant edits (D79 (9), the first layer): a text or a photo of a page replaced by its source literal (packages/
// build source-map) — no model: a new draft revision with the changed file, the draft bundle built at once (the run
// engine's post-G0 step) and the preview moved to it. A literal replaced by a literal keeps the file valid TSX and its
// types, so the revision inherits G0 of the one it edits.
import type { AppSpec } from "@wizard/appspec";
import {
  applyLiteralEdits,
  buildSourceMap,
  isMappedFile,
  type LiteralEdit,
  type LiteralKind,
} from "@wizard/build";
import type { Db } from "../../db/index.js";
import { ApiError, invalid } from "../../errors.js";
import { TERMINAL_STATUSES } from "../../runs/queue.js";
import type { OnG0Passed } from "../../runs/types.js";
import {
  commitFilesRevision,
  loadManifest,
  loadRevision,
  loadSpec,
  lockSystem,
} from "../../services/revisions.js";
import type { BlobStore } from "../../storage/blobs.js";

export interface EditDeps {
  db: Db;
  blobs: BlobStore;
  /** The run engine's post-G0 step (draft schema and bundle); absent — the preview waits for the next build. */
  onG0Passed?: OnG0Passed;
  now?: () => number;
}

export interface LiteralView {
  ref: string;
  kind: LiteralKind;
  value: string;
  file: string;
  /** Route of the page the file is, when it is a page. */
  route?: string;
}

const LOCKED = () => new ApiError("SYSTEM_LOCKED", "Идёт сборка — дождитесь её окончания");

/** Files of revision `version` (all of them, or only those `pick` keeps). */
export async function revisionFiles(
  d: Pick<EditDeps, "db" | "blobs">,
  systemId: string,
  version: number,
  pick: (path: string) => boolean = () => true,
): Promise<Map<string, string>> {
  const manifest = await loadManifest(d.db, d.blobs, systemId, version);
  const out = new Map<string, string>();
  for (const [path, sha] of Object.entries(manifest).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (pick(path)) out.set(path, (await d.blobs.get(sha)).toString("utf8"));
  }
  return out;
}

/** The mapped literals of the draft revision `version`. */
export async function draftLiterals(
  d: Pick<EditDeps, "db" | "blobs">,
  system: { id: string; name: string },
  version: number,
): Promise<LiteralView[]> {
  const files = await revisionFiles(d, system.id, version, isMappedFile);
  const spec = await loadSpec(d.db, system, version);
  const routes = new Map((spec.pages ?? []).map((p) => [p.file, p.route]));
  return Object.values(buildSourceMap(files)).map((l) => ({
    ref: l.ref,
    kind: l.kind,
    value: l.value,
    file: l.file,
    ...(routes.has(l.file) ? { route: routes.get(l.file) as string } : {}),
  }));
}

async function busy(db: Db, systemId: string): Promise<boolean> {
  const lock = await db
    .selectFrom("platform.locks")
    .select("run_id")
    .where("system_id", "=", systemId)
    .where("lease_until", ">", new Date())
    .executeTakeFirst();
  const active = await db
    .selectFrom("platform.runs")
    .select("id")
    .where("system_id", "=", systemId)
    .where("kind", "=", "build")
    .where("status", "not in", [...TERMINAL_STATUSES])
    .executeTakeFirst();
  return lock !== undefined || active !== undefined;
}

export interface CommitPreview {
  revision: number;
  previewRevision: number | null;
  ms: number;
}

/**
 * Commits `changes` over draft revision `revision` as a new revision (G0 inherited when `inheritG0`) and builds its
 * preview. 412 VERSION_CONFLICT — the draft moved on; 409 SYSTEM_LOCKED — a build runs; 409 PREVIEW_NOT_READY — no
 * built preview yet.
 */
export async function commitAndPreview(
  d: EditDeps,
  o: {
    systemId: string;
    userId: string;
    revision: number;
    changes: Map<string, string>;
    summaryRu: string;
    inheritG0: boolean;
    kind?: "files" | "style";
    started: number;
  },
): Promise<CommitPreview> {
  const now = d.now ?? Date.now;
  if (await busy(d.db, o.systemId)) throw LOCKED();
  const committed = await d.db.transaction().execute(async (trx) => {
    const s = await lockSystem({ trx, events: [] }, o.systemId);
    if (s.stage === "building") throw LOCKED();
    if (s.preview_revision === null)
      throw new ApiError("PREVIEW_NOT_READY", "Правки доступны, когда система собрана");
    if (s.draft_revision !== o.revision)
      throw new ApiError("VERSION_CONFLICT", "Система изменилась — обновите превью и повторите правку");
    const base = await loadRevision(trx, s.id, s.draft_revision);
    const r = await commitFilesRevision({ trx, events: [] }, d.blobs, {
      systemId: s.id,
      changes: [...o.changes].map(([path, text]) => ({
        path,
        content: new Uint8Array(Buffer.from(text, "utf8")),
      })),
      author: "user",
      authorUserId: o.userId,
      kind: o.kind ?? "files",
      summaryRu: o.summaryRu,
    });
    if (o.inheritG0 && base?.g0_passed)
      await trx
        .updateTable("platform.revisions")
        .set({ g0_passed: true })
        .where("system_id", "=", s.id)
        .where("version", "=", r.version)
        .execute();
    return { version: r.version, system: s };
  });
  const s = committed.system;
  let previewRevision: number | null = s.preview_revision;
  if (d.onG0Passed) {
    const spec: AppSpec = await loadSpec(d.db, s, committed.version);
    const prevSpec = s.preview_revision !== null ? await loadSpec(d.db, s, s.preview_revision) : null;
    const out = await d.onG0Passed({
      systemId: s.id,
      systemKey: s.schema_key,
      revision: committed.version,
      spec,
      files: await revisionFiles(d, s.id, committed.version),
      runId: `edit:${s.id}:${committed.version}`,
      prevSpec,
    });
    if (out?.bundleKey) {
      const bundleKey = out.bundleKey;
      await d.db.transaction().execute(async (trx) => {
        await trx
          .updateTable("platform.revisions")
          .set({ bundle_key: bundleKey })
          .where("system_id", "=", s.id)
          .where("version", "=", committed.version)
          .execute();
        await trx
          .updateTable("platform.systems")
          .set({ preview_revision: committed.version, updated_at: new Date(), last_activity_at: new Date() })
          .where("id", "=", s.id)
          .where((eb) =>
            eb.or([eb("preview_revision", "is", null), eb("preview_revision", "<", committed.version)]),
          )
          .execute();
      });
      previewRevision = committed.version;
    }
  }
  return { revision: committed.version, previewRevision, ms: now() - o.started };
}

/** Instant literal edits of the draft: texts and photos by ref, no model. */
export async function editLiterals(
  d: EditDeps,
  o: { systemId: string; userId: string; revision: number; edits: readonly LiteralEdit[] },
): Promise<CommitPreview> {
  const started = (d.now ?? Date.now)();
  const files = await revisionFiles(d, o.systemId, o.revision, isMappedFile);
  const r = applyLiteralEdits(files, o.edits);
  if (!r.ok) throw invalid(r.message, { ref: r.ref, code: r.code });
  return commitAndPreview(d, {
    systemId: o.systemId,
    userId: o.userId,
    revision: o.revision,
    changes: r.files,
    summaryRu: `Правка ${o.edits.length === 1 ? "текста или фото" : `${o.edits.length} текстов и фото`} на странице`,
    inheritG0: true,
    started,
  });
}
