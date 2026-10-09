// Object store and refs of a system repository in Postgres (V3-30, db.yaml#system_git_objects, #system_git_refs,
// #system_git_commits). Rows hold compressed loose objects, so a bare repository is the rows written out as files.
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/index.js";
import {
  deflateObject,
  type GitObject,
  type GitObjectType,
  inflateObject,
  MODE_DIR,
  parseTree,
} from "./objects.js";

type Q = Kysely<DB>;

export const MAIN_REF = "refs/heads/main";
const CHUNK = 500;

function chunks<T>(xs: readonly T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Which of these oids the repository already has. */
export async function existingOids(q: Q, systemId: string, oids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks([...new Set(oids)])) {
    const { rows } = await sql<{ oid: string }>`
      select o.oid from platform.system_git_objects as o
       where o.system_id = ${systemId} and o.oid in (${sql.join(part)})`.execute(q);
    for (const r of rows) out.add(r.oid);
  }
  return out;
}

export interface StoredObject extends GitObject {
  /** sha256 of a blob's content in platform.files: the next commit finds the blob without reading the file. */
  contentSha256?: string;
}

/** Inserts objects the repository lacks (an existing oid is the same object by definition). */
export async function putObjects(q: Q, systemId: string, objects: readonly StoredObject[]): Promise<number> {
  const unique = new Map(objects.map((o) => [o.oid, o]));
  if (unique.size === 0) return 0;
  const have = await existingOids(q, systemId, [...unique.keys()]);
  const fresh = [...unique.values()].filter((o) => !have.has(o.oid));
  // Rows go in batches of ≤ 50 rows and ≈ 8 MB: a blob may be up to 5 MB (MAX_BLOB).
  const batches: StoredObject[][] = [];
  let bytes = Number.POSITIVE_INFINITY;
  for (const o of fresh) {
    const last = batches.at(-1);
    if (!last || last.length >= 50 || bytes + o.body.byteLength > 8_388_608) {
      batches.push([o]);
      bytes = o.body.byteLength;
    } else {
      last.push(o);
      bytes += o.body.byteLength;
    }
  }
  for (const part of batches) {
    const values = part.map(
      (o) =>
        sql`(${systemId}, ${o.oid}, ${o.type}, ${o.body.byteLength}, ${deflateObject(o)}, ${o.contentSha256 ?? null})`,
    );
    await sql`
      insert into platform.system_git_objects (system_id, oid, type, size, data, content_sha256)
      values ${sql.join(values)}
      on conflict (system_id, oid) do nothing`.execute(q);
  }
  return fresh.length;
}

/** Objects by oid (uncompressed); absent ones are not in the map. */
export async function readObjects(
  q: Q,
  systemId: string,
  oids: readonly string[],
): Promise<Map<string, { type: GitObjectType; body: Buffer }>> {
  const out = new Map<string, { type: GitObjectType; body: Buffer }>();
  for (const part of chunks([...new Set(oids)])) {
    const { rows } = await sql<{ oid: string; data: Buffer }>`
      select o.oid, o.data from platform.system_git_objects as o
       where o.system_id = ${systemId} and o.oid in (${sql.join(part)})`.execute(q);
    for (const r of rows) out.set(r.oid, inflateObject(r.data));
  }
  return out;
}

export async function readObject(
  q: Q,
  systemId: string,
  oid: string,
): Promise<{ type: GitObjectType; body: Buffer } | null> {
  return (await readObjects(q, systemId, [oid])).get(oid) ?? null;
}

/** Git blob oids of contents already in the repository, by the content's sha256 (platform.files). */
export async function blobOidsByContent(
  q: Q,
  systemId: string,
  sha256s: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunks([...new Set(sha256s)])) {
    const { rows } = await sql<{ oid: string; content_sha256: string }>`
      select o.oid, o.content_sha256 from platform.system_git_objects as o
       where o.system_id = ${systemId} and o.content_sha256 in (${sql.join(part)})`.execute(q);
    for (const r of rows) out.set(r.content_sha256, r.oid);
  }
  return out;
}

/**
 * Flat file list of a tree: path → {oid, mode}. Subtrees are fetched level by level (one query per depth), so a
 * tree costs as many queries as it is deep.
 */
export async function readTreeFlat(
  q: Q,
  systemId: string,
  treeOid: string,
): Promise<Map<string, { oid: string; mode: string }>> {
  const out = new Map<string, { oid: string; mode: string }>();
  let level: { prefix: string; oid: string }[] = [{ prefix: "", oid: treeOid }];
  while (level.length) {
    const objs = await readObjects(
      q,
      systemId,
      level.map((l) => l.oid),
    );
    const next: { prefix: string; oid: string }[] = [];
    for (const l of level) {
      const o = objs.get(l.oid);
      if (o?.type !== "tree") throw new Error(`git: tree ${l.oid} missing`);
      for (const e of parseTree(o.body)) {
        const path = `${l.prefix}${e.name}`;
        if (e.mode === MODE_DIR) next.push({ prefix: `${path}/`, oid: e.oid });
        else out.set(path, { oid: e.oid, mode: e.mode });
      }
    }
    level = next;
  }
  return out;
}

export async function getRef(q: Q, systemId: string, name: string): Promise<string | null> {
  const { rows } = await sql<{ oid: string }>`
    select r.oid from platform.system_git_refs as r where r.system_id = ${systemId} and r.name = ${name}`.execute(
    q,
  );
  return rows[0]?.oid ?? null;
}

export async function setRef(q: Q, systemId: string, name: string, oid: string): Promise<void> {
  await sql`
    insert into platform.system_git_refs (system_id, name, oid) values (${systemId}, ${name}, ${oid})
    on conflict (system_id, name) do update set oid = excluded.oid, updated_at = now()`.execute(q);
}

/** A commit of the system's main line with what it records. */
export interface CommitRow {
  seq: number;
  oid: string;
  revision: number | null;
  briefVersion: number | null;
  subject: string;
  authorUserId: string | null;
  committedAt: Date;
}

interface RawCommitRow {
  seq: number;
  oid: string;
  revision: number | null;
  brief_version: number | null;
  subject: string;
  author_user_id: string | null;
  committed_at: Date | string;
}

const toCommitRow = (r: RawCommitRow): CommitRow => ({
  seq: r.seq,
  oid: r.oid,
  revision: r.revision,
  briefVersion: r.brief_version,
  subject: r.subject,
  authorUserId: r.author_user_id,
  committedAt: new Date(r.committed_at),
});

export async function insertCommitRow(q: Q, systemId: string, c: CommitRow): Promise<void> {
  await sql`
    insert into platform.system_git_commits
      (system_id, seq, oid, revision, brief_version, subject, author_user_id, committed_at)
    values (${systemId}, ${c.seq}, ${c.oid}, ${c.revision}, ${c.briefVersion}, ${c.subject}, ${c.authorUserId},
            ${c.committedAt})`.execute(q);
}

/** Commits newest first; `before` — seq of the last one of the previous page. */
export async function listCommitRows(
  q: Q,
  systemId: string,
  o: { limit: number; before?: number },
): Promise<CommitRow[]> {
  const { rows } = await sql<RawCommitRow>`
    select c.seq, c.oid, c.revision, c.brief_version, c.subject, c.author_user_id, c.committed_at
      from platform.system_git_commits as c
     where c.system_id = ${systemId} ${o.before !== undefined ? sql`and c.seq < ${o.before}` : sql``}
     order by c.seq desc
     limit ${o.limit}`.execute(q);
  return rows.map(toCommitRow);
}

/** The commit of a revision, of an oid, or the newest one (neither given). */
export async function findCommitRow(
  q: Q,
  systemId: string,
  by: { revision?: number; oid?: string },
): Promise<CommitRow | null> {
  const where =
    by.revision !== undefined
      ? sql`and c.revision = ${by.revision}`
      : by.oid !== undefined
        ? sql`and c.oid = ${by.oid}`
        : sql``;
  const { rows } = await sql<RawCommitRow>`
    select c.seq, c.oid, c.revision, c.brief_version, c.subject, c.author_user_id, c.committed_at
      from platform.system_git_commits as c
     where c.system_id = ${systemId} ${where}
     order by c.seq desc
     limit 1`.execute(q);
  return rows[0] ? toCommitRow(rows[0]) : null;
}

/** Where the main line stands: last seq and head, the last revision and brief version it has. */
export async function repoCursor(
  q: Q,
  systemId: string,
): Promise<{ seq: number; head: string | null; revision: number; briefVersion: number }> {
  const { rows } = await sql<{ seq: number | null; revision: number | null; brief_version: number | null }>`
    select max(c.seq) as seq, max(c.revision) as revision, max(c.brief_version) as brief_version
      from platform.system_git_commits as c where c.system_id = ${systemId}`.execute(q);
  const r = rows[0];
  return {
    seq: Number(r?.seq ?? 0),
    head: await getRef(q, systemId, MAIN_REF),
    revision: Number(r?.revision ?? 0),
    briefVersion: Number(r?.brief_version ?? 0),
  };
}
