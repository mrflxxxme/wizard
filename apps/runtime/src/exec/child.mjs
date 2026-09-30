// Function executor process (security/isolation.yaml#M0_M1.mechanism). Plain ESM without loaders: it runs as
// `node --permission --allow-fs-read=<bundle dir>` with env {} and no argv. System code lives in a node:vm context
// that receives only primitives (JSON strings) from this process; every ctx.* call leaves as an IPC message.
import { readFileSync } from "node:fs";
import vm from "node:vm";

/**
 * Runs inside the vm context. Everything it creates belongs to the context realm; the host keeps references to the
 * returned functions and exchanges JSON strings with them only.
 */
function guestMain() {
  const G = globalThis;
  for (const k of ["console", "WebAssembly", "SharedArrayBuffer", "Atomics"]) Reflect.deleteProperty(G, k);
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const freeze = Object.freeze;
  const keys = Object.keys;
  const isArray = Array.isArray;
  const CODE_RE = /^[A-Z][A-Z0-9_]{2,40}$/;

  class WizardError extends Error {
    constructor(code, details) {
      const d = details && typeof details === "object" ? details : {};
      super(typeof d.message === "string" ? d.message : String(code));
      this.name = "WizardError";
      this.code = String(code);
      this.details = d;
    }
  }
  const makeError = (code, details) =>
    CODE_RE.test(String(code))
      ? new WizardError(code, details)
      : new WizardError("INTERNAL", { invalidCode: String(code) });

  // ---------- validators: descriptors only; the host re-creates and enforces them ----------
  const mk = (spec, isOptional = false) => freeze({ kind: spec.kind, isOptional, spec: freeze(spec) });
  const num = (kind) => (o) => mk({ kind, min: o?.min, max: o?.max });
  const str = (kind) => () => mk({ kind });
  const v = freeze({
    string: (o) => mk({ kind: "string", min: o?.min, max: o?.max, pattern: o?.pattern }),
    int: num("int"),
    number: num("number"),
    money: num("money"),
    boolean: str("boolean"),
    date: str("date"),
    datetime: str("datetime"),
    email: str("email"),
    phone: str("phone"),
    pagination: str("pagination"),
    id: (entity) => mk({ kind: "id", entity: String(entity) }),
    literal: (value) => mk({ kind: "literal", value }),
    enum: (...values) => mk({ kind: "enum", values: values.map(String) }),
    array: (item, o) => mk({ kind: "array", item, max: o?.max }),
    object: (shape) => mk({ kind: "object", shape }),
    optional: (inner) => mk({ kind: "optional", inner }, true),
    nullable: (inner) => mk({ kind: "nullable", inner }, inner?.isOptional === true),
  });
  function serValidator(x) {
    const s = x?.spec;
    if (!s || typeof s.kind !== "string") throw new TypeError("invalid validator");
    const out = { kind: s.kind, isOptional: x.isOptional === true };
    for (const k of ["min", "max", "entity", "value", "values"]) if (s[k] !== undefined) out[k] = s[k];
    if (s.pattern instanceof RegExp) out.pattern = { source: s.pattern.source, flags: s.pattern.flags };
    if (s.item) out.item = serValidator(s.item);
    if (s.inner) out.inner = serValidator(s.inner);
    if (s.shape) out.shape = serShape(s.shape);
    return out;
  }
  function serShape(shape) {
    const out = {};
    for (const k of keys(shape ?? {})) out[k] = serValidator(shape[k]);
    return out;
  }

  // ---------- query / mutation / action ----------
  const defined = new WeakSet();
  const define = (kind) => (d) => {
    if (typeof d?.handler !== "function") throw new TypeError(`${kind}: handler must be a function`);
    const def = freeze({ kind, args: d.args ?? {}, handler: d.handler, __wizardFunction: true });
    defined.add(def);
    return def;
  };
  const sdk = freeze({
    PACKAGE: "@wizard/sdk",
    WizardError,
    v,
    query: define("query"),
    mutation: define("mutation"),
    action: define("action"),
  });

  // ---------- calls ----------
  const defs = new Map();
  const calls = new Map();
  const outq = [];
  let entities = [];
  let reqSeq = 0;

  function request(callId, op, payload) {
    return new Promise((resolve, reject) => {
      const c = calls.get(callId);
      if (!c) return reject(new WizardError("INTERNAL"));
      reqSeq += 1;
      let msg;
      try {
        msg = stringify({ t: "req", call: callId, id: reqSeq, op, ...payload });
      } catch {
        return reject(new WizardError("VALIDATION_FAILED", { message: "Аргументы нельзя передать" }));
      }
      c.pending.set(reqSeq, { resolve, reject });
      outq.push(msg);
    });
  }

  const READ = ["get", "getBy", "list", "first", "count", "paginate"];
  const WRITE = ["insert", "patch", "delete"];
  // Write methods exist in queries too: the host facade rejects them (FORBIDDEN), like ctx.db in the SDK host.
  function db(callId, target) {
    const out = {};
    for (const entity of entities) {
      const t = {};
      for (const method of [...READ, ...WRITE]) {
        t[method] = (...params) => request(callId, "db", { target, entity, method, params });
      }
      out[entity] = freeze(t);
    }
    return freeze(out);
  }

  function makeCtx(callId, kind, user, now) {
    const log = {};
    for (const level of ["info", "warn", "error"]) {
      log[level] = (msg, fields) => {
        try {
          outq.push(stringify({ t: "log", call: callId, level, msg: String(msg), fields: fields ?? {} }));
        } catch {
          // Unserializable log fields are dropped.
        }
      };
    }
    const base = { user, now, error: makeError, log: freeze(log) };
    const scheduler = freeze({
      runAfter: (delayMs, name, args) =>
        request(callId, "scheduler", { method: "runAfter", params: [delayMs, name, args] }),
      runAt: (at, name, args) => request(callId, "scheduler", { method: "runAt", params: [at, name, args] }),
      cancel: (id) => request(callId, "scheduler", { method: "cancel", params: [id] }),
    });
    if (kind === "query") return freeze({ ...base, db: db(callId, "db"), systemDb: db(callId, "systemDb") });
    if (kind === "mutation") {
      return freeze({ ...base, db: db(callId, "db"), systemDb: db(callId, "systemDb"), scheduler });
    }
    const connectors = new Proxy(
      {},
      {
        get: (_, integration) =>
          typeof integration !== "string"
            ? undefined
            : new Proxy(
                {},
                {
                  get: (__, method) =>
                    typeof method !== "string" || method === "then"
                      ? undefined
                      : (input) => request(callId, "connector", { integration, method, input }),
                },
              ),
      },
    );
    return freeze({
      ...base,
      scheduler,
      connectors,
      http: freeze({ fetch: () => Promise.reject(new WizardError("EGRESS_DISABLED")) }),
      runQuery: (name, args) => request(callId, "run", { kind: "query", name, args }),
      runMutation: (name, args) => request(callId, "run", { kind: "mutation", name, args }),
    });
  }

  function errorOf(e) {
    if (e instanceof WizardError) {
      let details = {};
      try {
        details = parse(stringify(e.details ?? {})) ?? {};
      } catch {
        details = {};
      }
      if (typeof details !== "object" || isArray(details)) details = {};
      return { code: e.code, details };
    }
    return { code: "INTERNAL", details: {}, internal: String(e?.name ?? "Error") };
  }

  function finish(callId, ok, value) {
    if (!calls.delete(callId)) return;
    if (!ok) {
      outq.push(stringify({ t: "done", id: callId, ok: false, error: errorOf(value) }));
      return;
    }
    let msg;
    try {
      msg = stringify({ t: "done", id: callId, ok: true, value: value === undefined ? null : value });
    } catch {
      msg = stringify({
        t: "done",
        id: callId,
        ok: false,
        error: { code: "INTERNAL", details: {}, internal: "result" },
      });
    }
    outq.push(msg);
  }

  function register(ns, entitiesJson) {
    entities = parse(entitiesJson);
    const all = ns.default ?? {};
    const out = {};
    for (const name of keys(all)) {
      const d = all[name];
      if (!defined.has(d)) continue;
      defs.set(name, d);
      out[name] = { kind: d.kind, args: serShape(d.args) };
    }
    return stringify(out);
  }

  function pump(json) {
    const m = parse(json);
    if (m.t === "call") {
      const def = defs.get(m.name);
      calls.set(m.id, { pending: new Map() });
      if (!def || def.kind !== m.kind) return finish(m.id, false, new WizardError("NOT_FOUND"));
      const user = freeze({ ...m.user, attrs: freeze({ ...m.user.attrs }) });
      const ctx = makeCtx(m.id, m.kind, user, new Date(m.now));
      let r;
      try {
        r = def.handler(ctx, m.args);
      } catch (e) {
        return finish(m.id, false, e);
      }
      Promise.resolve(r).then(
        (value) => finish(m.id, true, value),
        (e) => finish(m.id, false, e),
      );
      return;
    }
    if (m.t === "reply") {
      const p = calls.get(m.call)?.pending;
      const h = p?.get(m.id);
      if (!h) return;
      p.delete(m.id);
      if (m.ok) h.resolve(m.value);
      else h.reject(new WizardError(m.error?.code ?? "INTERNAL", m.error?.details ?? {}));
    }
  }

  function take() {
    const s = `[${outq.join(",")}]`;
    outq.length = 0;
    return s;
  }

  return freeze({ sdk, register, pump, take });
}

const SDK_EXPORTS = ["PACKAGE", "WizardError", "v", "query", "mutation", "action"];
const CEILING_MS = 5000;

const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
  name: "wizard-functions",
  codeGeneration: { strings: false, wasm: false },
  microtaskMode: "afterEvaluate",
});
const guest = new vm.Script(`(${guestMain.toString()})()`, { filename: "wizard-guest.js" }).runInContext(
  context,
);
const { sdk, register, pump, take } = guest;
const drain = new vm.Script("undefined", { filename: "wizard-drain.js" });

function send(msg) {
  if (process.connected) process.send(msg);
}

function flush() {
  drain.runInContext(context, { timeout: CEILING_MS });
  const s = take();
  if (typeof s !== "string") return;
  for (const m of JSON.parse(s)) send(m);
}

async function load(dir, entities) {
  const source = readFileSync(`${dir}/server/functions.mjs`, "utf8");
  const sdkModule = new vm.SyntheticModule(
    SDK_EXPORTS,
    function init() {
      for (const k of SDK_EXPORTS) this.setExport(k, sdk[k]);
    },
    { context, identifier: "@wizard/sdk" },
  );
  const mod = new vm.SourceTextModule(source, { context, identifier: "functions.mjs" });
  await mod.link((specifier) => {
    if (specifier === "@wizard/sdk") return sdkModule;
    throw new Error(`import ${specifier} is not allowed`);
  });
  await mod.evaluate({ timeout: CEILING_MS });
  const fns = register(mod.namespace, JSON.stringify(entities));
  flush();
  return typeof fns === "string" ? JSON.parse(fns) : {};
}

process.on("message", (m) => {
  if (m?.t === "init") {
    load(String(m.dir), Array.isArray(m.entities) ? m.entities.map(String) : []).then(
      (fns) => send({ t: "ready", fns }),
      (e) => send({ t: "load_error", message: String(e?.message ?? e).slice(0, 500) }),
    );
    return;
  }
  try {
    pump(JSON.stringify(m));
    flush();
  } catch {
    process.exit(70);
  }
});
process.on("disconnect", () => process.exit(0));
