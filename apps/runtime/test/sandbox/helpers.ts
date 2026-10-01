// Shared pieces of the sandbox tests: the runtime RPC listener over node:http and a Worker host either emulated in a
// Node process (local protocol tests) or run by workerd (CI sandbox job only, see workerd.sandbox.test.ts).
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { SandboxRpc } from "../../src/index.js";

export const KEY = new Uint8Array(32).fill(7);

async function toRequest(req: IncomingMessage, base: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const body =
    chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  return new Request(`${base}${req.url}`, { method: req.method, headers, body });
}

export async function listen(
  handler: (r: Request) => Promise<Response>,
): Promise<{ port: number; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const r = await handler(await toRequest(req, "http://127.0.0.1"));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const startRpcServer = (rpc: SandboxRpc) => listen((r) => rpc.fetch(r));

const DRIVER = fileURLToPath(new URL("./emulated-worker.mjs", import.meta.url));

/** worker-host.mjs in a Node child process (no isolation): endpoint for WorkerdExecutor. */
export async function startEmulatedWorker(o: {
  functionsPath: string;
  rpcPort: number;
  systemId: string;
  env: "draft" | "prod";
  entities: readonly string[];
}): Promise<{ endpoint: string; child: ChildProcess; kill(): void }> {
  const child = spawn(
    process.execPath,
    [DRIVER, o.functionsPath, String(o.rpcPort), o.systemId, o.env, o.entities.join(",")],
    { stdio: ["ignore", "pipe", "pipe"], env: {} },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    let err = "";
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
      const nl = out.indexOf("\n");
      if (nl >= 0) resolve((JSON.parse(out.slice(0, nl)) as { port: number }).port);
    });
    child.stderr?.on("data", (b: Buffer) => {
      err += b.toString();
    });
    child.on("exit", (code) => reject(new Error(`emulated worker exited ${code}: ${err.slice(0, 500)}`)));
  });
  return { endpoint: `http://127.0.0.1:${port}`, child, kill: () => child.kill("SIGKILL") };
}
