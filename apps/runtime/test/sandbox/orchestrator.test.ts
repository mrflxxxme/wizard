// M2-18: SandboxOrchestrator against a fake Kubernetes API — placement, ConfigMap + pod per config hash, replacement
// after readiness, stuck pods, quota, reconcile, watchdog; sandboxFromEnv. Calls across a pod (re)start:
// orchestrator-swap.test.ts.
import { describe, expect, it } from "vitest";
import { sandboxFromEnv, sandboxKey } from "../../src/sandbox/from-env.js";
import { KubeError } from "../../src/sandbox/kube.js";
import { CONFIGMAP_BUDGET, SandboxOrchestrator } from "../../src/sandbox/orchestrator.js";
import { FakeKube, make, type Obj, sys } from "./fake-kube.js";

describe("SandboxOrchestrator", () => {
  it("first prepare: ConfigMap with the workerd config, a hardened gVisor pod on the free pool, then the endpoint", async () => {
    const kube = new FakeKube();
    const o = make(kube);
    expect(o.endpointOf("aaaaaaaaaaaa", "draft")).toBeNull();
    expect(() => o.executorFor({ systemId: "aaaaaaaaaaaa", env: "draft", entities: [] })).toThrow();
    await o.prepare(sys("aaaaaaaaaaaa"));
    const [pod] = [...kube.pods.values()];
    // Shared files in the pod's ConfigMap, each system slot in its own (the 1 MiB limit holds per system).
    const cm = kube.configMaps.get(pod?.metadata.name);
    const slot = kube.configMaps.get(`${pod?.metadata.name}-s0`);
    expect(kube.configMaps.size).toBe(2);
    expect(cm?.immutable).toBe(true);
    expect(Object.keys(cm?.data ?? {})).toEqual(
      expect.arrayContaining(["config.capnp", "worker-host.mjs", "guest.mjs"]),
    );
    expect(cm?.data["config.capnp"]).toContain('address = "10.42.0.5:4101"');
    expect(slot?.data).toEqual({ "s0__functions.mjs": "export const f = 1;" });
    expect(pod?.metadata.labels).toMatchObject({
      "wizard.ru/sandbox-owner": "runtime",
      "wizard.ru/sandbox-pod": "sandbox-free-1",
      "app.kubernetes.io/name": "wizard-sandbox",
    });
    expect(pod?.spec.runtimeClassName).toBe("gvisor");
    expect(pod?.spec.nodeSelector).toEqual({ "wizard.ru/pool": "free" });
    expect(pod?.spec.automountServiceAccountToken).toBe(false);
    expect(pod?.spec.containers[0].resources.limits.memory).toBe("512Mi");
    expect(pod?.spec.containers[0].ports.map((p: Obj) => p.containerPort)).toEqual([9000, 9001, 9002, 8999]);
    const sources = pod?.spec.volumes[0].projected.sources.map((x: Obj) => x.configMap);
    expect(sources.map((x: Obj) => x.name)).toEqual([pod?.metadata.name, `${pod?.metadata.name}-s0`]);
    expect(sources[0].items).toContainEqual({ key: "config.capnp", path: "config.capnp" });
    expect(sources[1].items).toEqual([{ key: "s0__functions.mjs", path: "s0/functions.mjs" }]);
    expect(o.endpointOf("aaaaaaaaaaaa", "draft")).toBe("http://10.42.0.10:9000");
  });

  it("same source → nothing new; a new revision → new pod, the old one removed after the new is ready", async () => {
    const kube = new FakeKube();
    const o = make(kube);
    await o.prepare(sys("aaaaaaaaaaaa"));
    const first = [...kube.pods.keys()];
    await o.prepare(sys("aaaaaaaaaaaa"));
    expect([...kube.pods.keys()]).toEqual(first);
    kube.calls.length = 0;
    await o.prepare(sys("aaaaaaaaaaaa", "export const f = 2;"));
    // The old pod drains in the background (outside the pod's queue).
    await o.drained();
    const created = kube.calls.findIndex((c) => c.startsWith("create pod"));
    const deleted = kube.calls.indexOf(`delete pod ${first[0]}`);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(created);
    expect(kube.pods.size).toBe(1);
    expect(kube.configMaps.size).toBe(2);
    expect(o.endpointOf("aaaaaaaaaaaa", "draft")).toBe("http://10.42.0.11:9000");
  });

  it("systems share a pod up to systemsPerPod, each on its slot's port; then a second pod", async () => {
    const kube = new FakeKube();
    const o = make(kube, { systemsPerPod: 2 });
    await o.prepare(sys("aaaaaaaaaaaa"));
    await o.prepare(sys("bbbbbbbbbbbb"));
    await o.drained();
    expect(kube.pods.size).toBe(1);
    expect([...kube.configMaps.keys()].filter((n) => /-s\d$/.test(n))).toHaveLength(2);
    expect(o.endpointOf("bbbbbbbbbbbb", "draft")).toMatch(/:9001$/);
    await o.prepare(sys("cccccccccccc"));
    expect(kube.pods.size).toBe(2);
    expect(o.endpointOf("cccccccccccc", "draft")).toMatch(/:9000$/);
    await o.remove("cccccccccccc", "draft");
    expect(kube.pods.size).toBe(1);
    expect(o.endpointOf("cccccccccccc", "draft")).toBeNull();
  });

  it("a pod that cannot start fails the call with FUNCTIONS_DISABLED and leaves nothing behind", async () => {
    const kube = new FakeKube();
    kube.stuck = "ImagePullBackOff";
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await expect(o.prepare(sys("aaaaaaaaaaaa"))).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED" });
    expect(kube.pods.size).toBe(0);
    expect(kube.configMaps.size).toBe(0);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: "sandbox_pod_failed", reason: "ImagePullBackOff" }),
    );
    kube.stuck = null;
    kube.readyAfter = 1000;
    await expect(o.prepare(sys("aaaaaaaaaaaa"))).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED" });
    expect(kube.pods.size).toBe(0);
  });

  it("G1, no room for two pods in the quota: its old pod goes first (after quotaWaitMs), then the new one", async () => {
    const kube = new FakeKube();
    kube.podQuota = 1;
    const o = make(kube, { owner: "g1", inPlace: true });
    await o.prepare(sys("aaaaaaaaaaaa"));
    const t0 = kube.t;
    await o.prepare(sys("aaaaaaaaaaaa", "export const f = 3;"));
    expect(kube.t - t0).toBeGreaterThanOrEqual(10_000);
    expect(kube.pods.size).toBe(1);
    expect(o.endpointOf("aaaaaaaaaaaa", "draft")).not.toBeNull();
  });

  it("an API server error becomes FUNCTIONS_DISABLED, logged", async () => {
    const kube = new FakeKube();
    kube.createConfigMap = async () => {
      throw new KubeError(403, "configmaps is forbidden");
    };
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await expect(o.prepare(sys("aaaaaaaaaaaa"))).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED" });
    expect(logs).toContainEqual(expect.objectContaining({ msg: "sandbox_api_failed" }));
  });

  it("config over the ConfigMap budget is refused", async () => {
    const o = make(new FakeKube());
    await expect(o.prepare(sys("aaaaaaaaaaaa", "x".repeat(CONFIGMAP_BUDGET + 1)))).rejects.toMatchObject({
      code: "FUNCTIONS_DISABLED",
    });
  });

  it("reconcile removes only this owner's objects; the watchdog recreates a lost pod", async () => {
    const kube = new FakeKube();
    kube.pods.set("other", { metadata: { name: "other", labels: { "wizard.ru/sandbox-owner": "g1-x" } } });
    kube.pods.set("stale", { metadata: { name: "stale", labels: { "wizard.ru/sandbox-owner": "runtime" } } });
    kube.configMaps.set("stale", {
      metadata: { name: "stale", labels: { "wizard.ru/sandbox-owner": "runtime" } },
    });
    const o = make(kube);
    expect(await o.reconcile()).toBe(1);
    expect([...kube.pods.keys()]).toEqual(["other"]);
    expect(kube.configMaps.size).toBe(0);
    await o.prepare(sys("aaaaaaaaaaaa"));
    const [name] = [...kube.pods.keys()].filter((n) => n !== "other");
    kube.pods.delete(name as string);
    await o.check();
    // Recreated under a name of its own; the lost pod's ConfigMaps are gone with it.
    const again = [...kube.pods.keys()].filter((n) => n !== "other");
    expect(again).toHaveLength(1);
    expect(again[0]).not.toBe(name);
    expect([...kube.configMaps.keys()].every((n) => n.startsWith(again[0] as string))).toBe(true);
    expect(o.endpointOf("aaaaaaaaaaaa", "draft")).not.toBeNull();
  });

  it("executorFor talks to the pod's socket of the system", async () => {
    const kube = new FakeKube();
    const urls: string[] = [];
    const o = make(kube, {
      fetch: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ list: { kind: "query", args: {} } }));
      }) as unknown as typeof fetch,
    });
    await o.prepare(sys("aaaaaaaaaaaa"));
    const ex = o.executorFor({ systemId: "aaaaaaaaaaaa", env: "draft", entities: ["Post"] });
    expect(await ex.functions()).toEqual({ list: { kind: "query", args: {} } });
    // The reachability probe of the new pod, then the call.
    expect(urls).toEqual([
      "http://10.42.0.10:9000/__wizard/health",
      "http://10.42.0.10:9000/__wizard/functions",
    ]);
  });
});

describe("sandboxFromEnv", () => {
  const kube = new FakeKube();
  it("off unless WIZARD_SANDBOX=k8s; k8s needs the image and the RPC address", () => {
    expect(sandboxFromEnv({})).toBeNull();
    expect(sandboxFromEnv({ WIZARD_SANDBOX: "off" })).toBeNull();
    expect(() => sandboxFromEnv({ WIZARD_SANDBOX: "docker" })).toThrow(/off \| k8s/);
    expect(() =>
      sandboxFromEnv({ WIZARD_SANDBOX: "k8s", WIZARD_INTERNAL_TOKEN: "t".repeat(32) }, { kube }),
    ).toThrow(/WIZARD_SANDBOX_IMAGE/);
    const s = sandboxFromEnv(
      {
        WIZARD_SANDBOX: "k8s",
        WIZARD_SANDBOX_IMAGE: "img",
        WIZARD_SANDBOX_RPC_ADDRESS: "10.42.0.5:4101",
        WIZARD_INTERNAL_TOKEN: "t".repeat(32),
      },
      { kube },
    );
    expect(s?.orchestrator).toBeInstanceOf(SandboxOrchestrator);
  });
  it("the capability key: explicit hex, else derived from the internal token (32 bytes, stable)", () => {
    expect(Buffer.from(sandboxKey({ WIZARD_SANDBOX_KEY: "ab".repeat(32) })).toString("hex")).toBe(
      "ab".repeat(32),
    );
    expect(() => sandboxKey({ WIZARD_SANDBOX_KEY: "zz" })).toThrow();
    const a = sandboxKey({ WIZARD_INTERNAL_TOKEN: "x".repeat(40) });
    expect(a.byteLength).toBe(32);
    expect(sandboxKey({ WIZARD_INTERNAL_TOKEN: "x".repeat(40) })).toEqual(a);
    expect(() => sandboxKey({})).toThrow(/WIZARD_INTERNAL_TOKEN/);
  });
});
