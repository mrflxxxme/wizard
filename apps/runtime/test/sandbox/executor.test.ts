// M2 executor protocol without workerd (security/isolation.yaml#M2.runtime): /api/fn → WorkerdExecutor → Worker host
// (worker-host.mjs, emulated in a Node process) → ctx.* → SandboxRpc with the call's capability token → DataAccess.
// The isolation guarantees themselves are the CI sandbox job's (workerd.sandbox.test.ts); here: the wiring, tokens
// dying with their call, Spectre gadgets removed by the guest runtime, the wall limit → 504.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerdSandbox, SandboxRpc } from "../../src/index.js";
import { type ExecHarness, type ExecSystem, type ExtraFunction, execHarness } from "../exec-helpers.js";
import { login, request, seedRow, userIdOf } from "../helpers.js";
import { KEY, startEmulatedWorker, startRpcServer } from "./helpers.js";

const ALL = ["visitor", "participant", "speaker", "partner", "moderator", "volunteer", "organizer"];

const EXTRA: ExtraFunction[] = [
  {
    name: "gadgets",
    kind: "query",
    roles: ALL,
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async () => ({
  sab: typeof globalThis.SharedArrayBuffer,
  atomics: typeof globalThis.Atomics,
  wasm: typeof globalThis.WebAssembly,
  fetch: typeof globalThis.fetch,
  ws: typeof globalThis.WebSocket,
}) });`,
  },
  {
    name: "seen",
    kind: "query",
    roles: ALL,
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async (ctx) => ({
  db: (await ctx.db.ticket.list({ limit: 100 })).length,
  system: (await ctx.systemDb.ticket.list({ limit: 100 })).length,
}) });`,
  },
  {
    name: "addStream",
    kind: "mutation",
    roles: ["organizer"],
    source: `import { mutation, v } from "@wizard/sdk";
export default mutation({ args: { name: v.string({ max: 50 }) }, handler: async (ctx, a) => ctx.db.stream.insert({ name: a.name, capacity: 3 }) });`,
  },
  {
    name: "spin",
    kind: "query",
    roles: ALL,
    source: `import { query } from "@wizard/sdk";
export default query({ args: {}, handler: async () => { for (;;) {} } });`,
  },
];

let h: ExecHarness;
let sys: ExecSystem;
let rpc: SandboxRpc;
let rpcServer: Awaited<ReturnType<typeof startRpcServer>>;
let worker: Awaited<ReturnType<typeof startEmulatedWorker>>;
const endpoints = new Map<string, string>();
const timeouts: string[] = [];

beforeAll(async () => {
  rpc = new SandboxRpc({ key: KEY });
  rpcServer = await startRpcServer(rpc);
  h = await execHarness(false, {
    sandbox: createWorkerdSandbox({
      rpc,
      endpointOf: (id, env) => endpoints.get(`${id}:${env}`) ?? null,
      onTimeout: (id) => timeouts.push(id),
    }),
  });
  sys = await h.fnSystem("emu", EXTRA);
  worker = await startEmulatedWorker({
    functionsPath: join(sys.artifactDir, "server", "functions.mjs"),
    rpcPort: rpcServer.port,
    systemId: sys.key,
    env: "draft",
    entities: sys.spec.entities.map((e) => e.name),
  });
  endpoints.set(`${sys.key}:draft`, worker.endpoint);
}, 60_000);

afterAll(async () => {
  worker?.kill();
  await rpcServer?.close();
  await h?.close();
});

async function call(name: string, args: unknown, role: string) {
  const cookie = await login(h.rt, sys.host, role);
  const res = await h.rt.fetch(request("POST", sys.host, `/api/fn/${name}`, { cookie, body: { args } }));
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  return { status: res.status, body: (await res.json()) as any };
}

describe("M2 executor over the runtime RPC (emulated Worker host)", () => {
  it("functions are enabled without WIZARD_UNSAFE_LOCAL_EXEC when a sandbox is configured", async () => {
    expect(h.rt.env.unsafeLocalExec).toBe(false);
    const r = await call("addStream", { name: "Песочница" }, "organizer");
    expect(r.status).toBe(200);
    const rows = await h.sql.unsafe(`select name from "${sys.schema}"."stream" where name = 'Песочница'`);
    expect(rows).toHaveLength(1);
  });

  it("ctx.db applies the caller's rights and ctx.systemDb the system role, both through RPC", async () => {
    await login(h.rt, sys.host, "participant");
    const me = await userIdOf(h.sql, sys.schema, "participant");
    await seedRow(h.sql, sys.schema, sys.spec, "ticket", { holder_user: me });
    await seedRow(h.sql, sys.schema, sys.spec, "ticket", {});
    const all = Number((await h.sql.unsafe(`select count(*)::int as n from "${sys.schema}"."ticket"`))[0]?.n);
    const own = Number(
      (
        await h.sql.unsafe(`select count(*)::int as n from "${sys.schema}"."ticket" where holder_user = $1`, [
          me,
        ])
      )[0]?.n,
    );
    const r = await call("seen", {}, "participant");
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({ db: own, system: all });
    expect(all).toBeGreaterThan(own);
    expect(own).toBeGreaterThan(0);
  });

  it("every token is revoked when its call ends (no call left open)", async () => {
    await call("seen", {}, "participant");
    expect(rpc.size).toBe(0);
  });

  it("SharedArrayBuffer, Atomics, WebAssembly and ambient network APIs are absent for system code (L3-23)", async () => {
    const r = await call("gadgets", {}, "participant");
    expect(r.status).toBe(200);
    expect(r.body.result).toEqual({
      sab: "undefined",
      atomics: "undefined",
      wasm: "undefined",
      fetch: "undefined",
      ws: "undefined",
    });
  });

  it("a call past its wall limit → 504 TIMEOUT, the pod is reported for restart", async () => {
    const r = await call("spin", {}, "participant");
    expect(r.status).toBe(504);
    expect(r.body.error.code).toBe("TIMEOUT");
    expect(timeouts).toContain(sys.key);
    expect(rpc.size).toBe(0);
  }, 30_000);
});
