// Hashing helpers of accounts: OTP pepper (db.yaml#auth_otps.code_hash, L3-25), session/invite token hashes.
import { createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Without WIZARD_SECRETS_KEY (local only; production refuses to start) keys are random per process.
const EPHEMERAL = randomBytes(32);

/** HKDF-SHA256 sub-key of WIZARD_SECRETS_KEY for one purpose. */
export function deriveKey(secretsKey: string, label: string): Buffer {
  const ikm = secretsKey ? Buffer.from(secretsKey, "utf8") : EPHEMERAL;
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), `wizard/${label}`, 32));
}

/**
 * Key material of data shared by platform-api and apps/worker (import files, export archives): WIZARD_SECRETS_KEY, or —
 * local only, without it — a random key file `<dir>/.key` (0600), so both processes decrypt the same files (M1-01).
 */
export function sharedKeyMaterial(secretsKey: string, dir: string): string {
  if (secretsKey) return secretsKey;
  const f = join(dir, ".key");
  if (!existsSync(f)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(f, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
  }
  return readFileSync(f, "utf8");
}

export const hmacHex = (key: Buffer, data: string): string =>
  createHmac("sha256", key).update(data, "utf8").digest("hex");

export const sha256Hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");

/** Random URL-safe token (32 bytes → 43 chars). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** Six-digit OTP code. */
export const otpCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
