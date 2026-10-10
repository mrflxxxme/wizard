// V3-18 (pilot quota 2 pods × 10 slots): slots come back — collectIdle frees systems without calls (one with a call
// in flight stays), remove without resync starts no pod, the per-pod queues leave nothing behind; a system whose call
// failed first before its pod's workerd restarted (liveness, OOM) or went CrashLoopBackOff is excluded from the
// pod's config, its revision refused for quarantineMs, and the pod's other systems keep running.
import { describe, expect, it } from "vitest";
import { sandboxIdleFromEnv } from "../../src/sandbox/from-env.js";
import type { KubePodStatus } from "../../src/sandbox/kube.js";
import type { SandboxOrchestrator } from "../../src/sandbox/orchestrator.js";
import { call, FakeKube, make, type Obj, PodNet, sys } from "./fake-kube.js";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const HUNG = "Функция системы зависла или превысила лимит";
const MIN = 60_000;

/** The pods' container restarts and CrashLoopBackOff, set by the test. */
class RestartKube extends FakeKube {
  readonly restarts = new Map<string, number>();
  readonly crashLoop = new Set<string>();
  override async getPod(name: string): Promise<KubePodStatus | null> {
    const p = await super.getPod(name);
    if (!p) return p;
    return {
      ...p,
      restarts: this.restarts.get(name) ?? 0,
      ...(this.crashLoop.has(name) ? { reason: "CrashLoopBackOff", lastReason: "Error", exitCode: 1 } : {}),
    };
  }
}

/** PodNet whose calls to the listed system ports lose their connection (workerd killed mid-call). */
function brokenNet() {
  const net = new PodNet();
  const broken = new Set<string>();
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/__wizard/call") && broken.has(new URL(url).port))
      throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
    return net.fetch(url, init);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, broken };
}

const ex = (o: SandboxOrchestrator, id: string) =>
  o.executorFor({ systemId: id, env: "draft", entities: [] });
const onlyPod = (kube: FakeKube) => {
  expect(kube.pods.size).toBe(1);
  return [...kube.pods.keys()][0] as string;
};
/** Per-pod queue state (private): drained queues leave no entries. */
const queues = (o: SandboxOrchestrator) =>
  o as unknown as { locks: Map<string, unknown>; busy: Map<string, unknown> };

describe("SandboxOrchestrator: slots come back", () => {
  it("collectIdle frees idle systems without restarting their pod; a call in flight keeps its system", async () => {
    const kube = new FakeKube();
    const released: string[] = [];
    const o = make(kube, { systemsPerPod: 2, maxPods: 1 });
    o.onReleased((id, env) => released.push(`${id}:${env}`));
    await o.prepare(sys(A));
    await o.prepare(sys(B));
    await o.drained();
    await expect(o.prepare(sys(C))).rejects.toMatchObject({
      code: "FUNCTIONS_DISABLED",
      message: "Песочница заполнена: функции системы временно недоступны",
    });
    const lease = await o.lease(B, "draft", 1000);
    kube.t += 31 * MIN;
    const before = kube.calls.length;
    expect(await o.collectIdle({ draft: 30 * MIN })).toBe(1);
    expect(released).toEqual([`${A}:draft`]);
    expect(kube.calls.slice(before).filter((c) => c.startsWith("create pod"))).toEqual([]);
    expect(o.endpointOf(A, "draft")).toBeNull();
    expect(o.endpointOf(B, "draft")).not.toBeNull();
    await o.prepare(sys(C));
    expect(o.endpointOf(C, "draft")).not.toBeNull();
    lease.release();
    kube.t += 31 * MIN;
    expect(await call(ex(o, C))).toMatch(/^10\.42\.0\./);
    // C was just called: only B goes.
    expect(await o.collectIdle({ draft: 30 * MIN })).toBe(1);
    expect(released).toEqual([`${A}:draft`, `${B}:draft`]);
    expect(await o.collectIdle({})).toBe(0);
  });

  it("the last system's slot freed without resync removes its pod; the queues leave nothing behind", async () => {
    const kube = new FakeKube();
    const o = make(kube);
    await o.prepare(sys(A));
    await o.prepare(sys(B));
    await o.drained();
    const before = kube.calls.length;
    await o.remove(A, "draft", { resync: false });
    expect(kube.calls.slice(before)).toEqual([]);
    expect(await call(ex(o, B))).toMatch(/^10\.42\.0\./);
    await o.remove(B, "draft", { resync: false });
    expect(kube.pods.size).toBe(0);
    expect(kube.configMaps.size).toBe(0);
    expect(queues(o).locks.size).toBe(0);
    expect(queues(o).busy.size).toBe(0);
  });
});

describe("SandboxOrchestrator.remove of a system being removed", () => {
  it("settles with the running removal: its emptied pod is gone (unloadSystem, then G1's release)", async () => {
    const kube = new FakeKube();
    const o = make(kube);
    await o.prepare(sys(A));
    const lease = await o.lease(A, "draft", 1000);
    // The runtime's unload starts the removal without waiting; the pod drains the call in flight first.
    const first = o.remove(A, "draft", { resync: false });
    let second = false;
    const done = o.remove(A, "draft", { resync: false }).then(() => {
      second = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(second).toBe(false);
    expect(kube.pods.size).toBe(1);
    lease.release();
    await done;
    expect(kube.pods.size).toBe(0);
    expect(kube.configMaps.size).toBe(0);
    await first;
    expect(await o.remove(A, "draft")).toBeUndefined();
  });
});

describe("SandboxOrchestrator watchdog: a system that hangs or kills its pod", () => {
  it("restarted workerd: the system whose call failed first is excluded and quarantined; the others keep running", async () => {
    const kube = new RestartKube();
    const net = brokenNet();
    const logs: Obj[] = [];
    const released: string[] = [];
    const o = make(kube, { fetch: net.fetch, log: (l) => logs.push(l) });
    o.onReleased((id) => released.push(id));
    await o.prepare(sys(A));
    await o.prepare(sys(B));
    await o.drained();
    const exA = ex(o, A);
    const exB = ex(o, B);
    const pod = onlyPod(kube);
    const old = o.endpointOf(B, "draft");
    // A blocks the isolate: its call is the first to fail, B's call that came during the hang fails a second later.
    net.broken.add("9000");
    net.broken.add("9001");
    await expect(call(exA)).rejects.toMatchObject({ code: "INTERNAL" });
    kube.t += 1000;
    await expect(call(exB)).rejects.toMatchObject({ code: "INTERNAL" });
    net.broken.clear();
    // liveness killed workerd: the pod stays Running with one restart more.
    kube.restarts.set(pod, 1);
    await o.check();
    await o.drained();
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: "sandbox_pod_restarted", step: pod, systemId: A, env: "draft" }),
    );
    expect(logs).toContainEqual(expect.objectContaining({ msg: "sandbox_system_excluded", systemId: A }));
    expect(released).toEqual([A]);
    expect(kube.pods.has(pod)).toBe(false);
    const sources = [...kube.configMaps.values()].flatMap((c) => Object.keys(c.data as Obj));
    expect(sources.filter((k) => k.endsWith("functions.mjs"))).toHaveLength(1);
    expect(o.endpointOf(B, "draft")).not.toBe(old);
    expect(await call(exB)).toBe(new URL(o.endpointOf(B, "draft") ?? "").hostname);
    await expect(call(exA)).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED", message: HUNG });
    expect(() => ex(o, A)).toThrow(HUNG);
    await expect(o.prepare(sys(A))).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED", message: HUNG });
    // A new revision is not refused; neither is the same one after the quarantine.
    await o.prepare(sys(A, "export const f = 2;"));
    await o.remove(A, "draft");
    kube.t += 10 * MIN + 1;
    await o.prepare(sys(A));
    expect(await call(ex(o, A))).toMatch(/^10\.42\.0\./);
  });

  it("a restart nobody's call explains is logged once; nothing is excluded or restarted", async () => {
    const kube = new RestartKube();
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await o.prepare(sys(A));
    const pod = onlyPod(kube);
    kube.restarts.set(pod, 1);
    const before = kube.calls.length;
    await o.check();
    await o.check();
    expect(logs.filter((l) => l.msg === "sandbox_pod_restarted")).toHaveLength(1);
    expect(logs.filter((l) => l.msg === "sandbox_system_excluded")).toHaveLength(0);
    expect(kube.calls.slice(before)).toEqual([]);
    expect(await call(ex(o, A))).toBe("10.42.0.10");
  });

  it("a failure older than the strike window blames nobody", async () => {
    const kube = new RestartKube();
    const net = brokenNet();
    const logs: Obj[] = [];
    const o = make(kube, { fetch: net.fetch, log: (l) => logs.push(l) });
    await o.prepare(sys(A));
    net.broken.add("9000");
    await expect(call(ex(o, A))).rejects.toMatchObject({ code: "INTERNAL" });
    net.broken.clear();
    kube.t += 5 * MIN;
    kube.restarts.set(onlyPod(kube), 1);
    await o.check();
    expect(logs.filter((l) => l.msg === "sandbox_system_excluded")).toHaveLength(0);
    expect(await call(ex(o, A))).toBe("10.42.0.10");
  });

  it("CrashLoopBackOff with nobody to blame: the pod is recreated", async () => {
    const kube = new RestartKube();
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await o.prepare(sys(A));
    const pod = onlyPod(kube);
    kube.crashLoop.add(pod);
    kube.restarts.set(pod, 4);
    await o.check();
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: "sandbox_pod_lost",
        step: pod,
        reason: "CrashLoopBackOff, last Error exit 1, restarts 4",
      }),
    );
    expect(kube.pods.has(pod)).toBe(false);
    expect(await call(ex(o, A))).toBe("10.42.0.11");
  });

  it("the only system of a pod excluded: its pod and ConfigMaps go", async () => {
    const kube = new RestartKube();
    const net = brokenNet();
    const o = make(kube, { fetch: net.fetch });
    await o.prepare(sys(A));
    net.broken.add("9000");
    await expect(call(ex(o, A))).rejects.toMatchObject({ code: "INTERNAL" });
    kube.crashLoop.add(onlyPod(kube));
    await o.check();
    expect(kube.pods.size).toBe(0);
    expect(kube.configMaps.size).toBe(0);
    expect(queues(o).locks.size).toBe(0);
  });
});

describe("sandboxIdleFromEnv", () => {
  it("drafts after 30 min, published systems after a day; 0 turns an env off", () => {
    expect(sandboxIdleFromEnv({})).toEqual({ draft: 30 * MIN, prod: 1440 * MIN });
    expect(
      sandboxIdleFromEnv({ WIZARD_SANDBOX_IDLE_DRAFT_MIN: "5", WIZARD_SANDBOX_IDLE_PROD_MIN: "0" }),
    ).toEqual({ draft: 5 * MIN, prod: 0 });
    expect(sandboxIdleFromEnv({ WIZARD_SANDBOX_IDLE_DRAFT_MIN: "x" }).draft).toBe(30 * MIN);
  });
});
