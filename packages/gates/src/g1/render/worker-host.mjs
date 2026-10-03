// G1-RENDER-01 in the sandbox (M2-19; security/isolation.yaml#M2): the module of a workerd Worker that renders the
// pages of the system under test. guestMain installs the render globals in this isolate before render.js runs (main
// module imports this file first); every fetch of page code goes to the G1 host through the RUNTIME_RPC binding with
// the token of the render it belongs to. globalOutbound of the Worker is deny-all; nothing else leaves the isolate.
import { guestMain } from "./render-guest.mjs";

let wake = null;
let ready = false;
const guest = guestMain(() => {
  ready = true;
  const w = wake;
  wake = null;
  if (w) w();
});

/** One page render at a time per Worker (G1 renders sequentially). */
let busy = false;

async function bridge(rpc, token, m) {
  let reply;
  try {
    const res = await rpc.fetch("http://runtime-rpc/render-fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, method: m.method, path: m.path, body: m.body ?? null }),
    });
    const out = await res.json();
    reply = res.ok
      ? { t: "reply", id: m.id, ok: true, status: Number(out.status) || 500, body: String(out.body ?? "") }
      : { t: "reply", id: m.id, ok: false };
  } catch {
    reply = { t: "reply", id: m.id, ok: false };
  }
  guest.reply(JSON.stringify(reply));
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/__wizard/ready") return json(200, { ok: true });
    if (req.method !== "POST" || url.pathname !== "/__wizard/render") return json(404, { ok: false });
    if (busy) return json(409, { ok: false, error: "busy" });
    const body = await req.json();
    if (typeof body?.token !== "string" || typeof body?.job !== "object" || body.job === null)
      return json(400, { ok: false });
    busy = true;
    try {
      ready = false;
      guest.start(JSON.stringify(body.job));
      for (;;) {
        if (!ready) await new Promise((r) => (wake = r));
        ready = false;
        for (const m of JSON.parse(guest.take())) {
          if (m.t === "done") return json(200, m);
          if (m.t === "fetch") void bridge(env.RUNTIME_RPC, body.token, m);
        }
      }
    } finally {
      busy = false;
    }
  },
};
