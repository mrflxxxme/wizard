// Runtime side of ctx.http (M2-52): one HttpClient per function call — the function's declared hosts, its secrets,
// the per-system minute limit, the proxy grant of the call and the _w_egress_log journal (sandbox/egress-fetch.ts).
import { quoteIdent } from "@wizard/appspec";
import type { Resolver, SecretReader } from "@wizard/connectors";
import { SYSTEM_SUBJECT } from "../data/access.js";
import type { LoadedSystem } from "../system.js";
import {
  DEFAULT_EGRESS_LIMITS,
  directTransport,
  type EgressLimits,
  type EgressLogEntry,
  type EgressResponse,
  type EgressTransport,
  egressHttpClient,
  MinuteWindows,
  proxyTransport,
} from "./egress-fetch.js";
import { EgressGrants } from "./egress-grants.js";

export interface HttpEgressOptions {
  /** WIZARD_EGRESS_PROXY_URL (cloud): every request goes through the egress proxy. */
  proxyUrl?: string | null;
  /** Without a proxy: direct requests after the address check (local runs, tests). Default: allowed outside the cloud. */
  direct?: { resolve?: Resolver; ca?: string; allowPrivate?: boolean; port?: number } | false;
  /** Extra CA for TLS through the proxy (rehearsal stands). */
  ca?: string;
  platformDomains: readonly string[];
  limits?: Partial<EgressLimits>;
  clock?: () => number;
}

export interface FnHttpClient {
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<EgressResponse>;
}

export interface EgressService {
  readonly grants: EgressGrants;
  /** Client of one call of function `fn` (null — ctx.http stays EGRESS_DISABLED). */
  client(sys: LoadedSystem, fn: string, secrets: SecretReader): FnHttpClient | null;
}

/** _w_egress_log row (best effort: an old schema without the table is skipped). */
async function journal(sys: LoadedSystem, e: EgressLogEntry): Promise<void> {
  try {
    await sys.data.transaction("default", SYSTEM_SUBJECT, async (d) => {
      await d.sql.unsafe(
        `insert into ${quoteIdent(sys.schema)}."_w_egress_log"
           (fn, host, method, status, outcome, bytes_out, bytes_in, duration_ms)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          e.fn.slice(0, 64),
          e.host.slice(0, 253),
          e.method,
          e.status,
          e.outcome,
          e.bytesOut,
          e.bytesIn,
          Math.min(e.durationMs, 2_147_483_647),
        ],
      );
    });
  } catch {
    // never fails the function call
  }
}

export function createEgressService(o: HttpEgressOptions): EgressService {
  const clock = o.clock ?? Date.now;
  const grants = new EgressGrants(clock);
  const minute = new MinuteWindows(clock);
  const limits: EgressLimits = { ...DEFAULT_EGRESS_LIMITS, ...o.limits };
  return {
    grants,
    client(sys, fn, secrets) {
      const def = (sys.spec.functions ?? []).find((f) => f.name === fn);
      const hosts = def?.egress ?? [];
      let transport: EgressTransport;
      if (o.proxyUrl) {
        const { systemId, env } = sys.entry;
        // One grant per call: the function's hosts only, alive for the call's time budget.
        let token: string | null = null;
        transport = proxyTransport({
          proxyUrl: o.proxyUrl,
          grant: () => {
            token ??= grants.issue({ systemId, env, https: hosts }, 60_000);
            return token;
          },
          ...(o.ca ? { ca: o.ca } : {}),
        });
      } else if (o.direct !== false) {
        transport = directTransport(o.direct ?? {});
      } else {
        return null;
      }
      return egressHttpClient({
        fn,
        hosts,
        platformDomains: o.platformDomains,
        secretNames: (def?.secretRefs ?? []).map((r) => r.slice("secret://".length)),
        secrets,
        transport,
        limits,
        minuteGate: () => minute.take(`${sys.entry.systemId}:${sys.entry.env}`, limits.requestsPerMinute),
        log: (e) => journal(sys, e),
      });
    },
  };
}
