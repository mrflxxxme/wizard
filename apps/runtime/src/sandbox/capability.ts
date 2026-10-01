// Capability tokens of the sandbox → runtime RPC (security/isolation.yaml#M2.runtime, L3-23). The runtime issues one
// per incoming function call: {systemId, env, requestId, exp ≤ the call's wall limit}, HMAC-SHA256 with a key only
// the runtime holds. The sandbox pod keeps no long-lived secret: a token is useless after exp or after its call ends.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SandboxEnv = "draft" | "prod";

export interface Capability {
  /** systems.schema_key */
  systemId: string;
  env: SandboxEnv;
  /** Random id of the call the token was issued for. */
  requestId: string;
  /** Expiry, ms since epoch. */
  exp: number;
}

export type CapabilityCheck =
  | { ok: true; cap: Capability }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

const VERSION = "v1";
const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9_]{0,62}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
/** Minimum key length: 256 bits. */
export const CAPABILITY_KEY_BYTES = 32;

function assertKey(key: Uint8Array): void {
  if (key.byteLength < CAPABILITY_KEY_BYTES) throw new Error("capability key must be at least 32 bytes");
}

function mac(key: Uint8Array, body: string): Buffer {
  return createHmac("sha256", key).update(`${VERSION}.${body}`).digest();
}

/** Fresh random request id (128 bits, base64url). */
export function newRequestId(): string {
  return randomBytes(16).toString("base64url");
}

function valid(c: unknown): c is Capability {
  if (typeof c !== "object" || c === null) return false;
  const x = c as Record<string, unknown>;
  return (
    typeof x.systemId === "string" &&
    SYSTEM_ID_RE.test(x.systemId) &&
    (x.env === "draft" || x.env === "prod") &&
    typeof x.requestId === "string" &&
    REQUEST_ID_RE.test(x.requestId) &&
    typeof x.exp === "number" &&
    Number.isSafeInteger(x.exp) &&
    Object.keys(x).length === 4
  );
}

/** `v1.<payload base64url>.<hmac base64url>`. */
export function issueCapability(key: Uint8Array, cap: Capability): string {
  assertKey(key);
  if (!valid(cap)) throw new Error("invalid capability");
  const body = Buffer.from(
    JSON.stringify({ systemId: cap.systemId, env: cap.env, requestId: cap.requestId, exp: cap.exp }),
  ).toString("base64url");
  return `${VERSION}.${body}.${mac(key, body).toString("base64url")}`;
}

/** Checks format, signature (constant time) and expiry; exp ≤ now is expired. */
export function verifyCapability(key: Uint8Array, token: string, now: number = Date.now()): CapabilityCheck {
  assertKey(key);
  if (typeof token !== "string" || token.length > 512) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, body, sig] = parts as [string, string, string];
  const given = Buffer.from(sig, "base64url");
  const expected = mac(key, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature" };
  }
  let cap: unknown;
  try {
    cap = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!valid(cap)) return { ok: false, reason: "malformed" };
  if (cap.exp <= now) return { ok: false, reason: "expired" };
  return { ok: true, cap };
}
