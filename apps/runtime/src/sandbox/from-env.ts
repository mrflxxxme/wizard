// Sandbox of the runtime process from its environment (M2-18; chart infra/helm/wizard/templates/runtime.yaml):
//   WIZARD_SANDBOX=k8s                       functions run in workerd pods placed by SandboxOrchestrator
//   WIZARD_SANDBOX_IMAGE                     workerd image (wizard-sandbox)
//   WIZARD_SANDBOX_RPC_ADDRESS               <runtime pod IP>:<internal port> (the pods have no DNS)
//   WIZARD_SANDBOX_KEY | WIZARD_INTERNAL_TOKEN  capability HMAC key (64 hex) or the secret it is derived from
//   WIZARD_SANDBOX_NAMESPACE, _BASE_PORT, _HEALTH_PORT, _SYSTEMS_PER_POD, _MAX_PODS, _MEMORY, _CPU  (chart values)
//   WIZARD_SANDBOX_IDLE_DRAFT_MIN, _IDLE_PROD_MIN  slot of a system idle this long is freed (30 / 1440; 0 — never)
import { createHmac } from "node:crypto";
import { CAPABILITY_KEY_BYTES } from "./capability.js";
import { inClusterSend, type KubeApi, kubeApi } from "./kube.js";
import { SandboxOrchestrator } from "./orchestrator.js";
import { SandboxRpc } from "./rpc.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Capability key: WIZARD_SANDBOX_KEY, else HMAC-SHA256 of a fixed label under WIZARD_INTERNAL_TOKEN. */
export function sandboxKey(env: Env): Uint8Array {
  const hex = env.WIZARD_SANDBOX_KEY?.trim();
  if (hex) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("WIZARD_SANDBOX_KEY: 64 hex characters");
    return Buffer.from(hex, "hex");
  }
  const token = env.WIZARD_INTERNAL_TOKEN;
  if (!token || token.length < 16)
    throw new Error("WIZARD_SANDBOX=k8s needs WIZARD_SANDBOX_KEY or WIZARD_INTERNAL_TOKEN");
  const key = createHmac("sha256", token).update("wizard-sandbox-capability-v1").digest();
  return new Uint8Array(key.subarray(0, CAPABILITY_KEY_BYTES));
}

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n > 0 ? n : d;
};

const minutes = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isInteger(n) && n >= 0 ? n * 60_000 : d * 60_000;
};

/**
 * V3-18: idle limits of SandboxOrchestrator.startIdleCollector (pilot: 2 pods × 10 slots). A draft is freed after
 * 30 min without calls, a published system after a day (its next request starts its Worker again).
 */
export function sandboxIdleFromEnv(env: Env): { draft: number; prod: number } {
  return {
    draft: minutes(env.WIZARD_SANDBOX_IDLE_DRAFT_MIN, 30),
    prod: minutes(env.WIZARD_SANDBOX_IDLE_PROD_MIN, 1440),
  };
}

export function sandboxFromEnv(
  env: Env,
  deps: {
    kube?: KubeApi;
    log?: (line: Record<string, unknown>) => void;
    /** Owner label of the pods: "runtime" (system functions) or "g1" (the G1 host of the worker, M2-19). */
    owner?: string;
    /** Replace a pod in place when the quota has no room for two (OrchestratorOptions.inPlace; the G1 host). */
    inPlace?: boolean;
    /** Calls to the pods and their reachability probe (tests: a fake network). */
    fetch?: typeof fetch;
  } = {},
): { orchestrator: SandboxOrchestrator; rpc: SandboxRpc } | null {
  if ((env.WIZARD_SANDBOX ?? "off") === "off") return null;
  if (env.WIZARD_SANDBOX !== "k8s") throw new Error(`WIZARD_SANDBOX: off | k8s, got ${env.WIZARD_SANDBOX}`);
  const image = env.WIZARD_SANDBOX_IMAGE;
  const rpcAddress = env.WIZARD_SANDBOX_RPC_ADDRESS;
  if (!image || !rpcAddress)
    throw new Error("WIZARD_SANDBOX=k8s needs WIZARD_SANDBOX_IMAGE and WIZARD_SANDBOX_RPC_ADDRESS");
  const namespace = env.WIZARD_SANDBOX_NAMESPACE || "wizard-sandbox";
  const rpc = new SandboxRpc({ key: sandboxKey(env), ...(deps.log ? { log: deps.log } : {}) });
  const orchestrator = new SandboxOrchestrator({
    kube: deps.kube ?? kubeApi(namespace, inClusterSend(env)),
    rpc,
    owner: deps.owner ?? "runtime",
    namespace,
    image,
    rpcAddress,
    basePort: int(env.WIZARD_SANDBOX_BASE_PORT, 9000),
    healthPort: int(env.WIZARD_SANDBOX_HEALTH_PORT, 8999),
    systemsPerPod: Math.min(int(env.WIZARD_SANDBOX_SYSTEMS_PER_POD, 10), 10),
    maxPods: int(env.WIZARD_SANDBOX_MAX_PODS, 50),
    ...(env.WIZARD_SANDBOX_MEMORY ? { memoryLimit: env.WIZARD_SANDBOX_MEMORY } : {}),
    ...(env.WIZARD_SANDBOX_CPU ? { cpuLimit: env.WIZARD_SANDBOX_CPU } : {}),
    // Tests run workerd as a local process (pods listen on "*").
    ...(env.WIZARD_SANDBOX_LISTEN_HOST ? { listenHost: env.WIZARD_SANDBOX_LISTEN_HOST } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.inPlace ? { inPlace: true } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return { orchestrator, rpc };
}
