// M2-18, CI job `sandbox` only (WIZARD_SANDBOX_E2E=1, WORKERD_BIN): what SandboxOrchestrator puts into a ConfigMap
// runs in a real workerd. A Kubernetes stand-in materializes the ConfigMap items into a folder (as the kubelet mounts
// them) and starts `workerd serve` for each created pod; functions are then called through executorFor and the RPC.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CurrentUser } from "@wizard/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxRpc } from "../../src/index.js";
import type { KubeApi, KubePodStatus } from "../../src/sandbox/kube.js";
import { SandboxOrchestrator } from "../../src/sandbox/orchestrator.js";
import { KEY, startRpcServer } from "./helpers.js";
import { PROBE_BUNDLE, PROBE_FUNCTIONS } from "./probe-bundle.js";
import { freePortRange, startWorkerd, type WorkerdProcess } from "./workerd-process.js";

const E2E = process.env.WIZARD_SANDBOX_E2E === "1";
const USER = { id: null, role: "visitor", isAdmin: false, attrs: {} } as unknown as CurrentUser;
// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects as the orchestrator renders them
type Obj = Record<string, any>;

/** ConfigMaps and pods as local folders and workerd processes. */
class ProcessKube implements KubeApi {
  private readonly cms = new Map<string, Obj>();
  readonly procs = new Map<string, { proc: WorkerdProcess; dir: string }>();
  constructor(private readonly healthPort: number) {}
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
    const vol = pod.spec.volumes[0].configMap;
    const cm = this.cms.get(vol.name);
    if (!cm) throw new Error(`no ConfigMap ${vol.name}`);
    const dir = mkdtempSync(join(tmpdir(), "wz-orch-"));
    for (const { key, path } of vol.items as { key: string; path: string }[]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), cm.data[key]);
    }
    const file = join(dir, "config.capnp");
    const proc = await startWorkerd({ dir, file, cleanup: () => {} }, this.healthPort);
    this.procs.set(pod.metadata.name, { proc, dir });
  }
  async deletePod(name: string) {
    const p = this.procs.get(name);
    this.procs.delete(name);
    await p?.proc.stop();
    if (p) rmSync(p.dir, { recursive: true, force: true });
  }
  async getPod(name: string): Promise<KubePodStatus | null> {
    return this.procs.has(name)
      ? { name, phase: "Running", ready: true, podIP: "127.0.0.1", reason: null, labels: {} }
      : null;
  }
  async listPods() {
    return [];
  }
}

describe.skipIf(!E2E)("SandboxOrchestrator → ConfigMap → workerd (CI sandbox job)", () => {
  let rpcServer: Awaited<ReturnType<typeof startRpcServer>>;
  let kube: ProcessKube;
  let o: SandboxOrchestrator;

  beforeAll(async () => {
    const rpc = new SandboxRpc({ key: KEY });
    rpcServer = await startRpcServer(rpc);
    const base = await freePortRange(3);
    kube = new ProcessKube(base);
    o = new SandboxOrchestrator({
      kube,
      rpc,
      owner: "runtime",
      namespace: "wizard-sandbox",
      image: "unused",
      rpcAddress: `127.0.0.1:${rpcServer.port}`,
      listenHost: "127.0.0.1",
      healthPort: base,
      basePort: base + 1,
      systemsPerPod: 2,
      pollMs: 100,
    });
  }, 60_000);

  afterAll(async () => {
    for (const name of [...kube.procs.keys()]) await kube.deletePod(name);
    await rpcServer?.close();
  });

  it("a system's functions load and run from the ConfigMap layout; a new revision replaces the pod", async () => {
    await o.prepare({
      systemId: "probe_a",
      env: "draft",
      entities: ["ticket"],
      functionsSource: PROBE_BUNDLE,
    });
    const ex = o.executorFor({ systemId: "probe_a", env: "draft", entities: ["ticket"] });
    expect(Object.keys(await ex.functions()).sort()).toEqual([...PROBE_FUNCTIONS].sort());
    const facts = (await ex.run("facts", "query", {}, USER, new Date(), {}, 10_000)) as Record<
      string,
      unknown
    >;
    expect(facts.process).toBe("undefined");
    const first = [...kube.procs.keys()];
    await o.prepare({
      systemId: "probe_a",
      env: "draft",
      entities: ["ticket"],
      functionsSource: `${PROBE_BUNDLE}\n// revision 2`,
    });
    expect([...kube.procs.keys()]).not.toEqual(first);
    expect(kube.procs.size).toBe(1);
    expect(Object.keys(await ex.functions()).sort()).toEqual([...PROBE_FUNCTIONS].sort());
  }, 60_000);
});
