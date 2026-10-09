// Packfiles (V3-31; git-scm.com/docs/gitformat-pack): what git sends over the wire. writePack writes version 2 with
// whole objects (every git server accepts it); readPack reads what servers send — whole objects, OFS_DELTA and
// REF_DELTA (the base in the pack or, for a thin pack, among the objects we already have) — verifies the trailing
// SHA-1, the declared sizes and the limits, and hashes every object. node:zlib and node:crypto only.
import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";
import { type GitObject, type GitObjectType, hashObject } from "./objects.js";

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
const OFS_DELTA = 6;
const REF_DELTA = 7;

export interface PackLimits {
  /** Objects in one pack (default 200 000). */
  maxObjects?: number;
  /** Size of one inflated object or delta (default 64 MB). */
  maxObjectBytes?: number;
  /** Sum of all inflated objects (default 1 GB). */
  maxTotalBytes?: number;
  /** Length of a delta chain (git's own default is 50; default here 4095, git's hard limit). */
  maxDeltaDepth?: number;
}

export class PackError extends Error {
  constructor(message: string) {
    super(`pack: ${message}`);
    this.name = "PackError";
  }
}

function entryHeader(type: number, size: number): Buffer {
  const out: number[] = [];
  let byte = (type << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    out.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  out.push(byte);
  return Buffer.from(out);
}

/** A version 2 pack of whole objects (no deltas); an empty list gives the valid empty pack. */
export function writePack(objects: readonly Pick<GitObject, "type" | "body">[]): Buffer {
  const head = Buffer.alloc(12);
  head.write("PACK", 0, "latin1");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const o of objects)
    parts.push(entryHeader(TYPE_CODE[o.type], o.body.byteLength), deflateSync(o.body, { level: 6 }));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

// ---- deltas ----

function readVarint(d: Buffer, pos: number): [number, number] {
  let value = 0;
  let shift = 1;
  let p = pos;
  for (;;) {
    if (p >= d.byteLength) throw new PackError("truncated delta header");
    const b = d[p++] as number;
    value += (b & 0x7f) * shift;
    shift *= 128;
    if (!(b & 0x80)) return [value, p];
  }
}

/** Applies a git delta (copy/insert instructions) to its base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let [srcSize, p] = readVarint(delta, 0);
  let targetSize: number;
  [targetSize, p] = readVarint(delta, p);
  if (srcSize !== base.byteLength) throw new PackError("delta base size mismatch");
  const out = Buffer.allocUnsafe(targetSize);
  let o = 0;
  while (p < delta.byteLength) {
    const op = delta[p++] as number;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) off += (delta[p++] as number) * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (1 << (4 + i))) size += (delta[p++] as number) * 2 ** (8 * i);
      if (size === 0) size = 0x10000;
      if (p > delta.byteLength || off + size > base.byteLength || o + size > targetSize)
        throw new PackError("delta copy out of range");
      base.copy(out, o, off, off + size);
      o += size;
    } else if (op > 0) {
      if (p + op > delta.byteLength || o + op > targetSize) throw new PackError("delta insert out of range");
      delta.copy(out, o, p, p + op);
      o += op;
      p += op;
    } else throw new PackError("delta opcode 0");
  }
  if (o !== targetSize) throw new PackError("delta result size mismatch");
  return out;
}

function writeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

/**
 * A simple delta of `target` against `base`: a copy of the common prefix and suffix, the middle inserted. Enough for
 * tests and the mock git server; real servers send better deltas, which applyDelta reads all the same.
 */
export function encodeDelta(base: Buffer, target: Buffer): Buffer {
  let pre = 0;
  const max = Math.min(base.byteLength, target.byteLength);
  while (pre < max && base[pre] === target[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && base[base.byteLength - 1 - suf] === target[target.byteLength - 1 - suf]) suf++;
  const out: number[] = [...writeVarint(base.byteLength), ...writeVarint(target.byteLength)];
  const copy = (off: number, size: number) => {
    let left = size;
    let at = off;
    while (left > 0) {
      const n = Math.min(left, 0xffff);
      let op = 0x80;
      const bytes: number[] = [];
      for (let i = 0; i < 4; i++) {
        const b = Math.floor(at / 2 ** (8 * i)) & 0xff;
        if (b) {
          op |= 1 << i;
          bytes.push(b);
        }
      }
      for (let i = 0; i < 2; i++) {
        const b = (n >> (8 * i)) & 0xff;
        if (b) {
          op |= 1 << (4 + i);
          bytes.push(b);
        }
      }
      out.push(op, ...bytes);
      at += n;
      left -= n;
    }
  };
  if (pre) copy(0, pre);
  for (let i = pre; i < target.byteLength - suf; i += 127) {
    const chunk = target.subarray(i, Math.min(i + 127, target.byteLength - suf));
    out.push(chunk.byteLength, ...chunk);
  }
  if (suf) copy(base.byteLength - suf, suf);
  return Buffer.from(out);
}

// ---- reading ----

/** What a read pack was made of (tests check that deltas of both kinds were really read). */
export interface PackStats {
  objects: number;
  ofsDeltas: number;
  refDeltas: number;
  external: number;
}

interface RawEntry {
  offset: number;
  type: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/** Objects outside the pack that a thin pack's REF_DELTA may use as its base (objects we already have). */
export type ExternalBase = (
  oids: readonly string[],
) => Promise<Map<string, { type: GitObjectType; body: Buffer }>>;

/** Every object of a pack, hashed, deltas resolved. Throws PackError on anything malformed or over the limits. */
export async function readPack(
  pack: Uint8Array,
  o: PackLimits & { external?: ExternalBase; onStats?: (s: PackStats) => void } = {},
): Promise<GitObject[]> {
  const buf = Buffer.from(pack.buffer, pack.byteOffset, pack.byteLength);
  const maxObjects = o.maxObjects ?? 200_000;
  const maxObjectBytes = o.maxObjectBytes ?? 64 * 1024 * 1024;
  const maxTotal = o.maxTotalBytes ?? 1024 * 1024 * 1024;
  const maxDepth = o.maxDeltaDepth ?? 4095;
  if (buf.byteLength < 32 || buf.subarray(0, 4).toString("latin1") !== "PACK")
    throw new PackError("no PACK header");
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`version ${version}`);
  const count = buf.readUInt32BE(8);
  if (count > maxObjects) throw new PackError("too many objects");
  const end = buf.byteLength - 20;
  const sum = createHash("sha1").update(buf.subarray(0, end)).digest();
  if (!sum.equals(buf.subarray(end))) throw new PackError("checksum mismatch");

  const entries: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let pos = 12;
  let total = 0;
  for (let i = 0; i < count; i++) {
    const start = pos;
    if (pos >= end) throw new PackError("truncated");
    let b = buf[pos++] as number;
    const type = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 16;
    while (b & 0x80) {
      if (pos >= end) throw new PackError("truncated entry header");
      b = buf[pos++] as number;
      size += (b & 0x7f) * shift;
      shift *= 128;
    }
    if (size > maxObjectBytes) throw new PackError("object too large");
    const e: RawEntry = { offset: start, type, data: Buffer.alloc(0) };
    if (type === OFS_DELTA) {
      let c = buf[pos++] as number;
      let off = c & 0x7f;
      while (c & 0x80) {
        if (pos >= end) throw new PackError("truncated delta offset");
        c = buf[pos++] as number;
        off = (off + 1) * 128 + (c & 0x7f);
      }
      if (off <= 0 || off > start) throw new PackError("bad delta offset");
      e.baseOffset = start - off;
    } else if (type === REF_DELTA) {
      if (pos + 20 > end) throw new PackError("truncated delta base");
      e.baseOid = buf.subarray(pos, pos + 20).toString("hex");
      pos += 20;
    } else if (!CODE_TYPE[type]) throw new PackError(`object type ${type}`);
    let inflated: { buffer: Buffer; engine: { bytesWritten: number } };
    try {
      inflated = inflateSync(buf.subarray(pos, end), {
        info: true,
        maxOutputLength: Math.max(size, 1),
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    } catch {
      throw new PackError("bad zlib stream");
    }
    if (inflated.buffer.byteLength !== size) throw new PackError("size mismatch");
    total += size;
    if (total > maxTotal) throw new PackError("pack too large");
    e.data = inflated.buffer;
    pos += inflated.engine.bytesWritten;
    byOffset.set(start, entries.length);
    entries.push(e);
  }
  if (pos !== end) throw new PackError("trailing bytes");

  // Whole objects first: their oids are what REF_DELTA entries name.
  const resolved: ({ type: GitObjectType; body: Buffer; oid: string } | undefined)[] = entries.map((e) => {
    const t = CODE_TYPE[e.type];
    return t ? { type: t, body: e.data, oid: hashObject(t, e.data) } : undefined;
  });
  const byOid = new Map<string, number>();
  for (const [i, r] of resolved.entries()) if (r) byOid.set(r.oid, i);
  const missing = [
    ...new Set(entries.filter((e) => e.baseOid && !byOid.has(e.baseOid)).map((e) => e.baseOid as string)),
  ];
  const external = missing.length && o.external ? await o.external(missing) : new Map();

  // Deltas: walk each chain down to a resolved base, then apply the deltas back up (iterative, depth-limited).
  // A REF_DELTA whose base is itself a delta resolves once that base is done, so passes repeat until no progress.
  let pending = entries.map((_, i) => i).filter((i) => !resolved[i]);
  while (pending.length) {
    const next: number[] = [];
    for (const i of pending) {
      if (resolved[i]) continue;
      const chain: number[] = [];
      let cur = i;
      let base: { type: GitObjectType; body: Buffer } | undefined;
      for (;;) {
        if (chain.length > maxDepth) throw new PackError("delta chain too deep");
        const done = resolved[cur];
        if (done) {
          base = done;
          break;
        }
        chain.push(cur);
        const e = entries[cur] as RawEntry;
        if (e.baseOffset !== undefined) {
          const at = byOffset.get(e.baseOffset);
          if (at === undefined) throw new PackError("delta base offset is not an entry");
          cur = at;
        } else {
          const oid = e.baseOid as string;
          const at = byOid.get(oid);
          if (at !== undefined) cur = at;
          else {
            base = external.get(oid);
            break;
          }
        }
      }
      if (!base) {
        next.push(i);
        continue;
      }
      let from: { type: GitObjectType; body: Buffer } = base;
      for (let k = chain.length - 1; k >= 0; k--) {
        const idx = chain[k] as number;
        const body = applyDelta(from.body, (entries[idx] as RawEntry).data);
        if (body.byteLength > maxObjectBytes) throw new PackError("object too large");
        total += body.byteLength;
        if (total > maxTotal) throw new PackError("pack too large");
        const r: { type: GitObjectType; body: Buffer; oid: string } = {
          type: from.type,
          body,
          oid: hashObject(from.type, body),
        };
        resolved[idx] = r;
        byOid.set(r.oid, idx);
        from = r;
      }
    }
    if (next.length === pending.length) throw new PackError("delta base missing");
    pending = next;
  }
  o.onStats?.({
    objects: count,
    ofsDeltas: entries.filter((e) => e.type === OFS_DELTA).length,
    refDeltas: entries.filter((e) => e.type === REF_DELTA).length,
    external: external.size,
  });
  return resolved.map((r) => ({
    oid: (r as GitObject).oid,
    type: (r as GitObject).type,
    body: (r as GitObject).body,
  }));
}
