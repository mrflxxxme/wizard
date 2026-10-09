// Object graph of a system repository (V3-31): what a push must send (objects of new commits the remote lacks), is one
// commit an ancestor of another, and the commit and tree of an oid. Level-by-level reads (one query per level).
import type { Kysely } from "kysely";
import type { DB } from "../db/index.js";
import { type GitObject, parseCommit, parseTree } from "./objects.js";
import { readObjects } from "./store.js";

type Q = Kysely<DB>;

/** Commits reachable from `tips` (inclusive), parents first-seen order; stops at `stop` and after `limit` commits. */
export async function commitClosure(
  q: Q,
  systemId: string,
  tips: readonly string[],
  o: { stop?: ReadonlySet<string>; limit?: number } = {},
): Promise<Map<string, GitObject>> {
  const out = new Map<string, GitObject>();
  const limit = o.limit ?? 100_000;
  let level = [...new Set(tips)].filter((t) => !o.stop?.has(t));
  while (level.length && out.size < limit) {
    const objs = await readObjects(q, systemId, level);
    const next: string[] = [];
    for (const oid of level) {
      if (out.has(oid)) continue;
      const obj = objs.get(oid);
      if (obj?.type !== "commit") continue;
      out.set(oid, { oid, type: "commit", body: obj.body });
      for (const p of parseCommit(obj.body).parents) if (!out.has(p) && !o.stop?.has(p)) next.push(p);
    }
    level = [...new Set(next)];
  }
  return out;
}

/** Trees and blobs under `roots`, skipping anything in `exclude` (and what is under an excluded tree). */
export async function treeClosure(
  q: Q,
  systemId: string,
  roots: readonly string[],
  exclude: ReadonlySet<string> = new Set(),
): Promise<Map<string, GitObject>> {
  const out = new Map<string, GitObject>();
  let level = [...new Set(roots)].filter((r) => !exclude.has(r));
  while (level.length) {
    const objs = await readObjects(q, systemId, level);
    const next: string[] = [];
    for (const oid of level) {
      if (out.has(oid)) continue;
      const obj = objs.get(oid);
      if (!obj) throw new Error(`git: object ${oid} missing`);
      out.set(oid, { oid, type: obj.type, body: obj.body });
      if (obj.type !== "tree") continue;
      for (const e of parseTree(obj.body)) {
        // Submodule entries (160000) name commits of another repository: nothing to send.
        if (e.mode === "160000" || exclude.has(e.oid) || out.has(e.oid)) continue;
        next.push(e.oid);
      }
    }
    level = [...new Set(next)];
  }
  return out;
}

/**
 * Objects a push of `tip` sends to a remote that has `remoteTips` (oids it advertised; the ones we do not have are
 * ignored): the new commits and the trees and blobs of their trees the remote's commits do not already hold.
 */
export async function objectsToPush(
  q: Q,
  systemId: string,
  tip: string,
  remoteTips: readonly string[],
): Promise<GitObject[]> {
  const have = await commitClosure(q, systemId, remoteTips);
  const fresh = await commitClosure(q, systemId, [tip], { stop: new Set(have.keys()) });
  if (fresh.size === 0) return [];
  // Trees of the remote's tips (their latest content) cover nearly every object a new commit shares with them.
  const haveTips = remoteTips.filter((t) => have.has(t));
  const known = await treeClosure(
    q,
    systemId,
    haveTips.map((t) => parseCommit((have.get(t) as GitObject).body).tree),
  );
  const exclude = new Set(known.keys());
  const trees = await treeClosure(
    q,
    systemId,
    [...fresh.values()].map((c) => parseCommit(c.body).tree),
    exclude,
  );
  return [...fresh.values(), ...trees.values()];
}

/** Is `ancestor` reachable from `descendant` (itself included)? Walks at most `limit` commits. */
export async function isAncestor(
  q: Q,
  systemId: string,
  ancestor: string,
  descendant: string,
  limit = 5000,
): Promise<boolean> {
  if (ancestor === descendant) return true;
  const seen = await commitClosure(q, systemId, [descendant], { limit });
  return seen.has(ancestor);
}

/** True when every object reachable from `tip` is in the store (a fetch left nothing out). */
export async function closureComplete(q: Q, systemId: string, tip: string): Promise<boolean> {
  try {
    const commits = await commitClosure(q, systemId, [tip]);
    if (!commits.has(tip)) return false;
    for (const c of commits.values()) {
      for (const p of parseCommit(c.body).parents) if (!commits.has(p)) return false;
    }
    await treeClosure(
      q,
      systemId,
      [...commits.values()].map((c) => parseCommit(c.body).tree),
    );
    return true;
  } catch {
    return false;
  }
}
