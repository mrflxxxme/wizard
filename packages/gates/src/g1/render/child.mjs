// G1-RENDER-01 render process (security/isolation.yaml#M0_M1, same mechanism as the runtime function executor):
// `node --permission --allow-fs-read=<bundle dir>` with env {} and no argv. Page code lives in a node:vm context that
// exchanges only JSON strings with this process; every fetch leaves as an IPC message the gate answers.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { guestMain } from "./guest.mjs";

const CEILING_MS = 5000;

const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
  name: "wizard-render",
  codeGeneration: { strings: false, wasm: false },
  microtaskMode: "afterEvaluate",
});
const guest = new vm.Script(`(${guestMain.toString()})()`, {
  filename: "wizard-render-guest.js",
}).runInContext(context);
const drain = new vm.Script("undefined", { filename: "wizard-render-drain.js" });

function send(msg) {
  if (process.connected) process.send(msg);
}

function flush() {
  drain.runInContext(context, { timeout: CEILING_MS });
  const s = guest.take();
  if (typeof s !== "string") return;
  for (const m of JSON.parse(s)) send(m);
}

process.on("message", (m) => {
  try {
    if (m?.t === "init") {
      const source = readFileSync(`${String(m.dir)}/render.js`, "utf8");
      new vm.Script(source, { filename: "render.js" }).runInContext(context, { timeout: CEILING_MS });
      flush();
      send({ t: "ready" });
      return;
    }
    if (m?.t === "render") guest.start(JSON.stringify(m));
    else if (m?.t === "reply") guest.reply(JSON.stringify(m));
    flush();
  } catch (e) {
    send({ t: "fatal", message: String(e?.message ?? e).slice(0, 500) });
    process.exit(70);
  }
});
process.on("disconnect", () => process.exit(0));
