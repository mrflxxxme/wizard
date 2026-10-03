// Sandbox orchestrator (M2-18; security/isolation.yaml#M2.pods): places systems with SandboxPool and keeps one workerd
// pod (gVisor, sandboxPod()) per pool pod running exactly the functions of its systems. A pod's config is a ConfigMap
// named after the hash of the rendered workerd config: a new functions revision of any of its systems gives a new
// ConfigMap and pod; the old pair is removed once the new pod is ready. The functions source is embedded in the
// ConfigMap (pilot deviation from "loaded from S3 by sha256": specs/CHANGELOG.md 2026-10-03).
import { createHash } from "node:crypto";
import { WizardError } from "@wizard/sdk";
import type { SandboxEnv } from "./capability.js";
import { type KubeApi, KubeError } from "./kube.js";
import { sandboxPod } from "./pod.js";
import { SandboxPool, SandboxPoolFullError, type SandboxPoolName } from "./pool.js";
import type { SandboxRpc } from "./rpc.js";
import { type WorkerdSystem, workerdPodConfig } from "./workerd-config.js";
import { type GuestExecutor, type SandboxExecutors, WorkerdExecutor } from "./workerd-executor.js";

export interface OrchestratorOptions {
  kube: KubeApi;
  rpc: SandboxRpc;
  /** Owner label of everything created (wizard.ru/sandbox-owner): "runtime", or one per G1 host. [a-z0-9-]. */
  owner: string;
  namespace: string;
  /** workerd image (infra/docker/sandbox.Dockerfile). */
  image: string;
  /** host:port of the RPC listener as the pods reach it: an IP (sandbox pods have no DNS). */
  rpcAddress: string;
  basePort: number;
  healthPort: number;
  /** Listen host of the pod's sockets (pods: "*"; the CI sandbox job runs workerd as a process: "127.0.0.1"). */
  listenHost?: string;
  /** Systems per pod (1…10). */
  systemsPerPod?: number;
  maxPods?: number;
  memoryLimit?: string;
  cpuLimit?: string;
  /** Pod start: image pull + gVisor + workerd (default 120 s). */
  readyTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
  fetch?: typeof fetch;
}

export interface PrepareInput {
  systemId: string;
  env: SandboxEnv;
  entities: readonly string[];
  /** server/functions.mjs of the artifact ("" with `worker`). */
  functionsSource: string;
  /** Another Worker instead of the functions host (M2-19: the G1 render Worker). */
  worker?: WorkerdSystem["worker"];
  orgId?: string;
}

interface PodRecord {
  name: string;
  hash: string;
  ip: string;
  /** The pod's ConfigMaps: shared files + one per system slot. */
  configMaps: string[];
}

/** Kubernetes stores at most 1 MiB per ConfigMap; the rest is headroom for metadata. */
export const CONFIGMAP_BUDGET = 900 * 1024;
/** Container states that will not become ready by waiting. */
const STUCK = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
  "CrashLoopBackOff",
  "RunContainerError",
]);
const OWNER_RE = /^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** ConfigMap keys cannot contain "/": s0/functions.mjs ↔ s0__functions.mjs. */
export const configKey = (path: string) => path.replaceAll("/", "__");

const unavailable = (message: string) => new WizardError("FUNCTIONS_DISABLED", { message });

export class SandboxOrchestrator implements SandboxExecutors {
  private readonly pool: SandboxPool;
  private readonly sources = new Map<string, WorkerdSystem & { hash: string }>();
  private readonly pods = new Map<string, PodRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly perPod: number;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly o: OrchestratorOptions) {
    if (!OWNER_RE.test(o.owner)) throw new Error(`sandbox owner: [a-z0-9-]{1,20}, got ${o.owner}`);
    this.perPod = o.systemsPerPod ?? 10;
    const max = o.maxPods ?? 50;
    this.pool = new SandboxPool({
      freePerPod: this.perPod,
      paidPerPod: this.perPod,
      maxPods: { "sandbox-free": max, "sandbox-paid": max, "sandbox-business": max },
      dedicatedBusiness: false,
    });
  }

  private get log() {
    return this.o.log ?? (() => {});
  }

  private labels(podId?: string): Record<string, string> {
    return { "wizard.ru/sandbox-owner": this.o.owner, ...(podId ? { "wizard.ru/sandbox-pod": podId } : {}) };
  }

  /** Removes what a previous process of this owner left (its pods point at a stale RPC address). */
  async reconcile(): Promise<number> {
    const sel = `wizard.ru/sandbox-owner=${this.o.owner}`;
    const pods = await this.o.kube.listPods(sel);
    for (const p of pods) await this.o.kube.deletePod(p.name);
    for (const c of await this.o.kube.listConfigMaps(sel)) await this.o.kube.deleteConfigMap(c);
    if (pods.length) this.log({ msg: "sandbox_reconciled", count: pods.length });
    return pods.length;
  }

  /** Places the system and makes its pod run this functions source; idempotent, serialized per pod. */
  async prepare(s: PrepareInput): Promise<void> {
    const key = `${s.systemId}:${s.env}`;
    let podId: string;
    let slot: number;
    try {
      ({ podId, slot } = this.pool.place({
        systemId: s.systemId,
        env: s.env,
        orgId: s.orgId ?? "",
        tier: "free",
      }));
    } catch (e) {
      if (e instanceof SandboxPoolFullError) {
        this.log({ msg: "sandbox_full", systemId: s.systemId });
        throw unavailable("Песочница заполнена: функции системы временно недоступны");
      }
      throw e;
    }
    const hash = sha(`${s.functionsSource}\0${s.entities.join(",")}\0${JSON.stringify(s.worker ?? null)}`);
    this.sources.set(key, {
      systemId: s.systemId,
      env: s.env,
      functionsSource: s.functionsSource,
      entities: [...s.entities],
      slot,
      hash,
      ...(s.worker ? { worker: s.worker } : {}),
    });
    try {
      await this.serial(podId, () => this.sync(podId));
    } catch (e) {
      if (e instanceof WizardError) throw e;
      // The API server refused or was unreachable (RBAC, network): the call fails cleanly, the log says why.
      this.log({ msg: "sandbox_api_failed", error: e });
      throw unavailable("Песочница функций недоступна");
    }
  }

  /** The workerd config of a pool pod from the sources of its systems. */
  private render(podId: string) {
    const systems: WorkerdSystem[] = [];
    for (const key of this.pool.podSlots(podId)) {
      const src = key ? this.sources.get(key) : undefined;
      if (src) {
        const { hash: _hash, ...w } = src;
        systems.push(w);
      }
    }
    const cfg = workerdPodConfig({
      systems,
      rpcAddress: this.o.rpcAddress,
      ...(this.o.listenHost ? { listenHost: this.o.listenHost } : {}),
      basePort: this.o.basePort,
      healthPort: this.o.healthPort,
    });
    return { cfg, hash: sha(JSON.stringify(cfg)).slice(0, 10) };
  }

  private async sync(podId: string): Promise<void> {
    const { cfg, hash } = this.render(podId);
    const prev = this.pods.get(podId);
    if (prev?.hash === hash) return;
    const name = `wz-${this.o.owner}-${podId.replace(/^sandbox-/, "")}-${hash}`;
    // One ConfigMap for the shared files and one per system slot (s<n>/…): the 1 MiB limit holds per system.
    const groups = new Map<
      string,
      { data: Record<string, string>; items: { key: string; path: string }[] }
    >();
    const put = (cm: string, path: string, text: string) => {
      const g = groups.get(cm) ?? { data: {}, items: [] };
      g.data[configKey(path)] = text;
      g.items.push({ key: configKey(path), path });
      groups.set(cm, g);
    };
    put(name, "config.capnp", cfg.capnp);
    for (const [path, text] of Object.entries(cfg.files)) {
      const slot = /^s(\d+)\//.exec(path)?.[1];
      put(slot === undefined ? name : `${name}-s${slot}`, path, text);
    }
    for (const g of groups.values()) {
      const size = Object.values(g.data).reduce((n, t) => n + Buffer.byteLength(t), 0);
      if (size > CONFIGMAP_BUDGET) {
        this.log({ msg: "sandbox_config_too_large", count: size });
        throw unavailable("Код системы не помещается в песочницу");
      }
    }
    const labels = this.labels(podId);
    for (const [cm, g] of groups) {
      try {
        await this.o.kube.createConfigMap({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: cm, namespace: this.o.namespace, labels },
          immutable: true,
          data: g.data,
        });
      } catch (e) {
        if (!(e instanceof KubeError && e.status === 409)) throw e;
      }
    }
    const configMaps = [...groups.keys()];
    const pool = (this.pool.listPods().find((p) => p.id === podId)?.pool ??
      "sandbox-free") as SandboxPoolName;
    const pod = sandboxPod({
      name,
      namespace: this.o.namespace,
      pool,
      image: this.o.image,
      configMap: name,
      configSources: [...groups].map(([cm, g]) => ({ name: cm, items: g.items })),
      basePort: this.o.basePort,
      systems: this.perPod,
      healthPort: this.o.healthPort,
      labels,
      ...(this.o.memoryLimit ? { memoryLimit: this.o.memoryLimit } : {}),
      ...(this.o.cpuLimit ? { cpuLimit: this.o.cpuLimit } : {}),
    });
    await this.createPod(pod, prev);
    const ip = await this.waitReady(name, configMaps);
    this.pods.set(podId, { name, hash, ip, configMaps });
    this.log({ msg: "sandbox_pod_ready", step: name });
    if (prev && prev.name !== name) await this.drop(prev.name, prev.configMaps);
  }

  /** Creates the pod; a full namespace quota frees the old pod of the same pool pod first. */
  private async createPod(pod: Record<string, unknown>, prev: PodRecord | undefined): Promise<void> {
    try {
      await this.o.kube.createPod(pod);
    } catch (e) {
      if (e instanceof KubeError && e.status === 409) return;
      if (!(e instanceof KubeError && e.status === 403 && /quota/i.test(e.message) && prev)) throw e;
      this.pods.delete(this.podIdOf(prev.name));
      await this.drop(prev.name, prev.configMaps);
      await this.o.kube.createPod(pod);
    }
  }

  private podIdOf(name: string): string {
    for (const [id, r] of this.pods) if (r.name === name) return id;
    return "";
  }

  private async drop(name: string, configMaps: readonly string[]): Promise<void> {
    await this.o.kube
      .deletePod(name)
      .catch((e: unknown) => this.log({ msg: "sandbox_delete_failed", error: e }));
    for (const cm of configMaps)
      await this.o.kube
        .deleteConfigMap(cm)
        .catch((e: unknown) => this.log({ msg: "sandbox_delete_failed", error: e }));
  }

  private async waitReady(name: string, configMaps: readonly string[]): Promise<string> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const deadline = (this.o.readyTimeoutMs ?? 120_000) / (this.o.pollMs ?? 500);
    for (let i = 0; i < deadline; i++) {
      const p = await this.o.kube.getPod(name);
      if (p?.ready && p.podIP) return p.podIP;
      if (p && (p.phase === "Failed" || (p.reason && STUCK.has(p.reason)))) {
        this.log({ msg: "sandbox_pod_failed", step: name, reason: p.reason ?? p.phase });
        await this.drop(name, configMaps);
        throw unavailable("Песочница функций не запустилась");
      }
      await sleep(this.o.pollMs ?? 500);
    }
    this.log({ msg: "sandbox_pod_timeout", step: name });
    await this.drop(name, configMaps);
    throw unavailable("Песочница функций не запустилась вовремя");
  }

  private serial<T>(podId: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(podId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(f);
    this.locks.set(podId, next);
    return next;
  }

  /** Base URL of the system's socket while its pod is ready, else null. */
  endpointOf(systemId: string, env: SandboxEnv): string | null {
    const p = this.pool.placement({ systemId, env });
    const r = p ? this.pods.get(p.podId) : undefined;
    return p && r ? `http://${r.ip}:${this.o.basePort + p.slot}` : null;
  }

  executorFor(sys: { systemId: string; env: SandboxEnv; entities: readonly string[] }): GuestExecutor {
    if (!this.endpointOf(sys.systemId, sys.env)) throw unavailable("Функции системы не загружены");
    return new WorkerdExecutor({
      endpoint: () => this.endpointOf(sys.systemId, sys.env),
      systemId: sys.systemId,
      env: sys.env,
      rpc: this.o.rpc,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
  }

  /**
   * Frees the system's slot; its pod is re-rendered without it, or removed when empty. resync: false leaves a pod
   * that still serves other systems as it is (the next prepare re-renders it) — G1 frees its render Worker so.
   */
  async remove(systemId: string, env: SandboxEnv, o: { resync?: boolean } = {}): Promise<void> {
    const p = this.pool.placement({ systemId, env });
    if (!p) return;
    this.pool.remove({ systemId, env });
    this.sources.delete(`${systemId}:${env}`);
    await this.serial(p.podId, async () => {
      if (this.pool.podSlots(p.podId).some((x) => x !== null))
        return o.resync === false ? undefined : this.sync(p.podId);
      const r = this.pods.get(p.podId);
      this.pods.delete(p.podId);
      if (r) await this.drop(r.name, r.configMaps);
    });
  }

  /**
   * A pod that disappeared (node restart, eviction) is created again: every `intervalMs` each known pod is looked
   * up; a missing or failed one is re-synced from the sources kept here.
   */
  startWatchdog(intervalMs = 30_000): void {
    this.watchdog = setInterval(() => {
      void this.check().catch((e: unknown) => this.log({ msg: "sandbox_watchdog_failed", error: e }));
    }, intervalMs);
    this.watchdog.unref();
  }

  async check(): Promise<void> {
    for (const [podId, r] of [...this.pods]) {
      const p = await this.o.kube.getPod(r.name);
      if (p && p.phase !== "Failed") continue;
      this.log({ msg: "sandbox_pod_lost", step: r.name });
      this.pods.delete(podId);
      // A failed pod keeps its name: remove it with its ConfigMap so the same config can be created again.
      if (p) await this.drop(r.name, r.configMaps);
      await this.serial(podId, () => this.sync(podId));
    }
  }

  async close(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
  }
}
