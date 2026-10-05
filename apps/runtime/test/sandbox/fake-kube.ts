// Fakes of the SandboxOrchestrator unit tests (M2-18): the Kubernetes API of one namespace with a ResourceQuota, the
// pods' network as the orchestrating process sees it, and a fake clock shared by both, so every deadline is
// deterministic (no wall-clock time in these tests).
import type { CurrentUser } from "@wizard/sdk";
import { expect } from "vitest";
import { type KubeApi, KubeError, type KubePodStatus } from "../../src/sandbox/kube.js";
import { type OrchestratorOptions, SandboxOrchestrator } from "../../src/sandbox/orchestrator.js";
import { SandboxRpc } from "../../src/sandbox/rpc.js";

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects as the orchestrator renders them
export type Obj = Record<string, any>;

export class FakeKube implements KubeApi {
  readonly configMaps = new Map<string, Obj>();
  readonly pods = new Map<string, Obj>();
  readonly calls: string[] = [];
  /** Fake time (ms): advanced only by sleep(). */
  t = 0;
  readonly now = () => this.t;
  /** Advances the fake clock and yields to the event loop (other loops and the test's until() run). */
  readonly sleep = (ms: number) => {
    this.t += ms;
    return new Promise<void>((r) => setImmediate(r));
  };
  ip = 10;
  /** Polls before a new pod is ready; a reason makes it stuck. */
  readyAfter = 1;
  stuck: string | null = null;
  podQuota = Number.POSITIVE_INFINITY;
  /** A deleted pod still counts against podQuota this long (the quota releases its usage late). */
  quotaLagMs = 0;
  getPodError: Error | null = null;
  onCreate?: () => void;
  onDelete?: (name: string) => void;
  private ghosts: number[] = [];
  private polls = new Map<string, number>();
  private ips = new Map<string, string>();

  async createConfigMap(cm: Obj) {
    this.calls.push(`create cm ${cm.metadata.name}`);
    if (this.configMaps.has(cm.metadata.name)) throw new KubeError(409, "exists");
    this.configMaps.set(cm.metadata.name, cm);
  }
  async deleteConfigMap(name: string) {
    this.calls.push(`delete cm ${name}`);
    this.configMaps.delete(name);
  }
  async listConfigMaps(sel: string) {
    const [k, v] = sel.split("=");
    return [...this.configMaps.values()]
      .filter((c) => c.metadata.labels?.[k as string] === v)
      .map((c) => c.metadata.name);
  }
  async createPod(pod: Obj) {
    this.calls.push(`create pod ${pod.metadata.name}`);
    this.onCreate?.();
    if (this.pods.has(pod.metadata.name)) throw new KubeError(409, "exists");
    this.ghosts = this.ghosts.filter((until) => until > this.t);
    if (this.pods.size + this.ghosts.length >= this.podQuota)
      throw new KubeError(403, 'pods "x" is forbidden: exceeded quota: wizard-sandbox');
    this.pods.set(pod.metadata.name, pod);
    this.ips.set(pod.metadata.name, `10.42.0.${this.ip++}`);
  }
  async deletePod(name: string) {
    this.calls.push(`delete pod ${name}`);
    this.onDelete?.(name);
    if (this.pods.delete(name) && this.quotaLagMs) this.ghosts.push(this.t + this.quotaLagMs);
  }
  async getPod(name: string): Promise<KubePodStatus | null> {
    if (this.getPodError) throw this.getPodError;
    const pod = this.pods.get(name);
    if (!pod) return null;
    const n = (this.polls.get(name) ?? 0) + 1;
    this.polls.set(name, n);
    const ready = !this.stuck && n > this.readyAfter;
    return {
      name,
      phase: ready ? "Running" : "Pending",
      ready,
      podIP: ready ? (this.ips.get(name) ?? null) : null,
      reason: this.stuck,
      labels: pod.metadata.labels,
    };
  }
  async listPods(sel: string) {
    const [k, v] = sel.split("=");
    const out: KubePodStatus[] = [];
    for (const [name, p] of this.pods)
      if (p.metadata.labels?.[k as string] === v)
        out.push({
          name,
          phase: "Running",
          ready: true,
          podIP: null,
          reason: null,
          labels: p.metadata.labels,
        });
    return out;
  }
}

/**
 * The pods' network as this process sees it: a new pod address refuses `lag` connections first (its NetworkPolicy
 * rules are programmed after the kubelet reports it Ready); a call answers with the address that served it and may be
 * held open (`hold`).
 */
export class PodNet {
  lag = 0;
  readonly urls: string[] = [];
  private readonly refusing = new Map<string, number>();
  hold: Promise<void> | null = null;
  readonly fetch = (async (url: string) => {
    this.urls.push(url);
    const ip = new URL(url).hostname;
    if (!this.refusing.has(ip)) this.refusing.set(ip, this.lag);
    const left = this.refusing.get(ip) ?? 0;
    if (left > 0) {
      this.refusing.set(ip, left - 1);
      throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${ip}`) });
    }
    if (url.endsWith("/__wizard/functions")) return Response.json({ f: { kind: "query", args: {} } });
    if (url.endsWith("/__wizard/call")) {
      if (this.hold) await this.hold;
      return Response.json({ ok: true, value: ip });
    }
    return new Response("ok");
  }) as unknown as typeof fetch;
}

/** An orchestrator on the real clock and timers (no now/sleep given): what production runs. */
export const makeRealTime = (kube: FakeKube, o: Partial<OrchestratorOptions> = {}) =>
  new SandboxOrchestrator({
    kube,
    rpc: new SandboxRpc({ key: new Uint8Array(32).fill(7) }),
    owner: "runtime",
    namespace: "wizard-sandbox",
    image: "ghcr.io/o/wizard-sandbox:abc",
    rpcAddress: "10.42.0.5:4101",
    basePort: 9000,
    healthPort: 8999,
    systemsPerPod: 3,
    memoryLimit: "512Mi",
    pollMs: 100,
    readyTimeoutMs: 60_000,
    fetch: new PodNet().fetch,
    ...o,
  });

/** An orchestrator on the fake clock of `kube`. */
export const make = (kube: FakeKube, o: Partial<OrchestratorOptions> = {}) =>
  makeRealTime(kube, { now: kube.now, sleep: kube.sleep, ...o });

export const sys = (systemId: string, functionsSource = "export const f = 1;") => ({
  systemId,
  env: "draft" as const,
  entities: ["Post"],
  functionsSource,
});

const USER = { id: null, role: "visitor", isAdmin: false, attrs: {} } as unknown as CurrentUser;
/** One query call through the executor (5 s limit); resolves to the address of the pod that served it. */
export const call = (ex: ReturnType<SandboxOrchestrator["executorFor"]>) =>
  ex.run("f", "query", {}, USER, new Date(), {} as never, 5000);

/** Lets queued callbacks run until `ok()` holds. */
export async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise((r) => setImmediate(r));
  expect(ok()).toBe(true);
}
