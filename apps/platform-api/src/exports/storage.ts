// Export archives at rest (db.yaml#exports.storage_key): <artifactsDir>/exports/<id>.enc, AES-256-GCM with a sub-key of
// WIZARD_SECRETS_KEY (as imports), written and read as a stream: MAGIC | iv | ciphertext | tag. TTL 24 h.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline, Readable } from "node:stream";
import { deriveKey, sharedKeyMaterial } from "../auth/crypto.js";
import type { Db } from "../db/index.js";

export const EXPORT_TTL_MS = 24 * 3600_000;
export const EXPORT_LINK_TTL_MS = 15 * 60_000;
const MAGIC = Buffer.from("WZE1");
const IV = 12;
const TAG = 16;
const HEADER = MAGIC.length + IV;

export interface ExportWriter {
  /** Encrypts and appends plaintext chunks. */
  write(chunks: readonly Uint8Array[]): Promise<void>;
  /** Finalizes (auth tag) and moves the file in place; returns the plaintext size. */
  finish(): Promise<number>;
  /** Drops the partial file. */
  abort(): Promise<void>;
}

export class ExportStore {
  readonly #secretsKey: string;
  #k: Buffer | undefined;
  readonly dir: string;
  constructor(artifactsDir: string, secretsKey: string) {
    this.dir = join(artifactsDir, "exports");
    this.#secretsKey = secretsKey;
  }

  // Lazy: the local key file (no WIZARD_SECRETS_KEY) is created on first use, shared with apps/worker.
  get #key(): Buffer {
    this.#k ??= deriveKey(sharedKeyMaterial(this.#secretsKey, this.dir), "exports/aes-256-gcm");
    return this.#k;
  }

  /** db.yaml#exports.storage_key of an export. */
  static key(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad export id");
    return `exports/${id}.enc`;
  }

  #path(id: string): string {
    return join(this.dir, `${ExportStore.key(id).slice("exports/".length)}`);
  }

  async create(id: string): Promise<ExportWriter> {
    const path = this.#path(id);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fh = await open(tmp, "wx", 0o600);
    const iv = randomBytes(IV);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(id));
    await fh.write(Buffer.concat([MAGIC, iv]));
    let size = 0;
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await fh.close();
      }
    };
    return {
      async write(chunks) {
        if (chunks.length === 0) return;
        const plain = Buffer.concat(chunks);
        size += plain.length;
        await fh.write(cipher.update(plain));
      },
      async finish() {
        await fh.write(Buffer.concat([cipher.final(), cipher.getAuthTag()]));
        await fh.sync();
        await close();
        await rename(tmp, path);
        return size;
      },
      async abort() {
        await close().catch(() => {});
        await rm(tmp, { force: true });
      },
    };
  }

  /**
   * Decrypting stream of the archive and its plaintext size. The GCM tag is checked at the end of the stream: a
   * tampered file makes the stream fail instead of completing.
   */
  async open(id: string): Promise<{ stream: Readable; size: number }> {
    const path = this.#path(id);
    const total = (await stat(path)).size;
    if (total < HEADER + TAG) throw new Error("export file: bad format");
    const fh = await open(path, "r");
    const head = Buffer.alloc(HEADER);
    const tag = Buffer.alloc(TAG);
    try {
      await fh.read(head, 0, HEADER, 0);
      await fh.read(tag, 0, TAG, total - TAG);
    } finally {
      await fh.close();
    }
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("export file: bad format");
    const d = createDecipheriv("aes-256-gcm", this.#key, head.subarray(MAGIC.length));
    d.setAAD(Buffer.from(id));
    d.setAuthTag(tag);
    const size = total - HEADER - TAG;
    const src =
      size > 0 ? createReadStream(path, { start: HEADER, end: total - TAG - 1 }) : Readable.from([]);
    // pipeline propagates a read error or a tag mismatch to the returned stream.
    return { stream: pipeline(src, d, () => {}), size };
  }

  async remove(id: string): Promise<void> {
    await rm(this.#path(id), { force: true });
  }
}

/** TTL (db.yaml#exports.expires_at): archives past expires_at are deleted, the export becomes expired. */
export async function sweepExpiredExports(db: Db, store: ExportStore, now = new Date()): Promise<number> {
  const rows = await db
    .selectFrom("platform.exports")
    .select("id")
    .where("expires_at", "<=", now)
    .where("status", "in", ["running", "ready"])
    .execute();
  for (const r of rows) {
    await store.remove(r.id);
    await db
      .updateTable("platform.exports")
      .set({
        status: "expired",
        storage_key: null,
        download_token_hash: null,
        download_token_expires_at: null,
      })
      .where("id", "=", r.id)
      .execute();
  }
  return rows.length;
}
