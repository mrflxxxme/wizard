// V3-18: one system whose Worker makes workerd exit at load (a module that throws while evaluated) never takes its
// pod's other systems down: each prepare starts the pod with the sources that already started plus its own; a failed
// one is unplaced (new) or keeps the revision that ran (update). The pod's state reaches the log line of a failed start.
import { describe, expect, it } from "vitest";
import { kubeApi } from "../../src/sandbox/kube.js";
import { podReason } from "../../src/sandbox/pod-start.js";
import { call, FakeKube, make, type Obj, sys } from "./fake-kube.js";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const AT_LOAD = 'throw new Error("at load");\nexport const f = 1;';

/** workerd over the pod's ConfigMaps: a module throwing at load makes the container exit (CrashLoopBackOff). */
class WorkerdKube extends FakeKube {
  override async getPod(name: string) {
    const p = await super.getPod(name);
    const pod = this.pods.get(name);
    if (!p || !pod) return p;
    const texts = (pod.spec.volumes[0].projected.sources as Obj[]).flatMap((s) =>
      Object.values(this.configMaps.get(s.configMap.name)?.data ?? {}),
    );
    return texts.some((t) => String(t).startsWith("throw "))
      ? {
          ...p,
          phase: "Running",
          ready: false,
          podIP: null,
          reason: "CrashLoopBackOff",
          lastReason: "Error",
          exitCode: 1,
          restarts: 1,
        }
      : p;
  }
}

/** Functions sources in the config of every pod left. */
const running = (kube: FakeKube) =>
  [...kube.configMaps.values()].flatMap((c) =>
    Object.entries(c.data as Record<string, string>)
      .filter(([k]) => k.endsWith("functions.mjs"))
      .map(([, v]) => v),
  );

describe("SandboxOrchestrator: a system that kills workerd at load", () => {
  it("a new one is rejected alone, named in the log; the pod's systems keep running and later ones join", async () => {
    const kube = new WorkerdKube();
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await o.prepare(sys(A));
    const ex = o.executorFor({ systemId: A, env: "draft", entities: [] });
    await expect(o.prepare(sys(B, AT_LOAD))).rejects.toMatchObject({
      code: "FUNCTIONS_DISABLED",
      message: "Код системы не запускается в песочнице",
    });
    expect(() => o.executorFor({ systemId: B, env: "draft", entities: [] })).toThrow();
    expect(await call(ex)).toBe("10.42.0.10");
    await o.prepare(sys(C));
    await o.drained();
    expect(running(kube)).not.toContain(AT_LOAD);
    expect(o.endpointOf(C, "draft")).toMatch(/:9001$/);
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "sandbox_pod_failed",
        level: "error",
        systemId: B,
        env: "draft",
        reason: "CrashLoopBackOff, last Error exit 1, restarts 1",
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "sandbox_system_rejected",
        systemId: B,
        reason: "crashed",
        mode: "unplaced",
      }),
    );
    await o.remove(A, "draft");
    await o.remove(C, "draft");
    expect(kube.pods.size).toBe(0);
    expect(kube.configMaps.size).toBe(0);
  });

  it("prepares queued together: each starts with its own source only, so the good one is not failed by the bad one", async () => {
    const kube = new WorkerdKube();
    const o = make(kube);
    await o.prepare(sys(A));
    const [bad, good] = await Promise.allSettled([o.prepare(sys(B, AT_LOAD)), o.prepare(sys(C))]);
    expect(bad.status).toBe("rejected");
    expect(good.status).toBe("fulfilled");
    expect(o.endpointOf(C, "draft")).not.toBeNull();
  });

  it("an update that crashes keeps the revision that ran; the pod's next config still has it", async () => {
    const kube = new WorkerdKube();
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await o.prepare(sys(A));
    await expect(o.prepare(sys(A, AT_LOAD))).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED" });
    const ex = o.executorFor({ systemId: A, env: "draft", entities: [] });
    expect(await call(ex)).toBe("10.42.0.10");
    await o.prepare(sys(B));
    await o.drained();
    expect(running(kube).sort()).toEqual(["export const f = 1;", "export const f = 1;"]);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: "sandbox_system_rejected", systemId: A, mode: "kept_previous" }),
    );
  });

  it("the last system's failed start leaves no pod and no ConfigMaps", async () => {
    const kube = new WorkerdKube();
    const o = make(kube);
    await expect(o.prepare(sys(A, AT_LOAD))).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED" });
    await o.drained();
    expect(kube.pods.size).toBe(0);
    expect(kube.configMaps.size).toBe(0);
    await o.prepare(sys(A));
    expect(o.endpointOf(A, "draft")).not.toBeNull();
  });
});

describe("pod state in the log", () => {
  it("kubeApi reads the last termination, restarts and an unschedulable pod; podReason joins them", async () => {
    const k = kubeApi("wizard-sandbox", async () => ({
      status: 200,
      body: {
        metadata: { name: "p" },
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "False" }],
          containerStatuses: [
            {
              state: { waiting: { reason: "CrashLoopBackOff" } },
              lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
              restartCount: 3,
            },
          ],
        },
      },
    }));
    const p = await k.getPod("p");
    expect(p).toMatchObject({
      reason: "CrashLoopBackOff",
      lastReason: "OOMKilled",
      exitCode: 137,
      restarts: 3,
    });
    expect(podReason(p as NonNullable<typeof p>)).toBe(
      "CrashLoopBackOff, last OOMKilled exit 137, restarts 3",
    );
    const pending = kubeApi("wizard-sandbox", async () => ({
      status: 200,
      body: {
        metadata: { name: "q" },
        status: {
          phase: "Pending",
          conditions: [{ type: "PodScheduled", status: "False", reason: "Unschedulable" }],
        },
      },
    }));
    const q = await pending.getPod("q");
    expect(podReason(q as NonNullable<typeof q>)).toBe("Pending, Unschedulable");
  });

  it("a start that times out says in what state the pod was", async () => {
    const kube = new FakeKube();
    kube.readyAfter = 1e9;
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l), readyTimeoutMs: 2000, podStartMs: 1000 });
    await expect(o.prepare(sys(A))).rejects.toMatchObject({
      message: "Песочница функций не запустилась вовремя",
    });
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: "sandbox_pod_timeout", level: "error", systemId: A, reason: "Pending" }),
    );
  });
});
