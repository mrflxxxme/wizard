// Runs src/sandbox/worker-host.mjs in a plain Node process instead of workerd, for local protocol tests of the M2
// executor (WorkerdExecutor ↔ Worker ↔ SandboxRpc). NOT a sandbox: the isolation itself is tested only by the CI
// sandbox job (*.sandbox.test.ts with real workerd in gVisor). argv: <functions.mjs> <rpcPort> <systemId> <env> <entities>
import { readFileSync } from "node:fs";
import http from "node:http";

// Node's fetch/Request load undici, which instantiates its WebAssembly parser lazily: finish that with one real
// request before the guest runtime removes WebAssembly from the global object (as it does inside workerd).
{
  const warm = http.createServer((_q, s) => s.end("ok"));
  await new Promise((r) => warm.listen(0, "127.0.0.1", r));
  await (await fetch(`http://127.0.0.1:${warm.address().port}/`)).text();
  warm.closeAllConnections();
  warm.close();
}

const [bundlePath, rpcPort, systemId, systemEnv, entities] = process.argv.slice(2);
const hostUrl = new URL("../../src/sandbox/worker-host.mjs", import.meta.url).href;
const sdkSource = `import { guest } from ${JSON.stringify(hostUrl)};
export const { PACKAGE, WizardError, v, query, mutation, action } = guest.sdk;`;
const sdkUrl = `data:text/javascript,${encodeURIComponent(sdkSource)}`;
const source = readFileSync(bundlePath, "utf8").replaceAll(/(["'])@wizard\/sdk\1/g, JSON.stringify(sdkUrl));
const ns = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const { createWorkerHost } = await import(hostUrl);
const worker = createWorkerHost(ns);

/** RUNTIME_RPC service binding: every request goes to the runtime RPC listener, whatever the URL host. */
function rpcFetch(url, init) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(rpcPort),
        path: u.pathname,
        method: init.method,
        headers: init.headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(text) });
        });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

const env = {
  SYSTEM_ID: systemId,
  SYSTEM_ENV: systemEnv,
  ENTITIES: entities,
  RUNTIME_RPC: { fetch: rpcFetch },
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://worker${req.url}`, {
      method: req.method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    const r = await worker.fetch(request, env);
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "text/plain" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
