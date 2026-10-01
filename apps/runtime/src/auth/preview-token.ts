// Preview-login tokens (runtime.yaml#auth.preview_login_M2, platform/api.yaml#getPreviewUrl, L3-11): platform-api
// signs {systemId, env: draft, role, revision, platformUserId, exp ≤ 15 min, nonce} with WIZARD_PREVIEW_SECRET; the
// runtime verifies it on GET /_wizard/preview-login and burns the nonce (_w_preview_nonces), so a token works once.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface PreviewClaims {
  /** systems.schema_key (RegistryEntry.systemId). */
  systemId: string;
  env: "draft";
  /** Role of the system the preview logs in as. */
  role: string;
  /** Draft revision shown in the preview. */
  revision: number;
  /** Platform user that asked for the preview (audit). */
  platformUserId: string;
  /** Expiry, ms since epoch; at most PREVIEW_TOKEN_TTL_MS ahead of the time of the check. */
  exp: number;
  /** 128-bit random value, base64url; one-time. */
  nonce: string;
}

export type PreviewCheck =
  | { ok: true; claims: PreviewClaims }
  | { ok: false; reason: "malformed" | "signature" | "expired" | "too_long" };

/** Longest allowed lifetime of a preview token (15 min). */
export const PREVIEW_TOKEN_TTL_MS = 15 * 60_000;
/** Minimum length of WIZARD_PREVIEW_SECRET in bytes (256 bits). */
export const PREVIEW_SECRET_MIN_BYTES = 32;

const VERSION = "p1";
const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9_]{0,62}$/;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const USER_RE = /^[A-Za-z0-9-]{1,64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22,64}$/;
const KEYS = ["systemId", "env", "role", "revision", "platformUserId", "exp", "nonce"] as const;

function key(secret: string | Uint8Array): Buffer {
  const k = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (k.byteLength < PREVIEW_SECRET_MIN_BYTES) throw new Error("preview secret must be at least 32 bytes");
  return k;
}

function mac(k: Buffer, body: string): Buffer {
  // Domain separation: the same bytes as another HMAC key never yield a valid preview token.
  return createHmac("sha256", k).update(`wizard-preview.${VERSION}.${body}`).digest();
}

function valid(c: unknown): c is PreviewClaims {
  if (typeof c !== "object" || c === null || Array.isArray(c)) return false;
  const x = c as Record<string, unknown>;
  return (
    Object.keys(x).length === KEYS.length &&
    KEYS.every((k) => Object.hasOwn(x, k)) &&
    typeof x.systemId === "string" &&
    SYSTEM_ID_RE.test(x.systemId) &&
    x.env === "draft" &&
    typeof x.role === "string" &&
    ROLE_RE.test(x.role) &&
    typeof x.revision === "number" &&
    Number.isSafeInteger(x.revision) &&
    x.revision >= 0 &&
    typeof x.platformUserId === "string" &&
    USER_RE.test(x.platformUserId) &&
    typeof x.exp === "number" &&
    Number.isSafeInteger(x.exp) &&
    typeof x.nonce === "string" &&
    NONCE_RE.test(x.nonce)
  );
}

/** Fresh one-time nonce (128 bits, base64url). */
export function newPreviewNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** `p1.<claims base64url>.<hmac base64url>`; throws on a short secret or malformed claims. */
export function issuePreviewToken(secret: string | Uint8Array, claims: PreviewClaims): string {
  const k = key(secret);
  if (!valid(claims)) throw new Error("invalid preview claims");
  const ordered = Object.fromEntries(KEYS.map((n) => [n, claims[n]]));
  const body = Buffer.from(JSON.stringify(ordered)).toString("base64url");
  return `${VERSION}.${body}.${mac(k, body).toString("base64url")}`;
}

/**
 * Format, signature (constant time), env = draft, exp in (now, now + 15 min]. A token whose exp lies further ahead
 * is refused even with a valid signature (a leaked secret cannot mint long-lived links unnoticed by this check).
 */
export function verifyPreviewToken(
  secret: string | Uint8Array,
  token: string,
  now: number = Date.now(),
): PreviewCheck {
  const k = key(secret);
  if (typeof token !== "string" || token.length > 1024) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, body, sig] = parts as [string, string, string];
  const given = Buffer.from(sig, "base64url");
  const expected = mac(k, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "signature" };
  }
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!valid(claims)) return { ok: false, reason: "malformed" };
  if (claims.exp <= now) return { ok: false, reason: "expired" };
  if (claims.exp > now + PREVIEW_TOKEN_TTL_MS) return { ok: false, reason: "too_long" };
  return { ok: true, claims };
}
