// Content-addressed blobs (db.yaml#files, deploy.yaml#local.artifacts): write to storage before the row.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Db } from "../db/index.js";

export const MAX_BLOB = 5_242_880;

export class IntegrityError extends Error {
  readonly code = "INTEGRITY";
  constructor(sha: string) {
    super(`blob ${sha}: sha256 mismatch`);
  }
}

export const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

export class BlobStore {
  constructor(readonly root: string) {}

  static key(sha: string): string {
    return `blobs/${sha.slice(0, 2)}/${sha.slice(2)}`;
  }

  /** Writes the blob file (if absent) and then its platform.files row. Returns sha256. */
  async put(db: Db, data: Uint8Array, contentType: string): Promise<{ sha256: string; size: number }> {
    if (data.byteLength > MAX_BLOB) throw new RangeError("blob too large");
    const sha = sha256(data);
    const key = BlobStore.key(sha);
    const path = join(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, path);
    await db
      .insertInto("platform.files")
      .values({ sha256: sha, size: data.byteLength, content_type: contentType, storage_key: key })
      .onConflict((oc) => oc.column("sha256").doNothing())
      .execute();
    return { sha256: sha, size: data.byteLength };
  }

  /** Reads and verifies a blob; throws IntegrityError on mismatch. */
  async get(sha: string): Promise<Buffer> {
    const data = await readFile(join(this.root, BlobStore.key(sha)));
    if (sha256(data) !== sha) throw new IntegrityError(sha);
    return data;
  }
}
