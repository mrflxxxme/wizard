// Read side of the platform's encrypted secret file for the runtime (V3-23: a draft or a published shop pays with the
// keys its owner gave through the key window). platform-api writes the file (apps/platform-api/src/secrets/store.ts
// SecretStore, db.yaml#secrets_refs backend=local_encrypted): one JSON {v: 1, entries: {path: base64(iv‖tag‖ct)}},
// AES-256-GCM under HKDF-SHA-256(WIZARD_SECRETS_KEY, salt «wizard», info «secrets-store»), the entry path as AAD. The
// runtime mounts the same data volume and has the same key; this reader opens only connector paths
// <system id>/<draft|prod>/<name> — never the platform's own secrets under «platform/» (staff TOTP keys).
import { createDecipheriv, hkdfSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { missingSecret } from "./secrets.js";
import type { SecretReader } from "./types.js";

const NAME = /^[a-z0-9_]+$/;
const SYSTEM = /^[0-9a-f-]{36}$/;

/** The file key: from WIZARD_SECRETS_KEY, else the local random key next to the file (as platform-api makes it). */
export function secretFileKey(file: string, keyMaterial: string): Buffer | null {
  let ikm: Buffer;
  if (keyMaterial) ikm = Buffer.from(keyMaterial, "utf8");
  else if (existsSync(`${file}.key`)) ikm = readFileSync(`${file}.key`);
  else return null;
  return Buffer.from(hkdfSync("sha256", ikm, "wizard", "secrets-store", 32));
}

/** One entry of the file in clear, or null (no file, no entry). A tampered entry throws (GCM). */
export function readSecretFileEntry(file: string, key: Buffer, path: string): string | null {
  if (!existsSync(file)) return null;
  const doc = JSON.parse(readFileSync(file, "utf8")) as { entries?: Record<string, string> };
  const raw = doc.entries?.[path];
  if (typeof raw !== "string") return null;
  const buf = Buffer.from(raw, "base64");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAAD(Buffer.from(path));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

/**
 * The secrets of one system and environment from the file: `systemUuid` gives platform.systems.id of the runtime's
 * system (the file is keyed by it); a name the file lacks goes to `fallback` (the M0 env variables), else SECRET_MISSING.
 * The file is read on each call: a key replaced or removed in the window applies at once.
 */
export function fileSecretReader(o: {
  file: string;
  keyMaterial: string;
  env: "draft" | "prod";
  systemUuid: () => Promise<string | null>;
  fallback?: SecretReader;
}): SecretReader {
  return {
    async get(name) {
      if (!NAME.test(name)) throw missingSecret(name);
      const key = secretFileKey(o.file, o.keyMaterial);
      const id = key ? await o.systemUuid().catch(() => null) : null;
      const value =
        key && id && SYSTEM.test(id) ? readSecretFileEntry(o.file, key, `${id}/${o.env}/${name}`) : null;
      if (value) return value;
      if (o.fallback) return o.fallback.get(name);
      throw missingSecret(name);
    },
  };
}
