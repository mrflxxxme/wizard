// Node HTTP server for the runtime (platform/deploy.yaml#local: 127.0.0.1:4100).
import { serve } from "@hono/node-server";
import { effectiveClientIp } from "@wizard/connectors";
import { serveMetrics } from "@wizard/pii/metrics";
import { createRuntimeApp, type RuntimeApp, type RuntimeAppOptions } from "./app.js";
import { rememberClientIp } from "./auth/client-ip.js";
import { assertStartupAllowed, readEnv } from "./env.js";
import { instrumentFetch, retentionSystems, retentionTicks, runtimeMetrics } from "./metrics.js";

export interface StartOptions extends RuntimeAppOptions {
  port?: number;
  /** Bind address; default 127.0.0.1. Dev-only flags refuse non-loopback binds (L3-11). */
  hostname?: string;
  /**
   * Internal listener (health details, /_wizard/internal/*, sandbox RPC; runtime.yaml#routing.rules, L3-19): port, or
   * undefined/null — none. Bound to internalHostname (default: hostname); in the cloud only a ClusterIP Service and
   * NetworkPolicy expose it.
   */
  internalPort?: number | null;
  internalHostname?: string;
  /** Period of the retention check (runtime.yaml#workflows.retention; a pass runs once per daily slot); 0 — off. */
  retentionTickMs?: number;
  /**
   * Prometheus /metrics listener (M2-09; WIZARD_METRICS_PORT): port, or undefined/null — none. Only the observability
   * namespace reaches it in the cluster (NetworkPolicy); bound to metricsHostname (default: hostname).
   */
  metricsPort?: number | null;
  metricsHostname?: string;
}

/** Default period of the retention check: a platform request is served within it. */
export const RETENTION_TICK_MS = 10 * 60_000;

export async function startRuntime(
  o: StartOptions,
): Promise<{ runtime: RuntimeApp; metricsPort: number | null; close(): Promise<void> }> {
  const hostname = o.hostname ?? "127.0.0.1";
  const env = { ...readEnv(), ...o.env };
  assertStartupAllowed(env, hostname);
  const trusted = env.trustedProxies ?? [];
  const runtime = createRuntimeApp(o);
  const server = serve({
    fetch: instrumentFetch((req: Request, node: { incoming?: { socket?: { remoteAddress?: string } } }) => {
      const peer = node?.incoming?.socket?.remoteAddress;
      rememberClientIp(req, effectiveClientIp(peer, req.headers.get("x-forwarded-for"), trusted));
      return runtime.fetch(req);
    }),
    port: o.port ?? 4100,
    hostname,
  });
  const internal =
    o.internalPort === undefined || o.internalPort === null
      ? null
      : serve({
          fetch: (req: Request) => runtime.internalFetch(req),
          port: o.internalPort,
          hostname: o.internalHostname ?? hostname,
        });
  const tickMs = o.retentionTickMs ?? RETENTION_TICK_MS;
  let ticking = false;
  const tick =
    tickMs > 0
      ? setInterval(() => {
          if (ticking) return;
          ticking = true;
          runtime
            .retentionTick()
            .then((r) => {
              retentionTicks.inc({ result: "ok" });
              if (r.ran.length > 0) retentionSystems.inc({ result: "ran" }, r.ran.length);
              if (r.failed.length > 0) retentionSystems.inc({ result: "failed" }, r.failed.length);
            })
            .catch((err: unknown) => {
              retentionTicks.inc({ result: "failed" });
              o.log?.({
                ts: new Date().toISOString(),
                level: "error",
                msg: "retention_failed",
                sqlstate: (err as { code?: unknown }).code ?? null,
              });
            })
            .finally(() => {
              ticking = false;
            });
        }, tickMs)
      : undefined;
  tick?.unref();
  const metrics =
    o.metricsPort === undefined || o.metricsPort === null
      ? null
      : await serveMetrics({
          registry: runtimeMetrics,
          port: o.metricsPort,
          hostname: o.metricsHostname ?? hostname,
        });
  return {
    runtime,
    metricsPort: metrics?.port ?? null,
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (tick) clearInterval(tick);
        internal?.close();
        void metrics?.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
