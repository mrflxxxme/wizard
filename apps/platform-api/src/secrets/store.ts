// Connector secrets, local backend (deploy.yaml#local.secrets: .data/secrets.enc, AES-256-GCM, key WIZARD_SECRETS_KEY;
// db.yaml#secrets_refs backend=local_encrypted). Values never leave this module except through get().
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Transaction } from "kysely";
import type { DB } from "../db/index.js";

export const SECRET_NAME = /^[a-z0-9_]+$/;

export interface SecretPut {
  orgId: string;
  systemId: string;
  env: "draft" | "prod";
  name: string;
  value: string;
  createdBy?: string | null;
}

const platformPath = (p: string): string => {
  if (!/^[a-z0-9_/-]{1,200}$/.test(p) || p.includes("..")) throw new Error("invalid platform secret path");
  return p.startsWith("platform/") ? p : `platform/${p}`;
};

interface FileShape {
  v: 1;
  entries: Record<string, string>;
}

/** secret://name references (connector-interface.md) backed by an encrypted local file. */
export class SecretStore {
  readonly #file: string;
  readonly #keyMaterial: string;
  #k: Buffer | undefined;

  /** keyMaterial: WIZARD_SECRETS_KEY; empty → a random key kept next to the file (local only, 0600). */
  constructor(file: string, keyMaterial: string) {
    this.#file = file;
    this.#keyMaterial = keyMaterial;
  }

  get #key(): Buffer {
    if (!this.#k) {
      let ikm: Buffer;
      if (this.#keyMaterial) ikm = Buffer.from(this.#keyMaterial, "utf8");
      else {
        const keyFile = `${this.#file}.key`;
        if (!existsSync(keyFile)) {
          mkdirSync(dirname(keyFile), { recursive: true });
          writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
        }
        ikm = readFileSync(keyFile);
      }
      this.#k = Buffer.from(hkdfSync("sha256", ikm, "wizard", "secrets-store", 32));
    }
    return this.#k;
  }

  #read(): FileShape {
    if (!existsSync(this.#file)) return { v: 1, entries: {} };
    return JSON.parse(readFileSync(this.#file, "utf8")) as FileShape;
  }

  #write(f: FileShape): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  #encrypt(path: string, value: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, iv);
    c.setAAD(Buffer.from(path));
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }

  #decrypt(path: string, raw: string): string {
    const buf = Buffer.from(raw, "base64");
    const d = createDecipheriv("aes-256-gcm", this.#key, buf.subarray(0, 12));
    d.setAAD(Buffer.from(path));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
  }

  /** Encrypts and stores the value, upserts secrets_refs in `trx`; returns secret://name. */
  async put(trx: Transaction<DB>, p: SecretPut): Promise<string> {
    if (!SECRET_NAME.test(p.name)) throw new Error("invalid secret name");
    const path = `${p.systemId}/${p.env}/${p.name}`;
    const f = this.#read();
    f.entries[path] = this.#encrypt(path, p.value);
    this.#write(f);
    await trx
      .insertInto("platform.secrets_refs")
      .values({
        org_id: p.orgId,
        system_id: p.systemId,
        env: p.env,
        name: p.name,
        backend: "local_encrypted",
        backend_path: path,
        created_by: p.createdBy ?? null,
      })
      .onConflict((oc) =>
        oc.columns(["system_id", "env", "name"]).doUpdateSet({ backend_path: path, rotated_at: new Date() }),
      )
      .execute();
    return `secret://${p.name}`;
  }

  /** Deletes every value of a system (workflows.yaml#delete_system); returns the number removed. */
  removeSystem(systemId: string): number {
    const f = this.#read();
    const prefix = `${systemId}/`;
    const kept = Object.entries(f.entries).filter(([k]) => !k.startsWith(prefix));
    const removed = Object.keys(f.entries).length - kept.length;
    if (removed > 0) this.#write({ ...f, entries: Object.fromEntries(kept) });
    return removed;
  }

  /** The stored value, or null. */
  get(systemId: string, env: "draft" | "prod", name: string): string | null {
    return this.getPlatform(`${systemId}/${env}/${name}`);
  }

  /** Removes one value of a system (V3-21 key window: removal of a key); false — there was none. */
  remove(systemId: string, env: "draft" | "prod", name: string): boolean {
    if (!SECRET_NAME.test(name)) throw new Error("invalid secret name");
    const path = `${systemId}/${env}/${name}`;
    const f = this.#read();
    if (!(path in f.entries)) return false;
    delete f.entries[path];
    this.#write(f);
    return true;
  }

  /**
   * Platform secrets outside connectors (staff TOTP keys, users.totp_secret_ref, M2-08): `path` under «platform/»;
   * returns the secret:// reference kept in the DB.
   */
  putPlatform(path: string, value: string): string {
    const full = platformPath(path);
    const f = this.#read();
    f.entries[full] = this.#encrypt(full, value);
    this.#write(f);
    return `secret://${full}`;
  }

  /** A platform secret by its path or secret:// reference, or null. */
  getPlatform(pathOrRef: string): string | null {
    const path = pathOrRef.replace(/^secret:\/\//, "");
    const raw = this.#read().entries[path];
    return raw ? this.#decrypt(path, raw) : null;
  }

  /** Removes a platform secret (MFA reset). */
  removePlatform(pathOrRef: string): void {
    const path = pathOrRef.replace(/^secret:\/\//, "");
    const f = this.#read();
    if (!(path in f.entries)) return;
    delete f.entries[path];
    this.#write(f);
  }
}
