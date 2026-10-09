// The client's repository for the agent (V3-32): the default branch head fetched shallow (the commit, its tree and blobs
// — no history) into memory as a RepoSnapshot, and the agent's change committed on top of it: new blobs and trees and a
// commit whose parent is the head, pushed to a wizard/_agent/* branch. Nothing is stored in the platform's database: a
// client repository is not a system's internal git.
import type { RepoFile, RepoFileMode, RepoSnapshot } from "@wizard/agents/repo";
import { textOf } from "@wizard/agents/repo";
import { COMMIT_AUTHOR } from "../git/commit.js";
import {
  buildTrees,
  encodeCommit,
  type GitObject,
  MODE_DIR,
  makeObject,
  parseCommit,
  parseTree,
  type Signature,
} from "../git/objects.js";
import type { GitRemote } from "../git/transport.js";

/** Pack limits of a snapshot: the compatibility check rejects bigger repositories anyway (MAX_REPO_BYTES). */
const LIMITS = { maxObjects: 50_000, maxObjectBytes: 32 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };

export interface HeadSnapshot {
  head: string;
  /** path → blob oid and mode. */
  flat: Map<string, { oid: string; mode: string }>;
  snapshot: RepoSnapshot;
  /** Every object of the head's tree (the remote has them all). */
  have: Set<string>;
}

export class SnapshotError extends Error {
  constructor(readonly code: "INCOMPLETE" | "TOO_LARGE") {
    super(code);
    this.name = "SnapshotError";
  }
}

/** Fetches the head (shallow when the server can) and reads its tree. */
export async function fetchSnapshot(remote: GitRemote, head: string): Promise<HeadSnapshot> {
  const objects = await remote.fetch([head], [], undefined, 1);
  const byOid = new Map<string, GitObject>(objects.map((o) => [o.oid, o]));
  const c = byOid.get(head);
  if (c?.type !== "commit") throw new SnapshotError("INCOMPLETE");
  const flat = new Map<string, { oid: string; mode: string }>();
  const have = new Set<string>([head]);
  const walk = (oid: string, prefix: string) => {
    const t = byOid.get(oid);
    if (t?.type !== "tree") throw new SnapshotError("INCOMPLETE");
    have.add(oid);
    for (const e of parseTree(t.body)) {
      if (e.mode === MODE_DIR) walk(e.oid, `${prefix}${e.name}/`);
      else flat.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  walk(parseCommit(c.body).tree, "");
  const snapshot = new Map<string, RepoFile>();
  let total = 0;
  for (const [path, e] of [...flat].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const mode = (
      ["100644", "100755", "120000", "160000"].includes(e.mode) ? e.mode : "100644"
    ) as RepoFileMode;
    if (mode === "160000") {
      snapshot.set(path, { path, mode, size: 0, text: null });
      continue;
    }
    const b = byOid.get(e.oid);
    if (b?.type !== "blob") throw new SnapshotError("INCOMPLETE");
    have.add(e.oid);
    total += b.body.byteLength;
    if (total > LIMITS.maxTotalBytes) throw new SnapshotError("TOO_LARGE");
    const data = new Uint8Array(b.body);
    snapshot.set(path, {
      path,
      mode,
      size: data.byteLength,
      text: mode === "120000" ? null : textOf(data),
      data,
    });
  }
  return { head, flat, snapshot, have };
}

export const remoteLimits = LIMITS;

/** The agent's change as a commit on top of the head: the objects to push and the commit oid. */
export function commitOnHead(
  base: HeadSnapshot,
  changes: ReadonlyMap<string, string | null>,
  message: string,
  now: Date,
): { commit: string; objects: GitObject[] } {
  const files = new Map(base.flat);
  const fresh: GitObject[] = [];
  for (const [path, text] of changes) {
    if (text === null) {
      files.delete(path);
      continue;
    }
    const blob = makeObject("blob", Buffer.from(text, "utf8"));
    fresh.push(blob);
    files.set(path, { oid: blob.oid, mode: base.flat.get(path)?.mode === "100755" ? "100755" : "100644" });
  }
  const { root, trees } = buildTrees(files);
  const sig: Signature = { ...COMMIT_AUTHOR, time: Math.floor(now.getTime() / 1000), tz: "+0300" };
  const commit = makeObject(
    "commit",
    encodeCommit({ tree: root, parents: [base.head], author: sig, committer: sig, message }),
  );
  const objects = [...fresh, ...trees].filter((o) => !base.have.has(o.oid));
  return { commit: commit.oid, objects: [...new Map([...objects, commit].map((o) => [o.oid, o])).values()] };
}
