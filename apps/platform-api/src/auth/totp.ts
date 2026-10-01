// Staff MFA (api.yaml#info.x-auth.M2, compliance.yaml#platform.security_org, D21_beta_moderation): TOTP of RFC 6238
// (HMAC-SHA1, 30 s step, 6 digits — what authenticator apps expect) on node:crypto, base32 secrets of RFC 4648 and
// one-time recovery codes kept only as HMAC hashes.
import { createHmac, randomBytes, randomInt } from "node:crypto";
import { hmacHex, safeEqualHex } from "./crypto.js";

export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;
/** Accepted clock drift: one step either side. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODES = 10;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding. */
export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 → bytes; spaces, dashes and padding are ignored, case-insensitive. Invalid characters throw. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** New 160-bit secret (RFC 4226 recommends ≥ 128 bits; 160 = the HMAC-SHA1 block). */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** HOTP of RFC 4226 (dynamic truncation) for a counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const off = (mac[mac.length - 1] as number) & 0x0f;
  const bin =
    (((mac[off] as number) & 0x7f) << 24) |
    ((mac[off + 1] as number) << 16) |
    ((mac[off + 2] as number) << 8) |
    (mac[off + 3] as number);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (at: Date | number = Date.now()): number =>
  Math.floor((typeof at === "number" ? at : at.getTime()) / 1000 / TOTP_STEP_SEC);

/** The TOTP code of a base32 secret at a moment (tests, e2e). */
export const totpCode = (secretB32: string, at: Date | number = Date.now()): string =>
  hotp(base32Decode(secretB32), totpStep(at));

/**
 * Checks a code within ±TOTP_WINDOW steps; returns the matched step, or null. A step ≤ `lastStep` is refused (each
 * code works once — replay guard; the caller stores the returned step).
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  o: { at?: Date | number; lastStep?: number | null } = {},
): number | null {
  if (!/^[0-9]{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(o.at ?? Date.now());
  let found: number | null = null;
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = now + d;
    // Constant-time compare of every candidate (no early exit on a match).
    const a = Buffer.from(hotp(key, step));
    const b = Buffer.from(code);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
    if (diff === 0 && found === null) found = step;
  }
  if (found === null) return null;
  if (o.lastStep !== null && o.lastStep !== undefined && found <= o.lastStep) return null;
  return found;
}

/** otpauth:// URI for authenticator apps (Key Uri Format). */
export function otpauthUri(secretB32: string, account: string, issuer = "Wizard"): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${q}`;
}

const RC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Recovery codes «xxxxx-xxxxx» (≈ 49 bits each), shown to staff once. */
export function newRecoveryCodes(n = RECOVERY_CODES): string[] {
  const one = () => Array.from({ length: 5 }, () => RC_ALPHABET[randomInt(0, RC_ALPHABET.length)]).join("");
  return Array.from({ length: n }, () => `${one()}-${one()}`);
}

const normalizeRecovery = (code: string): string => code.trim().toLowerCase().replace(/[\s-]/g, "");

/** HMAC of a recovery code bound to the user (a leaked table does not reveal or transfer codes). */
export const recoveryHash = (key: Buffer, userId: string, code: string): string =>
  hmacHex(key, `${userId}\u0000${normalizeRecovery(code)}`);

/** Index of the matching hash, or -1. */
export function matchRecovery(key: Buffer, userId: string, code: string, hashes: readonly string[]): number {
  const h = recoveryHash(key, userId, code);
  let found = -1;
  hashes.forEach((x, i) => {
    if (found < 0 && safeEqualHex(h, x)) found = i;
  });
  return found;
}
