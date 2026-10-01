// server/functions.mjs of a test system for the CI sandbox job (workerd.sandbox.test.ts), written in the shape
// packages/build emits (named exports + default map, `@wizard/sdk` external). Every function only reports plain
// facts about its own environment (security/isolation.yaml#M2.runtime); nothing here tries to get around a limit.
// The bundle deliberately bypasses G0: the point is to check what the workerd layer alone denies.

/** Functions of PROBE_BUNDLE (all queries: no transaction is opened on the host side). */
export const PROBE_FUNCTIONS = ["facts", "setMarker", "readMarker", "hang"] as const;

export const PROBE_BUNDLE = `import { query } from "@wizard/sdk";

async function settle(p) {
  try {
    await p;
    return "resolved";
  } catch {
    return "rejected";
  }
}

export const facts = query({
  args: {},
  handler: async () => {
    const g = globalThis;
    const out = {
      process: typeof g.process,
      require: typeof g.require,
      module: typeof g.module,
      Buffer: typeof g.Buffer,
      SharedArrayBuffer: typeof g.SharedArrayBuffer,
      Atomics: typeof g.Atomics,
      WebAssembly: typeof g.WebAssembly,
      fetch: typeof g.fetch,
      WebSocket: typeof g.WebSocket,
    };
    try {
      eval("1");
      out.eval = "allowed";
    } catch {
      out.eval = "threw";
    }
    try {
      new Function("return 1");
      out.newFunction = "allowed";
    } catch {
      out.newFunction = "threw";
    }
    out.importNodeFs = await settle(import("node:fs"));
    out.importNodeChildProcess = await settle(import("node:child_process"));
    out.outboundFetch = typeof g.fetch === "function" ? await settle(g.fetch("https://example.com/")) : "absent";
    const d0 = Date.now();
    let acc = 0;
    for (let i = 0; i < 20000000; i++) acc = (acc + i) % 1000003;
    out.clockAdvancedInLoop = Date.now() !== d0;
    out.acc = acc >= 0;
    return out;
  },
});

export const setMarker = query({
  args: {},
  handler: async () => {
    let global = "set";
    let proto = "set";
    try {
      globalThis.__wzMarker = "A";
    } catch {
      global = "refused";
    }
    try {
      Object.defineProperty(Object.prototype, "__wzProtoMarker", { value: "A", configurable: true });
    } catch {
      proto = "refused";
    }
    return { global, proto };
  },
});

export const readMarker = query({
  args: {},
  handler: async () => ({ global: typeof globalThis.__wzMarker, proto: typeof ({}).__wzProtoMarker }),
});

export const hang = query({
  args: {},
  handler: async () => {
    for (;;) {}
  },
});

export default { facts, setMarker, readMarker, hang };
`;

/** A bundle that statically imports a Node built-in: workerd (no nodejs_compat) must refuse to load it. */
export const NODE_IMPORT_BUNDLE = `import { execSync } from "node:child_process";
import { query } from "@wizard/sdk";
export const f = query({ args: {}, handler: async () => typeof execSync });
export default { f };
`;
