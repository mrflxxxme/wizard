// authorize() of the egress-proxy deployment (L3-24): the capability token from Proxy-Authorization is checked by the
// runtime on its internal port (/_wizard/internal/egress-authorize), so the HMAC key never leaves the runtime and a
// token of a finished call is refused. Verdicts are cached per token until its exp (at most maxCacheMs).
import type { EgressPolicy, EgressProxyOptions } from "./egress.js";
import { GRANT_MAX_LENGTH } from "./egress-grants.js";

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

export function remoteCapabilityAuthorizer(o: RemoteAuthorizerOptions): EgressProxyOptions["authorize"] {
  const f = o.fetch ?? fetch;
  const clock = o.clock ?? Date.now;
  const cache = new Map<string, { policy: EgressPolicy; until: number }>();
  const url = new URL("/_wizard/internal/egress-authorize", o.runtimeInternalUrl).toString();

  return async (header) => {
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice(7).trim();
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
    const policy: EgressPolicy = {
      https: new Set(body.https),
      smtp: new Set(body.smtp),
      ...(typeof body.label === "string" ? { label: body.label } : {}),
    };
    const until = Math.min(body.exp, now + (o.maxCacheMs ?? 30_000));
    if (until > now) cache.set(token, { policy, until });
    return policy;
  };
}
