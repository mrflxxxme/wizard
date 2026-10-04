// M2-18/M2-19: calls across a sandbox pod (re)start. G1 on the pilot (sandbox.maxPods=1, a 3-pod namespace quota shared
// with the runtime) puts its functions bundle and its render Worker into the only pod, so the render Worker's prepare
// replaces the pod the functions run in: these were the 503 FUNCTIONS_DISABLED «Функции системы не загружены» /
// «Песочница функций недоступна» of one scenario per G1. Fake clock and fake network: every interleaving is fixed.
import { describe, expect, it } from "vitest";
import { SandboxRpc } from "../../src/sandbox/rpc.js";
import { WorkerdExecutor } from "../../src/sandbox/workerd-executor.js";
import { call, FakeKube, make, type Obj, PodNet, sys, until } from "./fake-kube.js";

const A = "aaaaaaaaaaaa";
const execA = (o: ReturnType<typeof make>) =>
  o.executorFor({ systemId: A, env: "draft", entities: ["Post"] });

describe("SandboxOrchestrator: calls across a pod (re)start", () => {
  it("a pod Ready for the kubelet but not yet reachable from this process gets no calls until it answers", async () => {
    const kube = new FakeKube();
    const net = new PodNet();
    net.lag = 3;
    const logs: Obj[] = [];
    const o = make(kube, { fetch: net.fetch, log: (l) => logs.push(l) });
    await o.prepare(sys(A));
    // Before: prepare returned at Ready and the first functions() load hit the refused connection.
    expect(await execA(o).functions()).toEqual({ f: { kind: "query", args: {} } });
    expect(net.urls.filter((u) => u.endsWith("/__wizard/health"))).toHaveLength(4);
    expect(logs).toContainEqual(expect.objectContaining({ msg: "sandbox_pod_unreachable" }));
  });

  // A deleted pod may keep counting against the quota for `lag` ms more.
  it.each([0, 1000])(
    "G1, no room for 2 pods (lag %i ms): a call in the swap waits for the new pod",
    async (lag) => {
      const kube = new FakeKube();
      kube.podQuota = 1;
      kube.quotaLagMs = lag;
      kube.readyAfter = 3;
      const logs: Obj[] = [];
      const o = make(kube, {
        owner: "g1",
        inPlace: true,
        systemsPerPod: 10,
        maxPods: 1,
        log: (l) => logs.push(l),
      });
      await o.prepare(sys(A));
      const ex = execA(o);
      await ex.functions();
      const [old] = [...kube.pods.keys()];
      let during: Promise<unknown> | undefined;
      kube.onDelete = (name) => {
        if (name === old && !during) during = call(ex);
      };
      // The render Worker joins the only pod: new config → new pod; the quota leaves no room for both.
      await o.prepare({ ...sys("r_0123456789abcdef0123"), entities: [] });
      expect(during).toBeDefined();
      expect([...kube.pods.keys()]).not.toContain(old);
      // Before: «Функции системы не загружены» (no endpoint in the gap), or the create right after the delete was
      // refused by the quota still holding the old pod («Песочница функций недоступна»).
      await expect(during).resolves.toBe(new URL(o.endpointOf(A, "draft") as string).hostname);
      expect(logs).toContainEqual(expect.objectContaining({ msg: "sandbox_replace_in_place", step: old }));
      expect(logs).not.toContainEqual(expect.objectContaining({ msg: "sandbox_api_failed" }));
    },
  );

  it("the runtime never takes its live pod down for a restart: no room → the new revision fails, the old serves", async () => {
    const kube = new FakeKube();
    kube.podQuota = 1;
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await o.prepare(sys(A));
    const [old] = [...kube.pods.keys()];
    const ex = execA(o);
    await expect(o.prepare(sys(A, "export const f = 2;"))).rejects.toMatchObject({
      code: "FUNCTIONS_DISABLED",
      message: expect.stringMatching(/заполнена/),
    });
    expect([...kube.pods.keys()]).toEqual([old]);
    expect(kube.calls).not.toContain(`delete pod ${old}`);
    expect(kube.configMaps.size).toBe(2);
    expect(await call(ex)).toBe("10.42.0.10");
    expect(logs).not.toContainEqual(expect.objectContaining({ msg: "sandbox_replace_in_place" }));
  });

  it("the runtime waits out room held by G1's replacement past quotaWaitMs, still make-before-break", async () => {
    const kube = new FakeKube();
    kube.podQuota = 3;
    const o = make(kube, { readyTimeoutMs: 120_000 });
    await o.prepare(sys(A));
    const [old] = [...kube.pods.keys()];
    const g1 = { metadata: { name: "g1", labels: { "wizard.ru/sandbox-owner": "g1" } } };
    kube.pods.set("g1-old", g1);
    kube.pods.set("g1-new", g1);
    const t0 = kube.t;
    kube.onCreate = () => {
      if (kube.t - t0 >= 30_000) kube.pods.delete("g1-old");
    };
    await o.prepare(sys(A, "export const f = 2;"));
    await o.drained();
    const fresh = [...kube.pods.keys()].find((n) => n.startsWith("wz-"));
    expect(kube.calls.indexOf(`delete pod ${old}`)).toBeGreaterThan(
      kube.calls.lastIndexOf(`create pod ${fresh}`),
    );
    expect(kube.pods.has(old as string)).toBe(false);
    expect(o.endpointOf(A, "draft")).toBe("http://10.42.0.11:9000");
  });

  it("a quota that stays full and no pod to replace: FUNCTIONS_DISABLED, nothing left behind", async () => {
    const kube = new FakeKube();
    kube.podQuota = 0;
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await expect(o.prepare(sys(A))).rejects.toMatchObject({
      code: "FUNCTIONS_DISABLED",
      message: expect.stringMatching(/заполнена/),
    });
    expect(kube.configMaps.size).toBe(0);
    expect(logs).toContainEqual(expect.objectContaining({ msg: "sandbox_quota_full" }));
  });

  it("a replaced pod goes only after its call in flight, and the drain holds no queue", async () => {
    const kube = new FakeKube();
    const net = new PodNet();
    const o = make(kube, { fetch: net.fetch });
    await o.prepare(sys(A));
    const [old] = [...kube.pods.keys()];
    let open = () => {};
    net.hold = new Promise<void>((r) => {
      open = r;
    });
    const inFlight = call(execA(o));
    await until(() => net.urls.some((u) => u.endsWith("/__wizard/call")));
    await o.prepare(sys(A, "export const f = 2;"));
    expect(o.endpointOf(A, "draft")).toBe("http://10.42.0.11:9000");
    // The pod's queue is free while the old pod drains: another system joins meanwhile.
    await o.prepare(sys("bbbbbbbbbbbb"));
    expect(kube.pods.has(old as string)).toBe(true);
    open();
    expect(await inFlight).toBe("10.42.0.10");
    await o.drained();
    expect(kube.pods.has(old as string)).toBe(false);
  });

  it("a system placed into a running pod is not routed there before that pod runs it", async () => {
    const kube = new FakeKube();
    kube.readyAfter = 3;
    const o = make(kube);
    await o.prepare(sys(A));
    const joining = o.prepare(sys("bbbbbbbbbbbb"));
    // Slot 1 of the old pod has no Worker: the call must not go there.
    expect(o.endpointOf("bbbbbbbbbbbb", "draft")).toBeNull();
    const r = call(o.executorFor({ systemId: "bbbbbbbbbbbb", env: "draft", entities: [] }));
    await joining;
    expect(await r).toBe("10.42.0.11");
  });

  it("an API error while waiting for the new pod leaves neither the pod nor its ConfigMaps", async () => {
    const kube = new FakeKube();
    kube.getPodError = new Error("connect ECONNRESET");
    const o = make(kube);
    await expect(o.prepare(sys(A))).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED" });
    expect(kube.pods.size).toBe(0);
    expect(kube.configMaps.size).toBe(0);
  });

  it("the watchdog runs in the pod's queue: a record switched meanwhile is not taken for lost", async () => {
    const kube = new FakeKube();
    const logs: Obj[] = [];
    const o = make(kube, { log: (l) => logs.push(l) });
    await o.prepare(sys(A));
    const [old] = [...kube.pods.keys()];
    kube.readyAfter = 5;
    const next = o.prepare(sys(A, "export const f = 2;"));
    await until(() => kube.pods.size === 2);
    kube.pods.delete(old as string);
    await o.check();
    await next;
    expect(logs).not.toContainEqual(expect.objectContaining({ msg: "sandbox_pod_lost" }));
    expect(kube.pods.size).toBe(1);
    expect(o.endpointOf(A, "draft")).toBe("http://10.42.0.11:9000");
  });

  it("a rollback to the config of a pod still draining gets a pod of its own, which stays", async () => {
    const kube = new FakeKube();
    const net = new PodNet();
    const o = make(kube, { fetch: net.fetch });
    await o.prepare(sys(A));
    let open = () => {};
    net.hold = new Promise<void>((r) => {
      open = r;
    });
    const inFlight = call(execA(o));
    await until(() => net.urls.some((u) => u.endsWith("/__wizard/call")));
    await o.prepare(sys(A, "export const f = 2;"));
    // Back to revision 1 while its pod still drains: before, the same name → 409 taken for «created», the record
    // switched to the draining pod, and its retire then deleted the pod in use.
    await o.prepare(sys(A));
    expect(o.endpointOf(A, "draft")).toBe("http://10.42.0.12:9000");
    open();
    await inFlight;
    await o.drained();
    const left = [...kube.pods.keys()];
    expect(left).toHaveLength(1);
    expect((await kube.getPod(left[0] as string))?.podIP).toBe("10.42.0.12");
  });

  it("a pod created late in the budget still gets podStartMs to come up", async () => {
    const kube = new FakeKube();
    kube.podQuota = 2;
    const o = make(kube);
    await o.prepare(sys(A));
    kube.pods.set("other", { metadata: { name: "other", labels: {} } });
    kube.readyAfter = 50; // 5 s of polls
    const t0 = kube.t;
    kube.onCreate = () => {
      if (kube.t - t0 >= 59_000) kube.pods.delete("other");
    };
    await o.prepare(sys(A, "export const f = 2;"));
    expect(kube.t - t0).toBeGreaterThan(60_000);
    expect(o.endpointOf(A, "draft")).toBe("http://10.42.0.11:9000");
  });

  it("G1 yields its pod, the runtime takes the room for its own swap: G1 waits for it to come back", async () => {
    const kube = new FakeKube();
    kube.podQuota = 2;
    const o = make(kube, { owner: "g1", inPlace: true, readyTimeoutMs: 120_000 });
    await o.prepare(sys(A));
    const [old] = [...kube.pods.keys()];
    kube.pods.set("rt-old", { metadata: { name: "rt-old", labels: {} } });
    let freedAt = Number.POSITIVE_INFINITY;
    kube.onDelete = (name) => {
      if (name !== old) return;
      kube.pods.set("rt-new", { metadata: { name: "rt-new", labels: {} } }); // the runtime grabs the room
      freedAt = kube.t + 40_000; // and returns one when its swap is done
    };
    kube.onCreate = () => {
      if (kube.t >= freedAt) kube.pods.delete("rt-old");
    };
    await o.prepare(sys(A, "export const f = 2;"));
    expect(o.endpointOf(A, "draft")).toBe("http://10.42.0.11:9000");
  });

  it("a created pod that vanishes fails at once; a lost pod's ConfigMaps go with it", async () => {
    const kube = new FakeKube();
    const o = make(kube);
    const getPod = kube.getPod.bind(kube);
    kube.getPod = async () => null;
    const t0 = kube.t;
    await expect(o.prepare(sys(A))).rejects.toMatchObject({ code: "FUNCTIONS_DISABLED" });
    expect(kube.t - t0).toBeLessThan(1000);
    kube.getPod = getPod;
    await o.prepare(sys(A));
    const [first] = [...kube.pods.keys()];
    kube.pods.clear();
    await o.check();
    const [now] = [...kube.pods.keys()];
    expect(now).not.toBe(first);
    expect([...kube.configMaps.keys()].every((n) => n.startsWith(now as string))).toBe(true);
  });

  it("a call with too little of its limit left after waiting for its pod is not started", async () => {
    const urls: string[] = [];
    let released = 0;
    const ex = new WorkerdExecutor({
      endpoint: () => null,
      lease: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { endpoint: "http://10.42.0.10:9000", release: () => (released += 1) };
      },
      systemId: A,
      env: "draft",
      rpc: new SandboxRpc({ key: new Uint8Array(32).fill(7) }),
      fetch: (async (url: string) => {
        urls.push(url);
        return Response.json({ ok: true, value: 1 });
      }) as unknown as typeof fetch,
    });
    const user = { id: null, role: "visitor", isAdmin: false, attrs: {} } as never;
    await expect(ex.run("f", "query", {}, user, new Date(), {} as never, 60)).rejects.toMatchObject({
      code: "FUNCTIONS_DISABLED",
      message: "Песочница функций перезапускается",
    });
    expect(urls).toEqual([]);
    expect(released).toBe(1);
  });
});
