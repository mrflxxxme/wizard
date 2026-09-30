// QR token format, signing, verification and key rotation: specs/connectors/qr.yaml#token.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Env } from "./types.js";

export const QR_PREFIX = "WZ1";
export const QR_GRACE_MS = 30 * 24 * 60 * 60_000;
export const QR_KEY_MIN_BYTES = 32;
const PAYLOAD_RE = /^WZ1\.([1-9][0-9]{0,5})\.([A-Z2-7]{26})\.([A-Za-z0-9_-]{16})$/;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface QrKey {
  kid: number;
  key: Uint8Array;
  /** When this key stopped being active (ISO). Verification accepts it for 30 days after. */
  retiredAt?: string;
  /** Leaked key: rejected immediately. */
  revoked?: boolean;
}

export interface QrKeyring {
  activeKid: number;
  keys: QrKey[];
}

export interface QrScope {
  systemId: string;
  env: Env;
}

export type QrVerifyResult = { ok: true; kid: number; rand: string } | { ok: false; reason: "bad_signature" };

/** RFC 4648 base32, upper case, no padding. */
export function base32(buf: Uint8Array): string {
  let out = "";
  let value = 0;
  let bits = 0;
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function sign(key: Uint8Array, scope: QrScope, rand: string): string {
  return createHmac("sha256", key)
    .update(`WZ1|${scope.systemId}|${scope.env}|${rand}`)
    .digest("base64url")
    .slice(0, 16);
}

export function newQrRand(): string {
  return base32(randomBytes(16));
}

export function generateQrKey(): Uint8Array {
  return new Uint8Array(randomBytes(QR_KEY_MIN_BYTES));
}

function activeKey(ring: QrKeyring): QrKey {
  const k = ring.keys.find((x) => x.kid === ring.activeKid);
  if (!k || k.revoked) throw new Error("QR keyring has no usable active key");
  return k;
}

/** New payload signed with the active key; pass `rand` to re-sign an existing token under a new kid. */
export function signQrToken(ring: QrKeyring, scope: QrScope, rand: string = newQrRand()): string {
  if (!/^[A-Z2-7]{26}$/.test(rand)) throw new Error("rand must be 26 base32 characters");
  const k = activeKey(ring);
  return `${QR_PREFIX}.${k.kid}.${rand}.${sign(k.key, scope, rand)}`;
}

export function parseQrPayload(payload: string): { kid: number; rand: string; sig: string } | null {
  const m = PAYLOAD_RE.exec(payload);
  if (!m) return null;
  return { kid: Number(m[1]), rand: m[2] as string, sig: m[3] as string };
}

function keyUsable(ring: QrKeyring, k: QrKey, now: Date): boolean {
  if (k.revoked) return false;
  if (k.kid === ring.activeKid) return true;
  if (!k.retiredAt) return false;
  return now.getTime() - Date.parse(k.retiredAt) <= QR_GRACE_MS;
}

/** Constant-time signature check; any malformed payload, unknown/expired/revoked kid → bad_signature. */
export function verifyQrToken(
  payload: string,
  ring: QrKeyring,
  scope: QrScope,
  now: Date = new Date(),
): QrVerifyResult {
  const parsed = typeof payload === "string" ? parseQrPayload(payload) : null;
  const k = parsed && ring.keys.find((x) => x.kid === parsed.kid);
  // Always run one HMAC so timing does not reveal which step failed.
  const key = k?.key ?? ring.keys[0]?.key ?? new Uint8Array(QR_KEY_MIN_BYTES);
  const expected = Buffer.from(sign(key, scope, parsed?.rand ?? ""));
  const given = Buffer.from(parsed?.sig ?? "0".repeat(16));
  const sigOk = expected.length === given.length && timingSafeEqual(expected, given);
  if (!parsed || !k || !sigOk || !keyUsable(ring, k, now)) return { ok: false, reason: "bad_signature" };
  return { ok: true, kid: parsed.kid, rand: parsed.rand };
}

/**
 * Planned rotation: a new active kid, the previous key stays valid for 30 days.
 * `compromised: true` revokes the previous key at once. Keys past the grace period are dropped.
 */
export function rotateQrKeyring(
  ring: QrKeyring,
  opts: { now?: Date; newKey?: Uint8Array; compromised?: boolean } = {},
): QrKeyring {
  const now = opts.now ?? new Date();
  const kid = Math.max(0, ...ring.keys.map((k) => k.kid)) + 1;
  const keys = ring.keys
    .map((k): QrKey => {
      if (k.kid !== ring.activeKid) return k;
      const retired: QrKey = { ...k, retiredAt: now.toISOString() };
      if (opts.compromised) retired.revoked = true;
      return retired;
    })
    .filter((k) => keyUsable(ring, k, now));
  return { activeKid: kid, keys: [...keys, { kid, key: opts.newKey ?? generateQrKey() }] };
}

export function newQrKeyring(key: Uint8Array = generateQrKey()): QrKeyring {
  return { activeKid: 1, keys: [{ kid: 1, key }] };
}

/**
 * Value of secret://qr_signing_key: either one base64url key (kid 1) or JSON
 * `{"activeKid":2,"keys":[{"kid":2,"key":"<b64url>"},{"kid":1,"key":"…","retiredAt":"…"}]}`.
 */
export function parseQrKeyring(secret: string): QrKeyring {
  const decode = (s: string) => {
    const key = new Uint8Array(Buffer.from(s, "base64url"));
    if (key.length < QR_KEY_MIN_BYTES) throw new Error("QR signing key must be at least 32 bytes");
    return key;
  };
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return newQrKeyring(decode(trimmed));
  const raw = JSON.parse(trimmed) as {
    activeKid: number;
    keys: { kid: number; key: string; retiredAt?: string; revoked?: boolean }[];
  };
  const ring: QrKeyring = {
    activeKid: raw.activeKid,
    keys: raw.keys.map((k) => {
      const out: QrKey = { kid: k.kid, key: decode(k.key) };
      if (k.retiredAt) out.retiredAt = k.retiredAt;
      if (k.revoked) out.revoked = true;
      return out;
    }),
  };
  activeKey(ring);
  return ring;
}

export function serializeQrKeyring(ring: QrKeyring): string {
  return JSON.stringify({
    activeKid: ring.activeKid,
    keys: ring.keys.map((k) => ({ ...k, key: Buffer.from(k.key).toString("base64url") })),
  });
}

/** h = base64url(sha256(rand))[0:22] — revocation list and offline package key (qr.yaml#offline.package). */
export function qrTokenHash(rand: string): string {
  return createHash("sha256").update(rand).digest("base64url").slice(0, 22);
}
