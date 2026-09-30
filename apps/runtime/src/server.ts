// Node HTTP server for the runtime (platform/deploy.yaml#local: 127.0.0.1:4100).
import { serve } from "@hono/node-server";
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
  assertStartupAllowed({ ...readEnv(), ...o.env }, hostname);
  const runtime = createRuntimeApp(o);
  const server = serve({
    fetch: (req: Request, env: { incoming?: { socket?: { remoteAddress?: string } } }) => {
      rememberClientIp(req, env?.incoming?.socket?.remoteAddress);
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
