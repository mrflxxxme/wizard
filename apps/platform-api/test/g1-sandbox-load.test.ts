// V3-18 (pilot 2026-10-09, v3 checkpoint: 5 briefs, 2 builds at a time, WIZARD_SANDBOX=k8s): after one build's page
// code started to throw at module load, every later G1 of both builds failed — «песочница отрисовки не запустилась»,
// «Песочница функций была недоступна» — and a pool pod of G1 stayed behind. The G1 host (startG1Sandbox) under the v3
// load: two builds in parallel, each G1 run loads its system and a lane (the runtime prepares their functions), renders
// the pages in its render Worker, calls the functions, then closes the renderer and releases its systems.
import type { KubeApi, KubePodStatus } from "@wizard/runtime";
import { describe, expect, it } from "vitest";
import { type G1Sandbox, renderWorkerId, startG1Sandbox } from "../src/agents/g1-sandbox.js";

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects as the orchestrator renders them
type Obj = Record<string, any>;

/**
 * The sandbox namespace; a pod runs workerd over its ConfigMaps. workerd exits at load when any Worker's module calls
 * a timer at module scope («Disallowed operation called within global scope», checked with workerd 2026-09-30): the
 * container restarts and goes CrashLoopBackOff, whichever systems share the pod.
 */
class WorkerdKube implements KubeApi {
  readonly cms = new Map<string, Obj>();
  readonly pods = new Map<string, Obj & { ip: string }>();
  private ip = 10;
  /** Each API call yields: the two builds interleave as they do against a real API server. */
  private readonly tick = () => new Promise<void>((r) => setImmediate(r));

  async createConfigMap(cm: Obj) {
    await this.tick();
    this.cms.set(cm.metadata.name, cm);
  }
  async deleteConfigMap(name: string) {
    await this.tick();
    this.cms.delete(name);
  }
  async listConfigMaps() {
    return [...this.cms.keys()];
  }
  async createPod(pod: Obj) {
    await this.tick();
    this.pods.set(pod.metadata.name, { ...pod, ip: `10.42.0.${this.ip++}` });
  }
  async deletePod(name: string) {
    await this.tick();
    this.pods.delete(name);
  }
  private crashes(pod: Obj): boolean {
    for (const { configMap } of pod.spec.volumes[0].projected.sources as Obj[])
      for (const text of Object.values(this.cms.get(configMap.name)?.data ?? {}))
        if (/^setInterval\(/m.test(String(text))) return true;
    return false;
  }
  async getPod(name: string): Promise<KubePodStatus | null> {
    await this.tick();
    const p = this.pods.get(name);
    if (!p) return null;
    const base = { name, phase: "Running", podIP: p.ip, labels: p.metadata.labels };
    return this.crashes(p)
      ? { ...base, ready: false, reason: "CrashLoopBackOff", lastReason: "Error", exitCode: 1, restarts: 2 }
      : { ...base, ready: true, reason: null };
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
const PAGES_OK = "globalThis.__wzApp = { pages: 1 };\n";
/** A page that starts its carousel at module scope: fine in Node, fatal for workerd at load. */
const PAGES_TIMER_AT_LOAD = "setInterval(() => {}, 5000);\nglobalThis.__wzApp = { pages: 1 };\n";

interface RunOutcome {
  functions: boolean;
  render: true | string;
}

/** One G1 run of a v3 build as the G1 host sees it (executors.gates + the runtime's loadSystem + renderPages). */
async function g1Run(sb: G1Sandbox, build: string, run: number, pages: string): Promise<RunOutcome> {
  const key = `sys${build}_g1_${run}`;
  const loaded = [key, `${key}_lane1`];
  const out: RunOutcome = { functions: true, render: true };
  for (const id of loaded)
    await sb.orchestrator
      .prepare({ systemId: id, env: "draft", entities: ["Post"], functionsSource: "export const f = 1;" })
      .catch(() => {
        out.functions = false;
      });
  try {
    const renderer = await sb.renderer({ key, code: pages });
    if (!sb.orchestrator.endpointOf(renderWorkerId(key), "draft")) out.render = "not routed";
    await renderer.close();
  } catch (e) {
    out.render = (e as Error).message;
  }
  for (const id of loaded) {
    try {
      const lease = await sb.orchestrator.lease(id, "draft", 5000);
      lease.release();
    } catch {
      out.functions = false;
    }
  }
  // executors.gates: the sandbox pods of the gate's systems go with them (a failure there is not the gate's).
  await sb.release(loaded).catch(() => {});
  return out;
}

describe("G1 host in the sandbox under the v3 load (V3-18)", () => {
  it("one build's page Worker that kills workerd at load fails only its renders; the other build and its functions run, nothing is left", async () => {
    const kube = new WorkerdKube();
    const logs: Obj[] = [];
    const sb = await startG1Sandbox(ENV, {
      kube,
      fetch: (async () => new Response("ok")) as unknown as typeof fetch,
      log: (l) => logs.push(l),
    });
    if (!sb) throw new Error("sandbox expected");
    try {
      const RUNS = 6; // the brief scenarios' checks and the final gates of a v3 build
      const build = async (name: string, pagesOf: (run: number) => string) => {
        const outs: RunOutcome[] = [];
        for (let run = 0; run < RUNS; run++) outs.push(await g1Run(sb, name, run, pagesOf(run)));
        return outs;
      };
      const [a, b] = await Promise.all([
        // Build A: its pages start a timer at module scope from the third scenario on.
        build("a", (run) => (run < 2 ? PAGES_OK : PAGES_TIMER_AT_LOAD)),
        build("b", () => PAGES_OK),
      ]);
      await sb.orchestrator.drained();

      // Before: from A's first such render on, the pod shared with B never started again — B's G1 failed too.
      expect(b).toEqual(Array.from({ length: RUNS }, () => ({ functions: true, render: true })));
      expect(a.slice(0, 2)).toEqual([
        { functions: true, render: true },
        { functions: true, render: true },
      ]);
      for (const r of a.slice(2))
        expect(r).toEqual({ functions: true, render: "Код системы не запускается в песочнице" });

      // Before: the failed render Worker stayed placed; its pool pod and its last good pod stayed (one Running pod).
      expect([...kube.pods.keys()]).toEqual([]);
      expect([...kube.cms.keys()]).toEqual([]);

      // kubectl logs of the worker say which system's start failed, how the pod ended, and what happened to it.
      const bad = renderWorkerId("sysa_g1_2");
      expect(logs).toContainEqual(
        expect.objectContaining({
          msg: "sandbox_pod_failed",
          level: "error",
          systemId: bad,
          env: "draft",
          step: expect.stringMatching(/^wz-g1-free-\d+-[0-9a-f]{10}-[0-9a-f]{6}$/),
          reason: "CrashLoopBackOff, last Error exit 1, restarts 2",
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          msg: "sandbox_system_rejected",
          level: "error",
          systemId: bad,
          reason: "crashed",
          mode: "unplaced",
        }),
      );
      const rejected = logs.filter((l) => l.msg === "sandbox_system_rejected").map((l) => l.systemId);
      expect(rejected.every((id) => id.startsWith("r_"))).toBe(true);
      expect(rejected).toHaveLength(RUNS - 2);
    } finally {
      await sb.close();
    }
  }, 60_000);
});
