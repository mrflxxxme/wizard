// Function executor process (security/isolation.yaml#M0_M1.mechanism). Plain ESM without loaders: it runs as
// `node --permission --allow-fs-read=<bundle dir>` with env {} and no argv. System code lives in a node:vm context
// that receives only primitives (JSON strings) from this process; every ctx.* call leaves as an IPC message.
import { readFileSync } from "node:fs";
import vm from "node:vm";
// The only module besides the bundle the permission model lets this process read (executorFlags).
import { guestMain } from "../sandbox/guest.mjs";

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
