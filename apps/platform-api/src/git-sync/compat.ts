// What an import may take over (V3-31): changes of ui/**, functions/** and assets/** and of spec/appspec.json between
// the synced base and the default branch head; Wizard's generated files (brief, tests, AGENTS.md) are left out with a
// warning and the client's own files (README, CI, …) stay theirs. A change is refused with a Russian reason when it is
// a symlink or a submodule, an unsafe path, too large, not UTF-8 in the sources, or the spec is deleted or invalid.
import { type AppSpec, validateSpec } from "@wizard/appspec";
import { diffTrees, isBinary, type TreeChange } from "../git/diff.js";
import { isRepoPath } from "../git/layout.js";
import { merge3 } from "../git/merge3.js";
import { isSafePath } from "../services/revisions.js";
import { isGeneratedRepoPath, isImportablePath } from "./context.js";
import { syncRu } from "./texts.js";

export type Flat = ReadonlyMap<string, { oid: string; mode: string }>;

export const MAX_TEXT_BYTES = 1_048_576;
export const MAX_ASSET_BYTES = 5 * 1_048_576;
export const MAX_FILES = 2000;
const SPEC_PATH = "spec/appspec.json";

const pick = (flat: Flat, keep: (p: string) => boolean) => new Map([...flat].filter(([p]) => keep(p)));

/** Changes of importable paths base → head. */
export function importableChanges(base: Flat, head: Flat): TreeChange[] {
  return diffTrees(pick(base, isImportablePath), pick(head, isImportablePath));
}

/** Generated files the head changed compared with the previous head of the remote (only a warning). */
export function generatedEdits(prevHead: Flat | null, head: Flat): string[] {
  if (!prevHead) return [];
  return diffTrees(pick(prevHead, isGeneratedRepoPath), pick(head, isGeneratedRepoPath)).map((c) => c.path);
}

/** Paths changed on both sides with different results (a file-level three-way check against the base). */
export function conflicts(
  theirs: readonly TreeChange[],
  ours: readonly TreeChange[],
  draft: Flat,
  head: Flat,
): string[] {
  const mine = new Map(ours.map((c) => [c.path, c]));
  const out: string[] = [];
  for (const c of theirs) {
    if (!mine.has(c.path)) continue;
    if ((draft.get(c.path)?.oid ?? null) !== (head.get(c.path)?.oid ?? null)) out.push(c.path);
  }
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

const textOf = (b: Buffer | undefined): string | null => {
  if (!b || isBinary(b)) return null;
  try {
    return utf8.decode(b);
  } catch {
    return null;
  }
};

export interface ClashMerge {
  /** Paths both sides changed whose line hunks are apart: path → the merged content. */
  merged: Map<string, Buffer>;
  /** Paths left in conflict, with the base line ranges both sides changed (empty — a whole-file conflict). */
  conflicts: { path: string; lines: { from: number; to: number }[] }[];
}

/**
 * V3-32 line-level merge of the paths both sides changed (`clash`, from conflicts()): a text file both changed is
 * merged line by line against the synced base when the hunks are apart (merge3); a deletion on either side, an asset,
 * a binary or non-UTF-8 file, a merged result over the size limit — and of course overlapping hunks — stay conflicts.
 */
export function mergeClashes(
  clash: readonly string[],
  base: Flat,
  ours: Flat,
  theirs: Flat,
  blob: (oid: string) => Buffer | undefined,
): ClashMerge {
  const out: ClashMerge = { merged: new Map(), conflicts: [] };
  for (const path of clash) {
    const o = ours.get(path);
    const t = theirs.get(path);
    const b = base.get(path);
    if (!o || !t || path.startsWith("assets/")) {
      out.conflicts.push({ path, lines: [] });
      continue;
    }
    const bt = b ? textOf(blob(b.oid)) : "";
    const ot = textOf(blob(o.oid));
    const tt = textOf(blob(t.oid));
    if (bt === null || ot === null || tt === null) {
      out.conflicts.push({ path, lines: [] });
      continue;
    }
    const r = merge3(bt, ot, tt);
    const body = r.ok ? Buffer.from(r.text, "utf8") : null;
    if (!r.ok) out.conflicts.push({ path, lines: r.conflicts });
    else if ((body as Buffer).byteLength > MAX_TEXT_BYTES) out.conflicts.push({ path, lines: [] });
    else out.merged.set(path, body as Buffer);
  }
  return out;
}

/** Reasons the changes cannot be taken (empty — they can); `blob(oid)` gives the content of a new file. */
export function incompatibilities(
  changes: readonly TreeChange[],
  head: Flat,
  blob: (oid: string) => Buffer | undefined,
  filesAfter: number,
): string[] {
  const out: string[] = [];
  if (filesAfter > MAX_FILES) out.push(syncRu.import.tooMany(filesAfter));
  for (const c of changes) {
    if (!isRepoPath(c.path) || !isSafePath(c.path)) {
      out.push(syncRu.import.path(c.path));
      continue;
    }
    if (c.status === "deleted") {
      if (c.path === SPEC_PATH) out.push("spec/appspec.json нельзя удалить");
      continue;
    }
    const mode = head.get(c.path)?.mode;
    if (mode === "120000" || mode === "160000") {
      out.push(syncRu.import.symlink(c.path));
      continue;
    }
    const body = blob(c.newOid as string);
    if (!body) continue;
    const asset = c.path.startsWith("assets/");
    const max = asset ? MAX_ASSET_BYTES : MAX_TEXT_BYTES;
    if (body.byteLength > max) {
      out.push(syncRu.import.tooLarge(c.path, max / 1_048_576));
      continue;
    }
    if (!asset) {
      try {
        utf8.decode(body);
      } catch {
        out.push(syncRu.import.notText(c.path));
      }
    }
  }
  return out;
}

/** The new spec when the import changes spec/appspec.json: parsed and validated, or the reasons it is refused. */
export function importedSpec(raw: Buffer): { ok: true; spec: AppSpec } | { ok: false; reasons: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return { ok: false, reasons: [syncRu.import.badSpecJson] };
  }
  const r = validateSpec(value);
  if (!r.ok) return { ok: false, reasons: r.errors.map((e) => `${e.path || "/"}: ${e.message_ru}`) };
  return { ok: true, spec: r.spec };
}
