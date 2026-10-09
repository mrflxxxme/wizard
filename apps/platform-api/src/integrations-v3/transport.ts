// The platform's request of a key check (V3-20; D37, D77 (15)) goes out through the same egress client as a system
// function's ctx.http.fetch (@wizard/runtime egressHttpClient): https on 443 only, only the contract's hosts, no
// redirects, addresses checked after resolution (no internal ranges), size and time limits, the key resolved from
// secret://name at the last moment and never returned. In the cloud — through the egress proxy with a runtime grant;
// without a proxy outside the cloud — directly; in the cloud without a proxy — no request (EGRESS_DISABLED).
import type { IntegrationContract, IntegrationTransport } from "@wizard/agents/integrations";
import { platformDomains, type SecretReader } from "@wizard/connectors";
import {
  directTransport,
  EgressGrants,
  EgressRefused,
  type EgressTransport,
  egressGrantKey,
  egressHttpClient,
  newRequestId,
  proxyTransport,
} from "@wizard/runtime";

export interface KeyCheckNet {
  /** Transport of the check (tests: a local TLS upstream); default from the env (keyCheckTransport). */
  transport?: EgressTransport | null;
  platformDomains?: readonly string[];
}

/**
 * Default transport of key checks by the env: WIZARD_EGRESS_PROXY_URL (+ the shared grant key) → the egress proxy;
 * else direct outside the cloud; null in the cloud without a proxy.
 */
export function keyCheckTransport(
  env: NodeJS.ProcessEnv,
  system: { systemKey: string; env: "draft" | "prod" },
  hosts: readonly string[],
): EgressTransport | null {
  const proxyUrl = env.WIZARD_EGRESS_PROXY_URL || null;
  const cloud = env.NODE_ENV === "production" || !!env.KUBERNETES_SERVICE_HOST;
  if (proxyUrl) {
    const key = egressGrantKey(env);
    if (!key) return null;
    const grants = new EgressGrants(key, Date.now);
    const callId = newRequestId();
    const allowed = new Set(hosts);
    return proxyTransport({
      proxyUrl,
      grant: (host) => {
        if (!allowed.has(host)) throw new EgressRefused("proxy_denied");
        return grants.issue({ systemId: system.systemKey, env: system.env, https: [host], callId }, 60_000);
      },
    });
  }
  return cloud ? null : directTransport({});
}

/** IntegrationTransport of a contract over the egress client: hosts = contract.hosts, the contract's key only. */
export function contractTransport(o: {
  contract: IntegrationContract;
  secrets: SecretReader;
  transport: EgressTransport;
  platformDomains?: readonly string[];
}): IntegrationTransport {
  const name = o.contract.auth.secret?.slice("secret://".length);
  const client = egressHttpClient({
    fn: `integration_check:${o.contract.id}`.slice(0, 64),
    hosts: o.contract.hosts,
    platformDomains: o.platformDomains ?? platformDomains(process.env),
    secretNames: name ? [name] : [],
    secrets: o.secrets,
    transport: o.transport,
    limits: { requestsPerCall: 3 },
    minuteGate: () => true,
    log: () => {},
  });
  return async (req) => {
    const r = await client.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    return { status: r.status, contentType: r.contentType, text: await r.text() };
  };
}
