// Object storage of file fields (runtime.yaml#files.storage): bucket system-files in RF (S3-compatible Cloud.ru Object
// Storage, SSE-KMS) in the cloud; a local folder (dev, e2e) or memory (tests, G1) otherwise. Key =
// <schema app_<key>_<env>>/<fileId>; the field value is the fileId, never a URL. Metadata travels with the object.
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type S3Credentials, sha256Hex, signRequest } from "./sigv4.js";
import type { FileMime } from "./sniff.js";

export interface FileMeta {
  /** Display name (sanitised upload name). */
  name: string;
  /** application/json — only the photo library index (photo-library.ts), never a file field. */
  mime: FileMime | "application/json";
  size: number;
  /** Entity and file field the upload is for (permission of the upload; the row is the permission of reads). */
  entity: string;
  field: string;
  /** users.id of the uploader; null — public role. */
  uploadedBy: string | null;
  uploadedAt: string;
  /**
   * Image field (runtime.yaml#files.image, M2-47): the object is the largest WebP variant; `variants` lists the smaller
   * slots stored under <key>.w<slot>.
   */
  image?: { width: number; height: number; variants: number[] };
}

export interface StoredFile {
  data: Uint8Array;
  meta: FileMeta;
}

export interface FileStorage {
  readonly kind: "s3" | "fs" | "memory";
  put(key: string, data: Uint8Array, meta: FileMeta): Promise<void>;
  head(key: string): Promise<FileMeta | null>;
  get(key: string): Promise<StoredFile | null>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
  /** Keys under `prefix` (a schema name followed by "/"). */
  list(prefix: string): Promise<string[]>;
}

/**
 * <schema>/<uuid>, or <schema>/<uuid>.w<slot> for a smaller image variant: the only key shapes the backends accept (no
 * traversal, no foreign prefixes).
 */
export const FILE_KEY_RE =
  /^[a-z0-9_]{1,63}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.w[0-9]{2,4})?$/;
const PREFIX_RE = /^[a-z0-9_]{1,63}\/$/;

function assertKey(key: string): void {
  if (!FILE_KEY_RE.test(key)) throw new Error("invalid file key");
}
function assertPrefix(prefix: string): void {
  if (!PREFIX_RE.test(prefix)) throw new Error("invalid file prefix");
}

const encodeMeta = (m: FileMeta) => Buffer.from(JSON.stringify(m), "utf8").toString("base64url");
function parseMeta(json: string): FileMeta | null {
  try {
    const m = JSON.parse(json) as FileMeta;
    return typeof m?.name === "string" && typeof m.entity === "string" && typeof m.field === "string"
      ? m
      : null;
  } catch {
    return null;
  }
}
const decodeMeta = (raw: string | null | undefined) =>
  raw ? parseMeta(Buffer.from(raw, "base64url").toString("utf8")) : null;

// ------------------------------------------------------------------------------------------------

export class MemoryFileStorage implements FileStorage {
  readonly kind = "memory" as const;
  readonly objects = new Map<string, StoredFile>();

  async put(key: string, data: Uint8Array, meta: FileMeta) {
    assertKey(key);
    this.objects.set(key, { data: new Uint8Array(data), meta: { ...meta } });
  }
  async head(key: string) {
    return FILE_KEY_RE.test(key) ? (this.objects.get(key)?.meta ?? null) : null;
  }
  async get(key: string) {
    return FILE_KEY_RE.test(key) ? (this.objects.get(key) ?? null) : null;
  }
  async delete(key: string) {
    assertKey(key);
    this.objects.delete(key);
  }
  async list(prefix: string) {
    assertPrefix(prefix);
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

/** <root>/<schema>/<fileId> (bytes) + <fileId>.meta.json. */
export class FsFileStorage implements FileStorage {
  readonly kind = "fs" as const;
  constructor(readonly root: string) {}

  async put(key: string, data: Uint8Array, meta: FileMeta) {
    assertKey(key);
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.meta.json`, JSON.stringify(meta));
    await writeFile(path, data);
  }
  async head(key: string) {
    if (!FILE_KEY_RE.test(key)) return null;
    try {
      await stat(join(this.root, key));
      return parseMeta(await readFile(join(this.root, `${key}.meta.json`), "utf8"));
    } catch {
      return null;
    }
  }
  async get(key: string) {
    const meta = await this.head(key);
    if (!meta) return null;
    try {
      return { data: new Uint8Array(await readFile(join(this.root, key))), meta };
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    assertKey(key);
    await rm(join(this.root, key), { force: true });
    await rm(join(this.root, `${key}.meta.json`), { force: true });
  }
  async list(prefix: string) {
    assertPrefix(prefix);
    try {
      const names = await readdir(join(this.root, prefix));
      return names
        .map((n) => `${prefix}${n}`)
        .filter((k) => FILE_KEY_RE.test(k))
        .sort();
    } catch {
      return [];
    }
  }
}

// ------------------------------------------------------------------------------------------------

export interface S3Config {
  /** https://s3.cloud.ru (path-style requests: <endpoint>/<bucket>/<key>). */
  endpoint: string;
  region: string;
  bucket: string;
  credentials: S3Credentials;
  /** SSE-KMS key id (x-amz-server-side-encryption: aws:kms); empty — bucket default encryption. */
  kmsKeyId?: string;
  fetch?: typeof fetch;
  clock?: () => Date;
}

export class S3Error extends Error {
  override name = "S3Error";
  constructor(
    readonly status: number,
    readonly op: string,
  ) {
    super(`S3 ${op} failed: HTTP ${status}`);
  }
}

const META_HEADER = "x-amz-meta-wizard";

const xmlText = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** S3-compatible client with SigV4 (PutObject, HeadObject, GetObject, DeleteObject, ListObjectsV2). */
export class S3FileStorage implements FileStorage {
  readonly kind = "s3" as const;
  private readonly f: typeof fetch;
  private readonly clock: () => Date;

  constructor(readonly config: S3Config) {
    this.f = config.fetch ?? fetch;
    this.clock = config.clock ?? (() => new Date());
  }

  private url(key: string, query?: Record<string, string>): URL {
    const base = this.config.endpoint.replace(/\/+$/, "");
    const u = new URL(`${base}/${encodeURIComponent(this.config.bucket)}/${key}`);
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    return u;
  }

  private async send(
    op: string,
    method: string,
    url: URL,
    body?: Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const signed = signRequest({
      method,
      url,
      headers,
      payloadHash: sha256Hex(body ?? new Uint8Array()),
      region: this.config.region,
      credentials: this.config.credentials,
      date: this.clock(),
    });
    delete signed.host;
    const res = await this.f(url, {
      method,
      headers: signed,
      ...(body ? { body: body as Uint8Array<ArrayBuffer> } : {}),
    });
    if (res.status >= 500 || res.status === 403 || res.status === 401) {
      await res.body?.cancel();
      throw new S3Error(res.status, op);
    }
    return res;
  }

  async put(key: string, data: Uint8Array, meta: FileMeta) {
    assertKey(key);
    // No content-length of our own: fetch sets it from the body. With ours it sends "N, N", which Node's bundled undici
    // accepts but the undici package (v7, a dependency of @wizard/llm) rejects as the global dispatcher it installs when
    // it loads first — every put was «TypeError: fetch failed» (B2-43 seeding, process with @wizard/agents loaded).
    const headers: Record<string, string> = {
      "content-type": meta.mime,
      [META_HEADER]: encodeMeta(meta),
    };
    if (this.config.kmsKeyId) {
      headers["x-amz-server-side-encryption"] = "aws:kms";
      headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.config.kmsKeyId;
    }
    const res = await this.send("put", "PUT", this.url(key), data, headers);
    await res.body?.cancel();
    if (!res.ok) throw new S3Error(res.status, "put");
  }

  async head(key: string) {
    if (!FILE_KEY_RE.test(key)) return null;
    const res = await this.send("head", "HEAD", this.url(key));
    await res.body?.cancel();
    if (res.status === 404) return null;
    if (!res.ok) throw new S3Error(res.status, "head");
    return decodeMeta(res.headers.get(META_HEADER));
  }

  async get(key: string) {
    if (!FILE_KEY_RE.test(key)) return null;
    const res = await this.send("get", "GET", this.url(key));
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new S3Error(res.status, "get");
    }
    const meta = decodeMeta(res.headers.get(META_HEADER));
    const data = new Uint8Array(await res.arrayBuffer());
    return meta ? { data, meta } : null;
  }

  async delete(key: string) {
    assertKey(key);
    const res = await this.send("delete", "DELETE", this.url(key));
    await res.body?.cancel();
    if (!res.ok && res.status !== 404) throw new S3Error(res.status, "delete");
  }

  async list(prefix: string) {
    assertPrefix(prefix);
    const keys: string[] = [];
    let token: string | undefined;
    for (let page = 0; page < 10_000; page++) {
      const q: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
      if (token) q["continuation-token"] = token;
      const res = await this.send("list", "GET", this.url("", q));
      const xml = await res.text();
      if (!res.ok) throw new S3Error(res.status, "list");
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
        const k = xmlText(m[1] as string);
        if (FILE_KEY_RE.test(k)) keys.push(k);
      }
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) break;
      token = xmlText(next);
    }
    return keys.sort();
  }
}

// ------------------------------------------------------------------------------------------------

type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Storage from env (platform/deploy.yaml#local.env_vars M2): WIZARD_FILES_STORAGE = fs (default) | memory | s3;
 * fs — WIZARD_FILES_DIR or `defaultDir`; s3 — WIZARD_S3_ENDPOINT, WIZARD_S3_REGION, WIZARD_S3_BUCKET (system-files),
 * WIZARD_S3_ACCESS_KEY_ID, WIZARD_S3_SECRET_ACCESS_KEY, WIZARD_S3_KMS_KEY_ID. s3 without keys throws.
 */
export function createFileStorage(env: EnvSource, o: { defaultDir: string }): FileStorage {
  const kind = env.WIZARD_FILES_STORAGE || "fs";
  if (kind === "memory") return new MemoryFileStorage();
  if (kind === "s3") {
    const endpoint = env.WIZARD_S3_ENDPOINT;
    const accessKeyId = env.WIZARD_S3_ACCESS_KEY_ID;
    const secretAccessKey = env.WIZARD_S3_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey)
      throw new Error(
        "WIZARD_FILES_STORAGE=s3 needs WIZARD_S3_ENDPOINT, WIZARD_S3_ACCESS_KEY_ID, WIZARD_S3_SECRET_ACCESS_KEY",
      );
    return new S3FileStorage({
      endpoint,
      region: env.WIZARD_S3_REGION || "ru-central-1",
      bucket: env.WIZARD_S3_BUCKET || "system-files",
      credentials: { accessKeyId, secretAccessKey },
      ...(env.WIZARD_S3_KMS_KEY_ID ? { kmsKeyId: env.WIZARD_S3_KMS_KEY_ID } : {}),
    });
  }
  if (kind !== "fs") throw new Error(`WIZARD_FILES_STORAGE: unknown backend ${kind}`);
  return new FsFileStorage(env.WIZARD_FILES_DIR || o.defaultDir);
}

/** Deletes every object of a system schema (delete_system, F5 draft purge); returns the count. */
export async function purgeSchemaFiles(storage: FileStorage, schema: string): Promise<number> {
  const keys = await storage.list(`${schema}/`);
  for (const k of keys) await storage.delete(k);
  return keys.length;
}
