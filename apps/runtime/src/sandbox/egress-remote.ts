// authorize() of the egress-proxy deployment (L3-24): the capability token from Proxy-Authorization is checked by the
// runtime on its internal port (/_wizard/internal/egress-authorize), so the HMAC key never leaves the runtime and a
// token of a finished call is refused. Verdicts are cached per token until its exp (at most maxCacheMs).
// The token comes as `Bearer <token>`, or (V3-32) as the password of `Basic` credentials: package managers in the
// repository sandbox can only send the user:password of their proxy URL, and only a grant (g2.) is accepted so.
import type { EgressPolicy, EgressProxyOptions } from "./egress.js";
import { GRANT_MAX_BYTES, GRANT_MAX_DURATION_MS, GRANT_MAX_LENGTH, GRANT_PREFIX } from "./egress-grants.js";

export interface RemoteAuthorizerOptions {
  /** Base URL of the runtime's internal port, e.g. http://wizard-runtime-internal:4101 */
  runtimeInternalUrl: string;
  /** WIZARD_INTERNAL_TOKEN shared with the runtime. */
  internalToken: string;
  fetch?: typeof fetch;
  clock?: () => number;
  /** Upper bound of a cached verdict (default 30 s); never beyond the token's exp. */
  maxCacheMs?: number;
  timeoutMs?: number;
}

const HOST_LIST = (v: unknown): v is string[] => Array.isArray(v) && v.every((h) => typeof h === "string");
const limit = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined;

/** The token of a Proxy-Authorization header: Bearer <token>, or a grant as the password of Basic credentials. */
export function proxyToken(header: string | undefined): string | null {
  if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
  if (header?.startsWith("Basic ")) {
    const raw = header.slice(6).trim();
    if (raw.length > GRANT_MAX_LENGTH * 2) return null;
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    const password = colon < 0 ? "" : decoded.slice(colon + 1);
    return password.startsWith(GRANT_PREFIX) ? password : null;
  }
  return null;
}

export function remoteCapabilityAuthorizer(o: RemoteAuthorizerOptions): EgressProxyOptions["authorize"] {
  const f = o.fetch ?? fetch;
  const clock = o.clock ?? Date.now;
  const cache = new Map<string, { policy: EgressPolicy; until: number }>();
  const url = new URL("/_wizard/internal/egress-authorize", o.runtimeInternalUrl).toString();

  return async (header) => {
    const token = proxyToken(header);
    if (!token || token.length > GRANT_MAX_LENGTH) return null;
    const now = clock();
    for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
    const hit = cache.get(token);
    if (hit) return hit.policy;
    let res: Response;
    try {
      res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-wizard-internal-token": o.internalToken },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
      });
    } catch {
      return null;
    }
    if (res.status !== 200) return null;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !HOST_LIST(body.https) || !HOST_LIST(body.smtp) || typeof body.exp !== "number") return null;
    const maxBytes = limit(body.maxBytes, 1, GRANT_MAX_BYTES);
    const maxDurationMs = limit(body.maxDurationMs, 1000, GRANT_MAX_DURATION_MS);
    const policy: EgressPolicy = {
      https: new Set(body.https),
      smtp: new Set(body.smtp),
      ...(typeof body.label === "string" ? { label: body.label } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
    };
    const until = Math.min(body.exp, now + (o.maxCacheMs ?? 30_000));
    if (until > now) cache.set(token, { policy, until });
    return policy;
  };
}
