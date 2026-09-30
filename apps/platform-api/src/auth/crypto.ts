// Hashing helpers of accounts: OTP pepper (db.yaml#auth_otps.code_hash, L3-25), session/invite token hashes.
import { createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Without WIZARD_SECRETS_KEY (local only; production refuses to start) keys are random per process.
const EPHEMERAL = randomBytes(32);

/** HKDF-SHA256 sub-key of WIZARD_SECRETS_KEY for one purpose. */
export function deriveKey(secretsKey: string, label: string): Buffer {
  const ikm = secretsKey ? Buffer.from(secretsKey, "utf8") : EPHEMERAL;
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), `wizard/${label}`, 32));
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
