// Egress-proxy grants of runtime-made requests (M2-52): ctx.http.fetch runs in the runtime on behalf of a function
// call, so the CONNECT carries a grant the runtime issued for that call — short-lived, bound to the system, the host and
// the call. The grant is self-verifying (HMAC-SHA256 under a key every runtime replica derives from the same secret,
// like sandbox capability tokens): the proxy asks /_wizard/internal/egress-authorize of any replica behind the
// internal Service, and that replica checks it without shared state. Per-call limits stay in the process that runs
// the call (egress-fetch.ts).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { CAPABILITY_KEY_BYTES } from "./capability.js";

export interface EgressGrant {
  systemId: string;
  env: "draft" | "prod";
  https: readonly string[];
  /** Random id of the function call the grant was issued for. */
  callId: string;
  /** ms since epoch */
  exp: number;
}

export const GRANT_PREFIX = "g2.";
/** Upper bound of a grant token (a few hosts of ≤ 253 chars). */
export const GRANT_MAX_LENGTH = 4096;
const MAX_HOSTS = 16;
const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9_]{0,62}$/;
const CALL_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const HOST_RE = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Grant key shared by all runtime replicas: HMAC-SHA256 of a fixed label under WIZARD_SANDBOX_KEY, else under
 * WIZARD_INTERNAL_TOKEN (the proxy cannot reach egress-authorize without it anyway); null when neither is set.
 */
export function egressGrantKey(env: Env): Uint8Array | null {
  const hex = env.WIZARD_SANDBOX_KEY?.trim();
  const secret = hex && /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : env.WIZARD_INTERNAL_TOKEN;
  if (!secret || secret.length < 16) return null;
  return new Uint8Array(createHmac("sha256", secret).update("wizard-egress-grant-v1").digest());
}

function valid(g: unknown): g is EgressGrant {
  if (typeof g !== "object" || g === null) return false;
  const x = g as Record<string, unknown>;
  return (
    typeof x.systemId === "string" &&
    SYSTEM_ID_RE.test(x.systemId) &&
    (x.env === "draft" || x.env === "prod") &&
    Array.isArray(x.https) &&
    x.https.length <= MAX_HOSTS &&
    x.https.every((h) => typeof h === "string" && h.length <= 253 && HOST_RE.test(h)) &&
    typeof x.callId === "string" &&
    CALL_ID_RE.test(x.callId) &&
    typeof x.exp === "number" &&
    Number.isSafeInteger(x.exp) &&
    Object.keys(x).length === 5
  );
}

export class EgressGrants {
  private readonly key: Uint8Array;
  /**
   * `key` — egressGrantKey() of the deployment (every replica the same); without one a random key works only inside
   * this process (local runs, tests).
   */
  constructor(
    key: Uint8Array | null = null,
    private readonly clock: () => number = Date.now,
  ) {
    this.key = key ?? new Uint8Array(randomBytes(CAPABILITY_KEY_BYTES));
    if (this.key.byteLength < CAPABILITY_KEY_BYTES)
      throw new Error("egress grant key must be at least 32 bytes");
  }

  private mac(body: string): Buffer {
    return createHmac("sha256", this.key).update(`${GRANT_PREFIX}${body}`).digest();
  }

  /** A token for `https` hosts of one system and one call, valid `ttlMs` (the call's limit). */
  issue(g: Omit<EgressGrant, "exp" | "callId"> & { callId?: string }, ttlMs: number): string {
    const grant: EgressGrant = {
      systemId: g.systemId,
      env: g.env,
      https: [...g.https].map((h) => h.toLowerCase()),
      callId: g.callId ?? randomBytes(16).toString("base64url"),
      exp: this.clock() + Math.max(1, Math.floor(ttlMs)),
    };
    if (!valid(grant)) throw new Error("invalid egress grant");
    const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return `${GRANT_PREFIX}${body}.${this.mac(body).toString("base64url")}`;
  }

  /** The grant of `token` (signature checked in constant time, not expired), or null. */
  open(token: string): EgressGrant | null {
    if (typeof token !== "string" || token.length > GRANT_MAX_LENGTH || !token.startsWith(GRANT_PREFIX))
      return null;
    const parts = token.slice(GRANT_PREFIX.length).split(".");
    if (parts.length !== 2) return null;
    const [body, sig] = parts as [string, string];
    const given = Buffer.from(sig, "base64url");
    const expected = this.mac(body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let g: unknown;
    try {
      g = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    if (!valid(g) || g.exp <= this.clock()) return null;
    return g;
  }
}
