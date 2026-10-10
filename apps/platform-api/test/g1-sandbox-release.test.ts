// V3-18: releasing a gate's systems never starts a G1 pod (it was a new pod start of up to 120 s awaited after every
// gate, executors.gates): the pod keeps serving its other systems as it is; the last system's release removes it.
import type { KubeApi, KubePodStatus } from "@wizard/runtime";
import { describe, expect, it } from "vitest";
import { startG1Sandbox } from "../src/agents/g1-sandbox.js";

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects as the orchestrator renders them
type Obj = Record<string, any>;

class Kube implements KubeApi {
  readonly cms = new Map<string, Obj>();
  readonly pods = new Map<string, Obj>();
  readonly created: string[] = [];
  private ip = 10;
  async createConfigMap(cm: Obj) {
    this.cms.set(cm.metadata.name, cm);
  }
  async deleteConfigMap(name: string) {
    this.cms.delete(name);
  }
  async listConfigMaps() {
    return [...this.cms.keys()];
  }
  async createPod(pod: Obj) {
    this.created.push(pod.metadata.name);
    this.pods.set(pod.metadata.name, { ...pod, ip: `10.42.0.${this.ip++}` });
  }
  async deletePod(name: string) {
    this.pods.delete(name);
  }
  async getPod(name: string): Promise<KubePodStatus | null> {
    const p = this.pods.get(name);
    return p
      ? { name, phase: "Running", ready: true, podIP: p.ip, reason: null, labels: p.metadata.labels }
      : null;
  }
  async listPods() {
    return [];
  }
}

const ENV = {
  WIZARD_SANDBOX: "k8s",
  WIZARD_SANDBOX_IMAGE: "registry/wizard-sandbox@sha256:0",
  WIZARD_SANDBOX_RPC_ADDRESS: "10.42.0.5:4102",
  WIZARD_G1_RPC_PORT: "0",
  WIZARD_G1_RPC_HOST: "127.0.0.1",
  WIZARD_INTERNAL_TOKEN: "t".repeat(40),
};

describe("G1 sandbox release (V3-18)", () => {
  it("frees the slots without a pod start; the last one takes the pod and its ConfigMaps", async () => {
    const kube = new Kube();
    const sb = await startG1Sandbox(ENV, {
      kube,
      fetch: (async () => new Response("ok")) as unknown as typeof fetch,
    });
    if (!sb) throw new Error("sandbox expected");
    try {
      const prep = (systemId: string) =>
        sb.orchestrator.prepare({
          systemId,
          env: "draft",
          entities: ["Post"],
          functionsSource: "export const f = 1;",
        });
      await prep("sysa_g1_0");
      await prep("sysb_g1_0");
      await sb.orchestrator.drained();
      const started = kube.created.length;
      await sb.release(["sysa_g1_0"]);
      expect(kube.created).toHaveLength(started);
      expect(sb.orchestrator.endpointOf("sysb_g1_0", "draft")).not.toBeNull();
      await sb.release(["sysb_g1_0"]);
      expect(kube.pods.size).toBe(0);
      expect(kube.cms.size).toBe(0);
    } finally {
      await sb.close();
    }
  });
});
