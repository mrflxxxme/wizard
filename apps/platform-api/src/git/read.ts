// Reading a system repository for its owner (V3-30): commits with their messages, the diff of a commit against its
// parent and the tree of a commit as a zip archive.
import { zipSync } from "fflate";
import type { Kysely } from "kysely";
import type { DB } from "../db/index.js";
import { diffTrees, type FileStatus, filePatch, isBinary, unifiedHunks } from "./diff.js";
import { type CommitData, parseCommit, parseTrailers } from "./objects.js";
import { type CommitRow, readObject, readObjects, readTreeFlat } from "./store.js";

type Q = Kysely<DB>;

/** Text files larger than this get no patch in the diff (only the counts of the change). */
export const PATCH_MAX_BYTES = 1_048_576;

export interface CommitInfo {
  oid: string;
  seq: number;
  revision: number | null;
  briefVersion: number | null;
  subject: string;
  message: string;
  author: { name: string; email: string };
  /** The acting user (trailer Wizard-User), null for the platform's own commits. */
  userId: string | null;
  committedAt: string;
  parents: string[];
  tree: string;
}

async function commitData(q: Q, systemId: string, oid: string): Promise<CommitData> {
  const o = await readObject(q, systemId, oid);
  if (o?.type !== "commit") throw new Error(`git: commit ${oid} missing`);
  return parseCommit(o.body);
}

function info(row: CommitRow, c: CommitData): CommitInfo {
  return {
    oid: row.oid,
    seq: row.seq,
    revision: row.revision,
    briefVersion: row.briefVersion,
    subject: row.subject,
    message: c.message,
    author: { name: c.author.name, email: c.author.email },
    userId: parseTrailers(c.message)["Wizard-User"] ?? null,
    committedAt: row.committedAt.toISOString(),
    parents: c.parents,
    tree: c.tree,
  };
}

/** Rows with what their commit objects say (one query for the page). */
export async function commitInfos(q: Q, systemId: string, rows: readonly CommitRow[]): Promise<CommitInfo[]> {
  const objs = await readObjects(
    q,
    systemId,
    rows.map((r) => r.oid),
  );
  return rows.map((r) => {
    const o = objs.get(r.oid);
    if (o?.type !== "commit") throw new Error(`git: commit ${r.oid} missing`);
    return info(r, parseCommit(o.body));
  });
}

export interface FileDiff {
  path: string;
  status: FileStatus;
  binary: boolean;
  additions: number;
  deletions: number;
  /** `git diff` text of the file; null for a binary or too large file. */
  patch: string | null;
}

/** Diff of a commit against its first parent (the first commit — against the empty tree). */
export async function commitDiff(
  q: Q,
  systemId: string,
  row: CommitRow,
): Promise<{ commit: CommitInfo; parent: string | null; files: FileDiff[] }> {
  const c = await commitData(q, systemId, row.oid);
  const parent = c.parents[0] ?? null;
  const after = await readTreeFlat(q, systemId, c.tree);
  const before = parent
    ? await readTreeFlat(q, systemId, (await commitData(q, systemId, parent)).tree)
    : new Map<string, { oid: string }>();
  const changes = diffTrees(before, after);
  const blobs = await readObjects(
    q,
    systemId,
    changes.flatMap((ch) => [ch.oldOid, ch.newOid].filter((x): x is string => x !== null)),
  );
  const files: FileDiff[] = changes.map((ch) => {
    const a = ch.oldOid ? (blobs.get(ch.oldOid)?.body ?? Buffer.alloc(0)) : null;
    const b = ch.newOid ? (blobs.get(ch.newOid)?.body ?? Buffer.alloc(0)) : null;
    const binary = (a !== null && isBinary(a)) || (b !== null && isBinary(b));
    if (binary || (a?.byteLength ?? 0) > PATCH_MAX_BYTES || (b?.byteLength ?? 0) > PATCH_MAX_BYTES)
      return { path: ch.path, status: ch.status, binary, additions: 0, deletions: 0, patch: null };
    const at = a?.toString("utf8") ?? null;
    const bt = b?.toString("utf8") ?? null;
    const p = unifiedHunks(at ?? "", bt ?? "");
    return {
      path: ch.path,
      status: ch.status,
      binary: false,
      additions: p.additions,
      deletions: p.deletions,
      patch: filePatch(ch.path, ch.status, at, bt, p.hunks),
    };
  });
  return { commit: info(row, c), parent, files };
}

/** The tree of a commit as a zip: every file under `<folder>/`, dated with the commit time. */
export async function commitArchive(
  q: Q,
  systemId: string,
  row: CommitRow,
  folder: string,
): Promise<Uint8Array> {
  const c = await commitData(q, systemId, row.oid);
  const flat = await readTreeFlat(q, systemId, c.tree);
  const objs = await readObjects(
    q,
    systemId,
    [...flat.values()].map((f) => f.oid),
  );
  const mtime = new Date(c.committer.time * 1000);
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const [path, f] of [...flat].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const o = objs.get(f.oid);
    if (!o) throw new Error(`git: blob ${f.oid} missing`);
    files[`${folder}/${path}`] = [new Uint8Array(o.body), { mtime }];
  }
  return zipSync(files, { level: 6, mtime });
}
