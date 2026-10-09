// Git object model in plain TypeScript (V3-30): loose objects, trees and commits in the format of git itself
// (git-scm.com/book/en/v2/Git-Internals-Git-Objects), SHA-1 from node:crypto and zlib from node:zlib — no git binary
// and no third-party package. What this writes is a regular git repository: `git fsck` accepts it (v3-git test).
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

export type GitObjectType = "blob" | "tree" | "commit" | "tag";
export const GIT_OBJECT_TYPES: readonly GitObjectType[] = ["blob", "tree", "commit", "tag"];
export const OID_RE = /^[0-9a-f]{40}$/;

/** Regular file, executable file and directory modes of tree entries. */
export const MODE_FILE = "100644";
export const MODE_EXEC = "100755";
export const MODE_DIR = "40000";

/** An object ready for the store: oid, type and its uncompressed body. */
export interface GitObject {
  oid: string;
  type: GitObjectType;
  body: Buffer;
}

const sha1 = (data: Uint8Array): string => createHash("sha1").update(data).digest("hex");

/** Loose object bytes "<type> <size>\0<body>"; the oid is their SHA-1. */
export function looseBytes(type: GitObjectType, body: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${body.byteLength}\0`, "latin1"), body]);
}

/** The object id of a body of the given type. */
export function hashObject(type: GitObjectType, body: Uint8Array): string {
  return sha1(looseBytes(type, body));
}

/** An object with its oid. */
export function makeObject(type: GitObjectType, body: Uint8Array): GitObject {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return { oid: hashObject(type, buf), type, body: buf };
}

/** Compressed loose object, as stored in .git/objects/xx/yyyy. */
export function deflateObject(o: Pick<GitObject, "type" | "body">): Buffer {
  return deflateSync(looseBytes(o.type, o.body));
}

/** Parses a compressed loose object; throws on a malformed header or a size mismatch. */
export function inflateObject(data: Uint8Array): { type: GitObjectType; body: Buffer } {
  const raw = inflateSync(data);
  const nul = raw.indexOf(0);
  const header = nul > 0 ? raw.subarray(0, nul).toString("latin1") : "";
  const m = /^(blob|tree|commit|tag) (\d+)$/.exec(header);
  if (!m) throw new Error("git object: bad header");
  const body = raw.subarray(nul + 1);
  if (body.byteLength !== Number(m[2])) throw new Error("git object: size mismatch");
  return { type: m[1] as GitObjectType, body };
}

// ---- trees ----

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git orders tree entries by name bytes, a directory compared as if its name ended with «/». */
function treeKey(e: TreeEntry): Buffer {
  return Buffer.from(e.mode === MODE_DIR ? `${e.name}/` : e.name, "utf8");
}

export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeKey(a), treeKey(b)));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    if (!e.name || e.name.includes("/") || e.name.includes("\0"))
      throw new Error(`git tree: bad name ${e.name}`);
    if (!OID_RE.test(e.oid)) throw new Error(`git tree: bad oid ${e.oid}`);
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"), Buffer.from(e.oid, "hex"));
  }
  return Buffer.concat(parts);
}

export function parseTree(body: Uint8Array): TreeEntry[] {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    const nul = buf.indexOf(0, sp);
    if (sp < 0 || nul < 0 || nul + 21 > buf.length) throw new Error("git tree: truncated entry");
    out.push({
      mode: buf.subarray(i, sp).toString("latin1"),
      name: buf.subarray(sp + 1, nul).toString("utf8"),
      oid: buf.subarray(nul + 1, nul + 21).toString("hex"),
    });
    i = nul + 21;
  }
  return out;
}

/**
 * Trees of a flat file set (path → blob oid): every directory becomes a tree object, bottom-up. Returns the root tree
 * oid and all tree objects (the root last). An empty set gives the empty tree.
 */
export function buildTrees(files: ReadonlyMap<string, { oid: string; mode?: string }>): {
  root: string;
  trees: GitObject[];
} {
  interface Dir {
    files: TreeEntry[];
    dirs: Map<string, Dir>;
  }
  const top: Dir = { files: [], dirs: new Map() };
  for (const [path, f] of files) {
    const parts = path.split("/");
    const name = parts.pop() as string;
    let dir = top;
    for (const p of parts) {
      let next = dir.dirs.get(p);
      if (!next) {
        next = { files: [], dirs: new Map() };
        dir.dirs.set(p, next);
      }
      dir = next;
    }
    dir.files.push({ mode: f.mode ?? MODE_FILE, name, oid: f.oid });
  }
  const trees: GitObject[] = [];
  const write = (d: Dir): string => {
    // A name that is both a file and a directory cannot be a tree entry twice: the directory wins.
    const entries = d.files.filter((f) => !d.dirs.has(f.name));
    for (const [name, sub] of d.dirs) entries.push({ mode: MODE_DIR, name, oid: write(sub) });
    const tree = makeObject("tree", encodeTree(entries));
    trees.push(tree);
    return tree.oid;
  };
  return { root: write(top), trees };
}

// ---- commits ----

export interface Signature {
  name: string;
  email: string;
  /** Unix time, seconds. */
  time: number;
  /** Offset as git writes it, e.g. +0300. */
  tz: string;
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: Signature;
  committer: Signature;
  message: string;
}

const signature = (s: Signature): string => {
  if (/[<>\n]/.test(s.name) || /[<>\n]/.test(s.email)) throw new Error("git commit: bad signature");
  return `${s.name} <${s.email}> ${Math.floor(s.time)} ${s.tz}`;
};

export function encodeCommit(c: CommitData): Buffer {
  const lines = [`tree ${c.tree}`, ...c.parents.map((p) => `parent ${p}`)];
  lines.push(`author ${signature(c.author)}`, `committer ${signature(c.committer)}`);
  const message = c.message.endsWith("\n") ? c.message : `${c.message}\n`;
  return Buffer.from(`${lines.join("\n")}\n\n${message}`, "utf8");
}

function parseSignature(v: string): Signature {
  const m = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(v);
  if (!m) throw new Error("git commit: bad signature");
  return { name: m[1] as string, email: m[2] as string, time: Number(m[3]), tz: m[4] as string };
}

export function parseCommit(body: Uint8Array): CommitData {
  const text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  const split = text.indexOf("\n\n");
  const head = split < 0 ? text : text.slice(0, split);
  const out: CommitData = {
    tree: "",
    parents: [],
    author: { name: "", email: "", time: 0, tz: "+0000" },
    committer: { name: "", email: "", time: 0, tz: "+0000" },
    message: split < 0 ? "" : text.slice(split + 2),
  };
  for (const line of head.split("\n")) {
    const sp = line.indexOf(" ");
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === "tree") out.tree = value;
    else if (key === "parent") out.parents.push(value);
    else if (key === "author") out.author = parseSignature(value);
    else if (key === "committer") out.committer = parseSignature(value);
  }
  if (!OID_RE.test(out.tree)) throw new Error("git commit: no tree");
  return out;
}

/** Trailers of a commit message («Key: value» lines of its last paragraph). */
export function parseTrailers(message: string): Record<string, string> {
  const paragraphs = message.trimEnd().split(/\n\n+/);
  const last = paragraphs.length > 1 ? (paragraphs.at(-1) ?? "") : "";
  const out: Record<string, string> = {};
  for (const line of last.split("\n")) {
    const m = /^([A-Za-z][A-Za-z0-9-]*): (.+)$/.exec(line);
    if (!m) return {};
    out[m[1] as string] = m[2] as string;
  }
  return out;
}
