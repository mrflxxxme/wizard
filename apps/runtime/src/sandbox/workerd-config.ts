// workerd configuration of one sandbox pod (security/isolation.yaml#M2.runtime): one workerd process, one Worker
// (own V8 isolate) per system, at most 10 systems. Every Worker gets only RUNTIME_RPC (an external service: the
// runtime RPC listener) and text bindings; globalOutbound is a network service that allows no address at all, and
// nodejs_compat is off (no node:fs, node:net, process). Rendered as Cap'n Proto text plus the embedded module files.
import { readFileSync } from "node:fs";
import { MAX_SYSTEMS_PER_POD } from "./pool.js";

/** Fixed in the repo (isolation.yaml#M2.runtime); bump together with the workerd version and the CI sandbox job. */
export const WORKERD_COMPATIBILITY_DATE = "2025-09-01";
/** Compatibility flags of system Workers: none — in particular no nodejs_compat and no precise_timers. */
export const WORKERD_COMPATIBILITY_FLAGS: readonly string[] = [];
/** V8 heap limit per isolate (runtime.yaml#functions limits: memory 128 MB). */
export const WORKERD_V8_FLAGS: readonly string[] = ["--max-old-space-size=128"];

const SRC = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

export interface WorkerdSystem {
  systemId: string;
  env: "draft" | "prod";
  /** server/functions.mjs of the artifact (sha256 checked by the loader before it gets here). */
  functionsSource: string;
  entities: readonly string[];
}

export interface WorkerdPodInput {
  systems: readonly WorkerdSystem[];
  /** Address of the runtime RPC listener, e.g. "runtime-rpc.platform.svc:443" or "127.0.0.1:4102". */
  rpcAddress: string;
  /** Listen host of the system sockets (pod: "*"; tests: "127.0.0.1"). */
  listenHost?: string;
  /** Port of slot 0; slot i listens on basePort + i. */
  basePort: number;
  /** Liveness socket (a tiny Worker; a stuck isolate blocks it and the pod is restarted). */
  healthPort: number;
}

export interface WorkerdPodConfig {
  /** config.capnp */
  capnp: string;
  /** Files the config embeds, relative to the config file. */
  files: Record<string, string>;
}

const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9_]{0,62}$/;
const ADDRESS_RE = /^[A-Za-z0-9.\-[\]:*]{1,255}$/;
const ENTITY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Cap'n Proto text literal (input is restricted to printable ASCII without quotes or backslashes). */
function str(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s) || /["\\]/.test(s)) throw new Error(`unsafe capnp text: ${s.slice(0, 40)}`);
  return `"${s}"`;
}

/** Main module of a system Worker: the functions bundle first, so the guest runtime is ready before it runs. */
export const MAIN_MODULE = `import * as functions from "functions.mjs";
import { createWorkerHost } from "worker-host.mjs";
export default createWorkerHost(functions);
`;

/** `@wizard/sdk` inside the sandbox: the guest runtime's SDK shim (validators, query/mutation/action). */
export const SDK_MODULE = `import { guest } from "worker-host.mjs";
export const { PACKAGE, WizardError, v, query, mutation, action } = guest.sdk;
`;

const HEALTH_MODULE = `export default { fetch() { return new Response("ok"); } };`;

export function workerdPodConfig(i: WorkerdPodInput): WorkerdPodConfig {
  if (i.systems.length === 0 || i.systems.length > MAX_SYSTEMS_PER_POD) {
    throw new Error(`a pod holds 1…${MAX_SYSTEMS_PER_POD} systems, got ${i.systems.length}`);
  }
  if (!ADDRESS_RE.test(i.rpcAddress)) throw new Error("invalid rpcAddress");
  const host = i.listenHost ?? "*";
  if (!ADDRESS_RE.test(host)) throw new Error("invalid listenHost");
  const seen = new Set<string>();
  const files: Record<string, string> = {
    "guest.mjs": SRC("guest.mjs"),
    "worker-host.mjs": SRC("worker-host.mjs"),
    "main.mjs": MAIN_MODULE,
    "sdk.mjs": SDK_MODULE,
  };
  const services: string[] = [
    // globalOutbound of every system Worker: no CIDR allowed, everything denied (fetch()/connect() fail).
    `(name = "deny-all", network = (allow = [], deny = ["public", "private", "local", "network", "unix", "unix-abstract"]))`,
    `(name = "runtime-rpc", external = (address = ${str(i.rpcAddress)}, http = ()))`,
    `(name = "health", worker = (modules = [(name = "health.mjs", esModule = ${JSON.stringify(HEALTH_MODULE)})], compatibilityDate = ${str(WORKERD_COMPATIBILITY_DATE)}, globalOutbound = "deny-all"))`,
  ];
  const sockets: string[] = [
    `(name = "health", address = ${str(`${host}:${i.healthPort}`)}, http = (), service = "health")`,
  ];
  const workers: string[] = [];
  i.systems.forEach((s, slot) => {
    if (!SYSTEM_ID_RE.test(s.systemId) || (s.env !== "draft" && s.env !== "prod")) {
      throw new Error(`invalid system ${s.systemId}/${s.env}`);
    }
    const key = `${s.systemId}_${s.env}`;
    if (seen.has(key)) throw new Error(`duplicate system ${key}`);
    seen.add(key);
    if (!s.entities.every((e) => ENTITY_RE.test(e))) throw new Error(`invalid entity name in ${key}`);
    const dir = `s${slot}`;
    files[`${dir}/functions.mjs`] = s.functionsSource;
    const name = `sys_${key}`;
    services.push(`(name = ${str(name)}, worker = .w${slot})`);
    sockets.push(
      `(name = ${str(`s${slot}`)}, address = ${str(`${host}:${i.basePort + slot}`)}, http = (), service = ${str(name)})`,
    );
    workers.push(`const w${slot} :Workerd.Worker = (
  modules = [
    (name = "main.mjs", esModule = embed "main.mjs"),
    (name = "functions.mjs", esModule = embed ${str(`${dir}/functions.mjs`)}),
    (name = "@wizard/sdk", esModule = embed "sdk.mjs"),
    (name = "worker-host.mjs", esModule = embed "worker-host.mjs"),
    (name = "guest.mjs", esModule = embed "guest.mjs"),
  ],
  compatibilityDate = ${str(WORKERD_COMPATIBILITY_DATE)},
  compatibilityFlags = [${WORKERD_COMPATIBILITY_FLAGS.map(str).join(", ")}],
  bindings = [
    (name = "RUNTIME_RPC", service = "runtime-rpc"),
    (name = "SYSTEM_ID", text = ${str(s.systemId)}),
    (name = "SYSTEM_ENV", text = ${str(s.env)}),
    (name = "ENTITIES", text = ${str(s.entities.join(","))}),
  ],
  globalOutbound = "deny-all",
);`);
  });
  const capnp = `# Generated by apps/runtime/src/sandbox/workerd-config.ts — do not edit.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ${services.join(",\n    ")},
  ],
  sockets = [
    ${sockets.join(",\n    ")},
  ],
  v8Flags = [${WORKERD_V8_FLAGS.map(str).join(", ")}],
);

${workers.join("\n\n")}
`;
  return { capnp, files };
}
