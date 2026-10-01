// Node HTTP server for the runtime (platform/deploy.yaml#local: 127.0.0.1:4100).
import { serve } from "@hono/node-server";
import { effectiveClientIp } from "@wizard/connectors";
import { createRuntimeApp, type RuntimeApp, type RuntimeAppOptions } from "./app.js";
import { rememberClientIp } from "./auth/client-ip.js";
import { assertStartupAllowed, readEnv } from "./env.js";

export interface StartOptions extends RuntimeAppOptions {
  port?: number;
  /** Bind address; default 127.0.0.1. Dev-only flags refuse non-loopback binds (L3-11). */
  hostname?: string;
}

export async function startRuntime(
  o: StartOptions,
): Promise<{ runtime: RuntimeApp; close(): Promise<void> }> {
  const hostname = o.hostname ?? "127.0.0.1";
  const env = { ...readEnv(), ...o.env };
  assertStartupAllowed(env, hostname);
  const trusted = env.trustedProxies ?? [];
  const runtime = createRuntimeApp(o);
  const server = serve({
    fetch: (req: Request, node: { incoming?: { socket?: { remoteAddress?: string } } }) => {
      const peer = node?.incoming?.socket?.remoteAddress;
      rememberClientIp(req, effectiveClientIp(peer, req.headers.get("x-forwarded-for"), trusted));
      return runtime.fetch(req);
    },
    port: o.port ?? 4100,
    hostname,
  });
  return {
    runtime,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
