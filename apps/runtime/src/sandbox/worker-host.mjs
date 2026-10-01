// Module "worker-host.mjs" of every system Worker in workerd (security/isolation.yaml#M2.runtime). Runs inside the
// sandbox: no Node APIs, no imports besides the guest runtime. Each system is its own Worker (own isolate) with
// bindings RUNTIME_RPC (service → runtime RPC listener), SYSTEM_ID, SYSTEM_ENV, ENTITIES (text) and
// globalOutbound = a deny-all network service. ctx.* of guest code becomes POST /rpc/<systemId>/<env> carrying the
// capability token of the call; this module holds no other credential.
import { guestMain } from "./guest.mjs";

const R = Response;
const stringify = JSON.stringify;
const parse = JSON.parse;

// Defense in depth on top of globalOutbound = deny: system code has no ambient network or cache API at all.
// guestMain() itself removes console, WebAssembly, SharedArrayBuffer and Atomics (Spectre gadgets, L3-23).
for (const k of ["fetch", "WebSocket", "EventSource", "caches", "connect"]) {
  try {
    Reflect.deleteProperty(globalThis, k);
  } catch {
    // non-configurable in this runtime: still unreachable through globalOutbound
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
