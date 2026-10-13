// V4-10 (D79 (6)): the semantic photo library. CI (tools/stock/fill.mjs, where the stocks are reachable) fills one shard
// per niche of the catalog — the photos copied into the platform photo library, their attribution and SigLIP image
// embeddings — and a build searches every shard by the meaning of a Russian query from the brief (text embedding on
// the platform CPU, siglip.ts). Storage: objects of the shared file storage named here and mapped to keys by the host
// (LibraryObjects), so the format does not depend on the storage. A shard is two objects — the vectors are written
// first, the meta last with their checksum, so a reader never pairs a new meta with old vectors.
import { z } from "zod";
import { normalizeNicheText } from "./catalog.js";
import type { StockHit } from "./client.js";

/** Version of the shard, manifest and request formats. */
export const SEMANTIC_VERSION = 2;
/** The embedding model of the library (siglip.ts SIGLIP.name): vectors of another model are never mixed in. */
export const SEMANTIC_MODEL = "siglip2-base-patch16-224";
/** Embedding size of the model. */
export const EMBED_DIM = 768;

/** Objects of the library in the file storage, by name (the host maps a name to a storage key). */
export interface LibraryObjects {
  get(name: string): Promise<Uint8Array | null>;
  put(name: string, data: Uint8Array, mime: "application/json" | "application/octet-stream"): Promise<void>;
}

/** The file storage of the platform as LibraryObjects (runtime FileStorage; `keyOf` — the library key of a name). */
export function storageObjects(
  storage: {
    get(key: string): Promise<{ data: Uint8Array } | null>;
    put(
      key: string,
      data: Uint8Array,
      meta: {
        name: string;
        mime: string;
        size: number;
        entity: string;
        field: string;
        uploadedBy: null;
        uploadedAt: string;
      },
    ): Promise<void>;
  },
  keyOf: (name: string) => string,
  now: () => Date = () => new Date(),
): LibraryObjects {
  return {
    get: async (name) => (await storage.get(keyOf(name)))?.data ?? null,
    put: (name, data, mime) =>
      storage.put(keyOf(name), data, {
        name: `${name.replace(/[^a-z0-9.-]+/gi, "-")}`.slice(0, 120),
        mime,
        size: data.byteLength,
        entity: "_photo_library",
        field: "semantic",
        uploadedBy: null,
        uploadedAt: now().toISOString(),
      }),
  };
}

/** Names of the library objects. */
export const SEMANTIC_OBJECTS = {
  manifest: "semantic:v2:manifest",
  requests: "semantic:v2:requests",
  meta: (slug: string) => `semantic:v2:shard:${slug}:meta`,
  vectors: (slug: string) => `semantic:v2:shard:${slug}:vectors`,
  model: (file: string) => `semantic:v2:model:${file}`,
} as const;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const hex = z.string().regex(/^#[0-9a-f]{6}$/);

const entrySchema = z.object({
  provider: z.enum(["pexels", "pixabay"]),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  /** Library photo id (runtime libraryPhotoId of `provider:id`). */
  file: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  author: z.string().min(1).max(120),
  authorUrl: z.url({ protocol: /^https$/ }).optional(),
  pageUrl: z.url({ protocol: /^https$/ }),
  /** Size of the library copy (the largest WebP variant). */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Mean colour of the photo and its mean luma (0–1): the visual pick and the grade read them. */
  color: hex,
  luma: z.number().min(0).max(1),
  /** The stock query the photo was found by. */
  query: z.string().min(1).max(100),
});

/** One photo of a shard. */
export type SemanticEntry = z.infer<typeof entrySchema>;

const metaSchema = z.object({
  version: z.literal(SEMANTIC_VERSION),
  slug: z.string().regex(SLUG_RE),
  name: z.string().min(1).max(80),
  model: z.string(),
  dim: z.number().int().positive(),
  /** Checksum of the vectors object (vectorsChecksum). */
  vectors: z.string().regex(/^[0-9a-f]{8}$/),
  entries: z.array(z.unknown()),
});

/** A niche shard: its photos and their embeddings (row i is the vector of entry i). */
export interface Shard {
  slug: string;
  name: string;
  entries: SemanticEntry[];
  vectors: QuantizedVectors;
}

/** Unit vectors as int8 rows with a scale each: value ≈ q × scale. */
export interface QuantizedVectors {
  dim: number;
  scales: Float32Array;
  data: Int8Array;
}

/** A unit vector (in place; a zero vector stays zero). */
export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const k = s > 0 ? 1 / Math.sqrt(s) : 0;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) * k;
  return v;
}

/** Rows quantized to int8 by their largest magnitude. */
export function quantize(rows: readonly Float32Array[], dim = EMBED_DIM): QuantizedVectors {
  const scales = new Float32Array(rows.length);
  const data = new Int8Array(rows.length * dim);
  rows.forEach((row, r) => {
    if (row.length !== dim) throw new Error(`embedding of ${row.length} values, expected ${dim}`);
    let max = 0;
    for (const x of row) max = Math.max(max, Math.abs(x));
    const scale = max > 0 ? max / 127 : 1;
    scales[r] = scale;
    for (let i = 0; i < dim; i++) data[r * dim + i] = Math.round((row[i] as number) / scale);
  });
  return { dim, scales, data };
}

const MAGIC = 0x3256_5a57; // "WZV2" little-endian

/** Bytes of the vectors object: magic, count, dim, the scales (f32), the rows (i8). */
export function encodeVectors(v: QuantizedVectors): Uint8Array {
  const n = v.scales.length;
  const out = new Uint8Array(12 + n * 4 + n * v.dim);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, n, true);
  dv.setUint32(8, v.dim, true);
  for (let i = 0; i < n; i++) dv.setFloat32(12 + i * 4, v.scales[i] as number, true);
  out.set(new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength), 12 + n * 4);
  return out;
}

/** The vectors object; throws on a broken one. */
export function decodeVectors(bytes: Uint8Array): QuantizedVectors {
  if (bytes.byteLength < 12) throw new Error("vectors: too short");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("vectors: bad magic");
  const n = dv.getUint32(4, true);
  const dim = dv.getUint32(8, true);
  if (bytes.byteLength !== 12 + n * 4 + n * dim) throw new Error("vectors: bad size");
  const scales = new Float32Array(n);
  for (let i = 0; i < n; i++) scales[i] = dv.getFloat32(12 + i * 4, true);
  const data = new Int8Array(n * dim);
  data.set(new Int8Array(bytes.buffer, bytes.byteOffset + 12 + n * 4, n * dim));
  return { dim, scales, data };
}

/** FNV-1a of the bytes, 8 hex digits (pairs a meta with its vectors; not a security check). */
export function vectorsChecksum(bytes: Uint8Array): string {
  let h = 2166136261;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Writes a shard: the vectors first, then the meta naming their checksum. */
export async function writeShard(objects: LibraryObjects, shard: Shard): Promise<void> {
  if (!SLUG_RE.test(shard.slug)) throw new Error(`shard slug ${shard.slug}`);
  if (shard.vectors.scales.length !== shard.entries.length) throw new Error("shard: entries ≠ vectors");
  const bytes = encodeVectors(shard.vectors);
  await objects.put(SEMANTIC_OBJECTS.vectors(shard.slug), bytes, "application/octet-stream");
  const meta = {
    version: SEMANTIC_VERSION,
    slug: shard.slug,
    name: shard.name,
    model: SEMANTIC_MODEL,
    dim: shard.vectors.dim,
    vectors: vectorsChecksum(bytes),
    entries: shard.entries,
  };
  await objects.put(SEMANTIC_OBJECTS.meta(shard.slug), json(meta), "application/json");
}

/**
 * A shard as stored; null — none yet, or not usable (another model, vectors not matching the meta: a write in
 * progress). Invalid entries are dropped together with their vectors.
 */
export async function readShard(objects: LibraryObjects, slug: string): Promise<Shard | null> {
  const raw = await objects.get(SEMANTIC_OBJECTS.meta(slug));
  if (!raw) return null;
  const meta = metaSchema.safeParse(parse(raw));
  if (!meta.success || meta.data.model !== SEMANTIC_MODEL || meta.data.dim !== EMBED_DIM) return null;
  const bytes = await objects.get(SEMANTIC_OBJECTS.vectors(slug));
  if (!bytes || vectorsChecksum(bytes) !== meta.data.vectors) return null;
  const vectors = decodeVectors(bytes);
  if (vectors.dim !== EMBED_DIM || vectors.scales.length !== meta.data.entries.length) return null;
  const keep: number[] = [];
  const entries: SemanticEntry[] = [];
  meta.data.entries.forEach((e, i) => {
    const r = entrySchema.safeParse(e);
    if (r.success) {
      keep.push(i);
      entries.push(r.data);
    }
  });
  return { slug, name: meta.data.name, entries, vectors: pick(vectors, keep) };
}

/** Rows `keep` of the vectors. */
export function pick(v: QuantizedVectors, keep: readonly number[]): QuantizedVectors {
  if (keep.length === v.scales.length && keep.every((k, i) => k === i)) return v;
  const scales = new Float32Array(keep.length);
  const data = new Int8Array(keep.length * v.dim);
  keep.forEach((k, i) => {
    scales[i] = v.scales[k] as number;
    data.set(v.data.subarray(k * v.dim, (k + 1) * v.dim), i * v.dim);
  });
  return { dim: v.dim, scales, data };
}

const manifestSchema = z.object({
  version: z.literal(SEMANTIC_VERSION),
  model: z.string(),
  shards: z.array(
    z.object({
      slug: z.string().regex(SLUG_RE),
      name: z.string().min(1).max(80),
      count: z.number().int().nonnegative(),
      updatedAt: z.string(),
    }),
  ),
});

/** The list of shards the platform loads (written by CI after its shards). */
export type Manifest = z.infer<typeof manifestSchema>;

export async function readManifest(objects: LibraryObjects): Promise<Manifest | null> {
  const raw = await objects.get(SEMANTIC_OBJECTS.manifest);
  if (!raw) return null;
  const m = manifestSchema.safeParse(parse(raw));
  return m.success && m.data.model === SEMANTIC_MODEL ? m.data : null;
}

export async function writeManifest(objects: LibraryObjects, m: Manifest): Promise<void> {
  const shards = [...m.shards].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  await objects.put(SEMANTIC_OBJECTS.manifest, json({ ...m, shards }), "application/json");
}

/** One row of the loaded library: the entry and the niche it was filled for. */
export interface LibraryPhotoEntry extends SemanticEntry {
  niche: string;
}

/** A search candidate: the entry and its similarity to the query (cosine, ≈ −0.1…0.2 for SigLIP text–image). */
export interface Candidate {
  entry: LibraryPhotoEntry;
  score: number;
}

export interface SearchOptions {
  /** Candidates at most (default 20). */
  limit?: number;
  /** Photos that may be returned (orientation, size of the slot). */
  filter?: (e: LibraryPhotoEntry) => boolean;
  /** `provider:id` already used on the site. */
  exclude?: ReadonlySet<string>;
  /** Cosine between two photos above which the later one is a near duplicate and skipped (default 0.92). */
  duplicate?: number;
}

export const sourceOf = (e: { provider: string; id: string }): string => `${e.provider}:${e.id}`;

/** All loaded shards as one searchable set (rows in shard order). */
export class SemanticLibrary {
  readonly entries: LibraryPhotoEntry[] = [];
  private readonly scales: Float32Array;
  private readonly data: Int8Array;
  readonly dim = EMBED_DIM;

  constructor(shards: readonly Shard[]) {
    const n = shards.reduce((s, sh) => s + sh.entries.length, 0);
    this.scales = new Float32Array(n);
    this.data = new Int8Array(n * EMBED_DIM);
    const seen = new Set<string>();
    let row = 0;
    for (const sh of shards)
      sh.entries.forEach((e, i) => {
        // A photo filled for two niches is kept once (its first shard).
        if (seen.has(sourceOf(e))) return;
        seen.add(sourceOf(e));
        this.entries.push({ ...e, niche: sh.slug });
        this.scales[row] = sh.vectors.scales[i] as number;
        this.data.set(sh.vectors.data.subarray(i * EMBED_DIM, (i + 1) * EMBED_DIM), row * EMBED_DIM);
        row++;
      });
  }

  get size(): number {
    return this.entries.length;
  }

  /** Cosine of row `r` with a unit query vector. */
  score(r: number, q: Float32Array): number {
    const d = this.dim;
    const o = r * d;
    let s = 0;
    for (let i = 0; i < d; i++) s += (this.data[o + i] as number) * (q[i] as number);
    return s * (this.scales[r] as number);
  }

  /** Cosine of two rows. */
  similarity(a: number, b: number): number {
    const d = this.dim;
    let s = 0;
    for (let i = 0; i < d; i++) s += (this.data[a * d + i] as number) * (this.data[b * d + i] as number);
    return s * (this.scales[a] as number) * (this.scales[b] as number);
  }

  /** The photos closest to the query, best first, without near duplicates of each other. */
  search(q: Float32Array, o: SearchOptions = {}): Candidate[] {
    if (q.length !== this.dim) throw new Error(`query of ${q.length} values, expected ${this.dim}`);
    const limit = o.limit ?? 20;
    const dup = o.duplicate ?? 0.92;
    const rows: { r: number; s: number }[] = [];
    for (let r = 0; r < this.entries.length; r++) {
      const e = this.entries[r] as LibraryPhotoEntry;
      if (o.exclude?.has(sourceOf(e)) || (o.filter && !o.filter(e))) continue;
      rows.push({ r, s: this.score(r, q) });
    }
    rows.sort((a, b) => b.s - a.s || a.r - b.r);
    const picked: { r: number; s: number }[] = [];
    for (const c of rows) {
      if (picked.length >= limit) break;
      if (picked.some((p) => this.similarity(p.r, c.r) > dup)) continue;
      picked.push(c);
    }
    return picked.map((p) => ({ entry: this.entries[p.r] as LibraryPhotoEntry, score: p.s }));
  }
}

/** The library of the manifest's shards (a shard that cannot be read is left out); null — no manifest yet. */
export async function loadSemanticLibrary(objects: LibraryObjects): Promise<SemanticLibrary | null> {
  const m = await readManifest(objects);
  if (!m) return null;
  const shards = await Promise.all(m.shards.map((s) => readShard(objects, s.slug).catch(() => null)));
  return new SemanticLibrary(shards.filter((s): s is Shard => s !== null));
}

/** A library entry as a stock hit (downloadUrl is never fetched: the copy is already in the library). */
export const hitOfEntry = (e: SemanticEntry): StockHit & { file: string } => ({
  provider: e.provider,
  id: e.id,
  width: e.width,
  height: e.height,
  author: e.author,
  ...(e.authorUrl ? { authorUrl: e.authorUrl } : {}),
  pageUrl: e.pageUrl,
  downloadUrl: `library:${e.file}`,
  file: e.file,
});

/** Score a candidate needs to count as on topic (SigLIP2 base, Russian query; checked on niche probes). */
export const GOOD_SCORE = 0.08;
/** On-topic candidates below which a query's niche is requested for backfill. */
export const MIN_GOOD = 8;

/** true — the library has too few photos on the query's topic: the niche goes to the backfill requests. */
export const needsBackfill = (candidates: readonly Candidate[]): boolean =>
  candidates.filter((c) => c.score >= GOOD_SCORE).length < MIN_GOOD;

const requestsSchema = z.object({
  version: z.literal(SEMANTIC_VERSION),
  requests: z.array(
    z.object({
      text: z.string().min(1).max(80),
      /** Builds that asked for it. */
      count: z.number().int().positive(),
      at: z.string(),
    }),
  ),
});

/** Niches the builds asked to backfill, the newest last (CI takes them, tools/stock/fill.mjs backfill). */
export type NicheRequests = z.infer<typeof requestsSchema>;

/** Requests kept at most (the oldest dropped). */
export const MAX_REQUESTS = 200;

export async function readRequests(objects: LibraryObjects): Promise<NicheRequests> {
  const raw = await objects.get(SEMANTIC_OBJECTS.requests);
  const r = raw ? requestsSchema.safeParse(parse(raw)) : null;
  return r?.success ? r.data : { version: SEMANTIC_VERSION, requests: [] };
}

export async function writeRequests(objects: LibraryObjects, r: NicheRequests): Promise<void> {
  await objects.put(
    SEMANTIC_OBJECTS.requests,
    json({ ...r, requests: r.requests.slice(-MAX_REQUESTS) }),
    "application/json",
  );
}

/**
 * Adds a niche to the backfill requests (the same normalized text counts once more). Read–modify–write: two builds at
 * the same moment may lose one count, never a request of a niche asked again later.
 */
export async function requestBackfill(
  objects: LibraryObjects,
  text: string,
  now = new Date(),
): Promise<void> {
  const key = normalizeNicheText(text);
  if (!key) return;
  const cur = await readRequests(objects);
  const old = cur.requests.find((r) => r.text === key);
  const rest = cur.requests.filter((r) => r.text !== key);
  await writeRequests(objects, {
    version: SEMANTIC_VERSION,
    requests: [...rest, { text: key, count: (old?.count ?? 0) + 1, at: now.toISOString() }],
  });
}

const json = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v)}\n`);
const parse = (b: Uint8Array): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(b));
  } catch {
    return null;
  }
};
