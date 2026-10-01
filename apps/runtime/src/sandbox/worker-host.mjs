// Module "worker-host.mjs" of every system Worker in workerd (security/isolation.yaml#M2.runtime). Runs inside the
// sandbox: no Node APIs, no imports besides the guest runtime. Each system is its own Worker (own isolate) with
// bindings RUNTIME_RPC (service → runtime RPC listener), SYSTEM_ID, SYSTEM_ENV, ENTITIES (text) and
// globalOutbound = a deny-all network service. ctx.* of guest code becomes POST /rpc/<systemId>/<env> carrying the
// capability token of the call; this module holds no other credential.
import { guestMain } from "./guest.mjs";

const R = Response;
const stringify = JSON.stringify;
const parse = JSON.parse;

// Defense in depth on top of globalOutbound = deny: system code has no ambient network or cache API at all
// (isolation.yaml: fetch/XMLHttpRequest/WebSocket forbidden). guestMain() itself removes console, WebAssembly, SharedArrayBuffer and Atomics (Spectre gadgets, L3-23).
// workerd defines some of them on the global scope's prototype, so the own-property delete alone is not enough:
// delete along the prototype chain, then shadow whatever is left with a non-writable undefined.
for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "caches", "connect"]) {
  for (let o = globalThis; o; o = Object.getPrototypeOf(o)) {
    try {
      Reflect.deleteProperty(o, k);
    } catch {
      // non-configurable here: shadowed below, still unreachable through globalOutbound
    }
  }
  if (k in globalThis) {
    try {
      Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false });
    } catch {
      // still unreachable through globalOutbound
    }
  }
}

// Spectre (isolation.yaml#M2.runtime): Date and performance.now do not advance within a call; the clock moves
// only at the call start and when an RPC reply arrives (I/O), with 1 ms resolution.
const RealDate = Date;
const realNow = RealDate.now;
const perf = globalThis.performance;
const realPerfNow = perf && typeof perf.now === "function" ? perf.now.bind(perf) : null;
let frozen = realNow();
let frozenPerf = realPerfNow ? Math.floor(realPerfNow()) : 0;
const tick = () => {
  frozen = realNow();
  if (realPerfNow) frozenPerf = Math.floor(realPerfNow());
};
function FrozenDate(...a) {
  if (!new.target) return new RealDate(frozen).toString();
  return a.length === 0 ? new RealDate(frozen) : new RealDate(...a);
}
FrozenDate.prototype = RealDate.prototype;
FrozenDate.now = () => frozen;
FrozenDate.parse = RealDate.parse;
FrozenDate.UTC = RealDate.UTC;
Object.defineProperty(globalThis, "Date", { value: FrozenDate, writable: false, configurable: false });
if (perf && realPerfNow) {
  try {
    Object.defineProperty(perf, "now", { value: () => frozenPerf, writable: false, configurable: false });
  } catch {
    // performance.now non-configurable: Date is still frozen
  }
}

/** call id → {resolve, token, env} */
const calls = new Map();
let seq = 0;
let scheduled = false;

/** Guest runtime shared with the M0–M1 executor (src/sandbox/guest.mjs); `@wizard/sdk` re-exports guest.sdk. */
export const guest = guestMain(() => {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(drain);
});

async function rpc(call, body) {
  try {
    const res = await call.env.RUNTIME_RPC.fetch(
      `http://runtime/rpc/${encodeURIComponent(call.env.SYSTEM_ID)}/${encodeURIComponent(call.env.SYSTEM_ENV)}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${call.token}`, "content-type": "application/json" },
        body: stringify(body),
      },
    );
    if (res.status === 403) return { ok: false, error: { code: "FORBIDDEN", details: {} } };
    if (!res.ok) return { ok: false, error: { code: "INTERNAL", details: {} } };
    const out = await res.json();
    return out && typeof out === "object" ? out : { ok: false, error: { code: "INTERNAL", details: {} } };
  } catch {
    return { ok: false, error: { code: "INTERNAL", details: {} } };
  }
}

function drain() {
  scheduled = false;
  const msgs = parse(guest.take());
  for (const m of msgs) {
    if (m.t === "done") {
      const c = calls.get(m.id);
      calls.delete(m.id);
      c?.resolve(m);
      continue;
    }
    const c = calls.get(m.call);
    if (!c) continue;
    if (m.t === "log") {
      void rpc(c, { op: "log", level: m.level, msg: m.msg, fields: m.fields });
      continue;
    }
    if (m.t === "req") {
      rpc(c, m).then((reply) => {
        tick();
        guest.pump(
          stringify({
            t: "reply",
            call: m.call,
            id: m.id,
            ok: reply.ok === true,
            value: reply.value,
            error: reply.error,
          }),
        );
      });
    }
  }
}

const json = (status, body) =>
  new R(stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/** Default export of the system's main module: `export default createWorkerHost(functionsNamespace)`. */
export function createWorkerHost(ns) {
  let fns = null;
  const register = (env) => {
    fns ??= parse(
      guest.register(
        ns,
        stringify(
          String(env.ENTITIES ?? "")
            .split(",")
            .filter(Boolean),
        ),
      ),
    );
    return fns;
  };
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/__wizard/health") return new R("ok");
      const functions = register(env);
      if (url.pathname === "/__wizard/functions" && request.method === "GET") return json(200, functions);
      if (url.pathname !== "/__wizard/call" || request.method !== "POST")
        return json(404, { error: "not_found" });
      const m = await request.json();
      if (typeof m?.token !== "string" || typeof m?.name !== "string")
        return json(400, { error: "bad_request" });
      seq += 1;
      const id = seq;
      const done = new Promise((resolve) => calls.set(id, { resolve, token: m.token, env }));
      tick();
      guest.pump(
        stringify({
          t: "call",
          id,
          name: m.name,
          kind: m.kind,
          args: m.args ?? {},
          now: m.now,
          user: m.user,
        }),
      );
      const out = await done;
      return json(200, out.ok ? { ok: true, value: out.value } : { ok: false, error: out.error });
    },
  };
}
