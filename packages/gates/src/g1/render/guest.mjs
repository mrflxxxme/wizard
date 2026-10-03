// G1-RENDER-01 guest (security/isolation.yaml): browser-ish globals for React SSR, the fetch bridge and the render
// passes. Self-contained — it runs stringified inside a node:vm context (child.mjs, unsafe-local) or as the module of a
// workerd Worker in the sandbox pod (worker-host.mjs, M2-19). Only JSON strings cross its boundary.

/** Installs the guest on globalThis; returns {start, reply, take}. */
export function guestMain(notify) {
  const G = globalThis;
  // workerd (M2-19): the host Worker waits on notify for the next message; the vm child polls instead.
  const push = (s) => {
    outq.push(s);
    if (typeof notify === "function") notify();
  };
  for (const k of ["WebAssembly", "SharedArrayBuffer", "Atomics"]) Reflect.deleteProperty(G, k);
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const MAX_PASSES = 4;
  const outq = [];
  const logs = [];
  const noop = () => {};

  const fmt = (args) =>
    args
      .map((a) => {
        if (typeof a === "string") return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try {
          return stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ")
      .slice(0, 500);
  const log =
    (level) =>
    (...args) => {
      if (logs.length < 50) logs.push({ level, text: fmt(args) });
    };
  G.console = { error: log("error"), warn: log("warn"), log: noop, info: noop, debug: noop, trace: noop };

  // Effects and timers never run in a server render: timers are accepted and never fire.
  let timerSeq = 0;
  G.setTimeout = () => ++timerSeq;
  G.setInterval = () => ++timerSeq;
  G.clearTimeout = noop;
  G.clearInterval = noop;
  G.queueMicrotask = (fn) => {
    Promise.resolve().then(fn);
  };

  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input = "") {
      const out = [];
      for (const ch of String(input)) {
        const c = ch.codePointAt(0);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    }
    encodeInto(input, dest) {
      const b = this.encode(input);
      const n = Math.min(b.length, dest.length);
      dest.set(b.subarray(0, n));
      return { read: String(input).length, written: n };
    }
  }
  class TextDecoder {
    decode(buf) {
      if (!buf) return "";
      const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf);
      let s = "";
      for (let i = 0; i < b.length; ) {
        const c = b[i++];
        let cp = c;
        if (c >= 0xf0) cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 0xe0) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
        else if (c >= 0xc0) cp = ((c & 31) << 6) | (b[i++] & 63);
        s += String.fromCodePoint(cp);
      }
      return s;
    }
  }
  const enc = (s) => encodeURIComponent(s).replace(/%20/g, "+");
  const dec = (s) => decodeURIComponent(s.replace(/\+/g, " "));
  class URLSearchParams {
    constructor(init) {
      this._p = [];
      if (typeof init === "string") {
        for (const part of init.replace(/^\?/, "").split("&")) {
          if (!part) continue;
          const i = part.indexOf("=");
          this._p.push(i < 0 ? [dec(part), ""] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
        }
      } else if (init && typeof init === "object") {
        for (const [k, v] of Array.isArray(init) ? init : Object.entries(init)) this.append(k, v);
      }
    }
    append(k, v) {
      this._p.push([String(k), String(v)]);
    }
    set(k, v) {
      this.delete(k);
      this.append(k, v);
    }
    delete(k) {
      this._p = this._p.filter(([a]) => a !== String(k));
    }
    get(k) {
      const e = this._p.find(([a]) => a === String(k));
      return e ? e[1] : null;
    }
    getAll(k) {
      return this._p.filter(([a]) => a === String(k)).map(([, v]) => v);
    }
    has(k) {
      return this._p.some(([a]) => a === String(k));
    }
    forEach(fn) {
      for (const [k, v] of this._p) fn(v, k, this);
    }
    entries() {
      return this._p.map((e) => [...e])[Symbol.iterator]();
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    toString() {
      return this._p.map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
    }
  }
  class MessageChannel {
    constructor() {
      const a = { onmessage: null, postMessage: (data) => deliver(b, data), close: noop };
      const b = { onmessage: null, postMessage: (data) => deliver(a, data), close: noop };
      const deliver = (to, data) => {
        Promise.resolve().then(() => to.onmessage?.({ data }));
      };
      this.port1 = a;
      this.port2 = b;
    }
  }
  G.MessageChannel = MessageChannel;
  G.TextEncoder = TextEncoder;
  G.TextDecoder = TextDecoder;
  G.URLSearchParams = URLSearchParams;
  G.self = G;

  // ---------- fetch bridge ----------
  let reqSeq = 0;
  const pending = new Map();
  G.fetch = (input, init = {}) =>
    new Promise((resolve, reject) => {
      reqSeq += 1;
      pending.set(reqSeq, { resolve, reject });
      push(
        stringify({
          t: "fetch",
          id: reqSeq,
          method: String(init.method ?? "GET").toUpperCase(),
          path: String(input),
          body: typeof init.body === "string" ? init.body : null,
        }),
      );
    });
  function reply(m) {
    const h = pending.get(m.id);
    if (!h) return;
    pending.delete(m.id);
    if (!m.ok) return h.reject(new TypeError("fetch failed"));
    const body = String(m.body ?? "");
    h.resolve({
      status: m.status,
      ok: m.status >= 200 && m.status < 300,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve(parse(body)),
    });
  }

  // ---------- SSR data: useRemote reads this cache; a pass records keys it lacks ----------
  let cache = new Map();
  let wanted = null;
  G.__wzSsrRemote = (key, fetcher) => {
    if (key === null) return { key, data: undefined, error: undefined, isLoading: false, refetch: noop };
    const hit = cache.get(key);
    if (hit) return { key, data: hit.data, error: hit.error, isLoading: false, refetch: noop };
    if (wanted && !wanted.has(key)) wanted.set(key, fetcher);
    return { key, data: undefined, error: undefined, isLoading: true, refetch: noop };
  };

  async function render(job) {
    const App = G.__wzApp;
    const Page = App?.pages?.[job.file];
    if (typeof Page !== "function") throw new Error(`page ${job.file} is not a component`);
    cache = new Map();
    const toError = (e) =>
      e instanceof App.WizardError ? e : new App.WizardError("INTERNAL", { message: "Внутренняя ошибка" });
    // Consent metadata is never needed while rendering (no mutation runs).
    const client = new App.SdkClient({
      fetch: G.fetch,
      realtime: false,
      consent: { policyVersion: "render", textHash: "render" },
    });
    await client.loadUser().catch(noop);
    const tree = () =>
      App.jsx(App.SdkProvider, {
        client,
        routes: job.routes,
        pathname: job.path,
        navigate: noop,
        redirect: noop,
        children: App.jsx(App.WzProvider, {
          spec: job.roleSpec,
          pathname: job.path,
          navigate: noop,
          applyTheme: false,
          children: App.jsx(Page, {}),
        }),
      });
    let html = "";
    let passes = 0;
    let loading = 0;
    for (;;) {
      passes += 1;
      wanted = new Map();
      html = App.renderToString(tree());
      const todo = [...wanted];
      wanted = null;
      loading = todo.length;
      if (todo.length === 0 || passes >= MAX_PASSES) break;
      await Promise.all(
        todo.map(async ([key, fetcher]) => {
          try {
            cache.set(key, { data: await fetcher() });
          } catch (e) {
            cache.set(key, { error: toError(e) });
          }
        }),
      );
    }
    return { html, passes, loading };
  }

  function start(json) {
    const job = parse(json);
    logs.length = 0;
    render(job).then(
      (r) => push(stringify({ t: "done", id: job.id, ok: true, ...r, logs: logs.slice() })),
      (e) =>
        push(
          stringify({
            t: "done",
            id: job.id,
            ok: false,
            error: `${String(e?.name ?? "Error")}: ${String(e?.message ?? e)}`.slice(0, 500),
            logs: logs.slice(),
          }),
        ),
    );
  }

  function take() {
    const s = `[${outq.join(",")}]`;
    outq.length = 0;
    return s;
  }

  return Object.freeze({ start, reply: (json) => reply(parse(json)), take });
}
