// Uploaded tables at rest (db.yaml#imports.source_sha, data-boundary.yaml#import.values): AES-256-GCM with a sub-key of
// WIZARD_SECRETS_KEY (deploy.yaml#local.secrets; without it — local only — a per-process key), TTL 7 days.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveKey } from "../auth/crypto.js";
import type { Db } from "../db/index.js";

export const IMPORT_TTL_MS = 7 * 24 * 3600_000;
const MAGIC = Buffer.from("WZI1");
const IV = 12;
const TAG = 16;

export class ImportStore {
  readonly #key: Buffer;
  constructor(
    readonly dir: string,
    secretsKey: string,
  ) {
    this.#key = deriveKey(secretsKey, "imports/aes-256-gcm");
  }

  #path(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad import id");
    return join(this.dir, `${id}.enc`);
  }

  /** Encrypts and writes the file (the import id is the associated data); returns sha256 of the plaintext. */
  async put(id: string, data: Uint8Array): Promise<string> {
    const iv = randomBytes(IV);
    const c = createCipheriv("aes-256-gcm", this.#key, iv);
    c.setAAD(Buffer.from(id));
    const body = Buffer.concat([c.update(data), c.final()]);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = this.#path(id);
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, Buffer.concat([MAGIC, iv, c.getAuthTag(), body]), { mode: 0o600 });
    await rename(tmp, path);
    return createHash("sha256").update(data).digest("hex");
  }

  /** Decrypts the file; throws when it is gone, tampered with or does not match `sha`. */
  async get(id: string, sha?: string): Promise<Buffer> {
    const raw = await readFile(this.#path(id));
    if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("import file: bad format");
    const iv = raw.subarray(MAGIC.length, MAGIC.length + IV);
    const tag = raw.subarray(MAGIC.length + IV, MAGIC.length + IV + TAG);
    const d = createDecipheriv("aes-256-gcm", this.#key, iv);
    d.setAAD(Buffer.from(id));
    d.setAuthTag(tag);
    const data = Buffer.concat([d.update(raw.subarray(MAGIC.length + IV + TAG)), d.final()]);
    if (sha && createHash("sha256").update(data).digest("hex") !== sha)
      throw new Error("import file: sha256 mismatch");
    return data;
  }

  async remove(id: string): Promise<void> {
    await rm(this.#path(id), { force: true });
  }
}

/** TTL: files of imports past expires_at are deleted; unfinished imports become expired. Returns the count. */
export async function sweepExpiredImports(db: Db, store: ImportStore, now = new Date()): Promise<number> {
  const rows = await db
    .selectFrom("platform.imports")
    .select(["id", "status"])
    .where("expires_at", "<=", now)
    .where("status", "!=", "expired")
    .execute();
  for (const r of rows) {
    await store.remove(r.id);
    if (r.status !== "done")
      await db.updateTable("platform.imports").set({ status: "expired" }).where("id", "=", r.id).execute();
  }
  return rows.length;
}
