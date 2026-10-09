// Sandbox orchestrator (M2-18; security/isolation.yaml#M2.pods): places systems with SandboxPool and keeps one workerd
// pod (gVisor, sandboxPod()) per pool pod running exactly the functions of its systems. A pod's config is a ConfigMap
// named after the hash of the rendered workerd config: a new functions revision of any of its systems gives a new
// ConfigMap and pod; the old pair is removed once the new pod is ready. The functions source is embedded in the
// ConfigMap (pilot deviation from "loaded from S3 by sha256": specs/CHANGELOG.md 2026-10-03).
//
// Make-before-break: calls stay on the old pod until the new one is ready and answers from this process (its address
// reaches our NetworkPolicy after the kubelet sees it Ready); then endpoints switch at once and the old pod goes after
// the calls it was given (lease). The namespace quota is shared by the owners: without room for both pods the runtime
// waits and never takes a production pod down; G1 (inPlace) removes its own old pod first, its calls wait. Each start
// has a pod name of its own (hash + random suffix): a rollback never meets its config's pod still draining.
//
// One bad Worker must not take its pod's other systems down (V3-18, pilot 2026-10-09: workerd exits at startup when
// any module throws while it is evaluated, e.g. a timer or a random value at module scope): a prepare starts the pod
// with the sources that already started plus its own new one only, so a failed start is that system's, and its
// source never enters a later config — a new system is unplaced, an updated one keeps the revision that ran.
import { createHash, randomBytes } from "node:crypto";
import { WizardError } from "@wizard/sdk";
import type { SandboxEnv } from "./capability.js";
import type { KubeApi } from "./kube.js";
import { CONFIGMAP_BUDGET, podConfigMaps, sandboxPod } from "./pod.js";
import { createWithinQuota, type PodStartContext, podCrashed, waitReachable } from "./pod-start.js";
import { SandboxPool, SandboxPoolFullError, type SandboxPoolName } from "./pool.js";
import type { SandboxRpc } from "./rpc.js";
import { type WorkerdSystem, workerdPodConfig } from "./workerd-config.js";
import {
  type EndpointLease,
  type GuestExecutor,
  type SandboxExecutors,
  WorkerdExecutor,
} from "./workerd-executor.js";

export { CONFIGMAP_BUDGET, configKey } from "./pod.js";

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
  /** Budget of one (re)start: quota waits + pod start (default 120 s); a pod created late still gets podStartMs. */
  readyTimeoutMs?: number;
  /** Least time a created pod gets to become reachable (default 30 s). */
  podStartMs?: number;
  /**
   * With no room for a second pod in the quota, replace the old pod in place (it goes first). Off by default: a
   * production pod is never taken down for a pod start. The G1 host turns it on (its pods hold no live traffic).
   */
  inPlace?: boolean;
  /** inPlace: room is waited for this long before the old pod goes (default 10 s). */
  quotaWaitMs?: number;
  /** A replaced pod is removed once its calls finish, at most this long (default 35 s: action wall limit 30 s). */
  drainMs?: number;
  pollMs?: number;
  /** Clock of the deadlines, and its sleep (tests pass a fake pair). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: Record<string, unknown>) => void;
  /** Calls to the pods and the reachability probe of a new pod. */
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

type Source = WorkerdSystem & { hash: string };

interface PodRecord {
  name: string;
  hash: string;
  ip: string;
  /** The pod's ConfigMaps: shared files + one per system slot. */
  configMaps: string[];
  /** Systems this pod runs (`systemId:env` → slot): a system placed after it was rendered is not routed here. */
  systems: ReadonlyMap<string, number>;
}

const OWNER_RE = /^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const unavailable = (message: string) => new WizardError("FUNCTIONS_DISABLED", { message });
const SANDBOX_FULL = "Песочница заполнена: функции системы временно недоступны";
const NOT_LOADED = "Функции системы не загружены";
/** The pod exited with this system's new source in it (the others had started without it). */
const CODE_FAILED = "Код системы не запускается в песочнице";
const noop = () => {};

export class SandboxOrchestrator implements SandboxExecutors {
  private readonly pool: SandboxPool;
  /** Sources that started in a pod (`systemId:env`): every pod config is made of these… */
  private readonly sources = new Map<string, Source>();
  /** …plus, in a prepare's own start, its new source (the pending one of its system). */
  private readonly pending = new Map<string, Source>();
  private readonly pods = new Map<string, PodRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Operations queued or running per pool pod (serial). */
  private readonly busy = new Map<string, number>();
  /** Calls in flight per pod address (leases). */
  private readonly calls = new Map<string, number>();
  /** Replaced pods draining in the background. */
  private readonly retiring = new Set<Promise<void>>();
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

  private get poll() {
    return this.o.pollMs ?? 500;
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  private wait(ms: number): Promise<void> {
    return this.o.sleep ? this.o.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private get start(): PodStartContext {
    return {
      kube: this.o.kube,
      now: () => this.now(),
      wait: (ms) => this.wait(ms),
      pollMs: this.poll,
      log: (line) => this.log(line),
      fetch: this.o.fetch ?? fetch,
    };
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

  /**
   * Places the system and makes its pod run this functions source; idempotent, serialized per pod. A start that fails
   * with this source unplaces a new system (an updated one keeps the revision that ran), so it never poisons the pod.
   */
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
        this.log({ msg: "sandbox_full", level: "error", systemId: s.systemId, env: s.env });
        throw unavailable(SANDBOX_FULL);
      }
      throw e;
    }
    const hash = sha(`${s.functionsSource}\0${s.entities.join(",")}\0${JSON.stringify(s.worker ?? null)}`);
    const src: Source = {
      systemId: s.systemId,
      env: s.env,
      functionsSource: s.functionsSource,
      entities: [...s.entities],
      slot,
      hash,
      ...(s.worker ? { worker: s.worker } : {}),
    };
    this.pending.set(key, src);
    let emptied: PodRecord | undefined;
    try {
      await this.resync(podId, async () => {
        // Removed meanwhile, or a later prepare of this system took over: nothing of this one to start.
        if (this.pending.get(key) !== src) return;
        try {
          await this.sync(podId, src);
        } catch (e) {
          if (this.pending.get(key) === src) emptied = this.reject(src, podId, e);
          throw podCrashed(e) ? unavailable(CODE_FAILED) : e;
        }
        if (this.pending.get(key) !== src) return;
        this.pending.delete(key);
        this.sources.set(key, src);
      });
    } finally {
      if (emptied) await this.retire(emptied);
    }
  }

  /**
   * A prepare whose start failed, in its pod's queue: a new system is unplaced (an emptied pod's record is returned to
   * be retired), an updated one keeps its slot and the revision that ran.
   */
  private reject(src: Source, podId: string, e: unknown): PodRecord | undefined {
    const key = `${src.systemId}:${src.env}`;
    this.pending.delete(key);
    const kept = this.sources.has(key);
    this.log({
      msg: "sandbox_system_rejected",
      level: "error",
      systemId: src.systemId,
      env: src.env,
      step: podId,
      reason: podCrashed(e) ? "crashed" : e instanceof WizardError ? "not_started" : "api_failed",
      mode: kept ? "kept_previous" : "unplaced",
    });
    if (kept) return undefined;
    this.pool.remove({ systemId: src.systemId, env: src.env });
    if (this.pool.podSlots(podId).some((x) => x !== null)) return undefined;
    const r = this.pods.get(podId);
    this.pods.delete(podId);
    return r;
  }

  /** An operation of a pool pod (default: its sync) in its queue; API server failures become FUNCTIONS_DISABLED. */
  private async resync(podId: string, f: () => Promise<void> = () => this.sync(podId)): Promise<void> {
    try {
      await this.serial(podId, f);
    } catch (e) {
      if (e instanceof WizardError) throw e;
      // The API server refused or was unreachable (RBAC, network): the call fails cleanly, the log says why.
      this.log({ msg: "sandbox_api_failed", level: "error", step: podId, error: e });
      throw unavailable("Песочница функций недоступна");
    }
  }

  /** The workerd config of a pool pod: the sources that started, and `mine` (a prepare's new one) in its slot. */
  private render(podId: string, mine?: Source) {
    const systems: WorkerdSystem[] = [];
    const keys = new Map<string, number>();
    const own = mine ? `${mine.systemId}:${mine.env}` : null;
    for (const key of this.pool.podSlots(podId)) {
      const src = key ? (key === own ? mine : this.sources.get(key)) : undefined;
      if (src && key) {
        const { hash: _hash, ...w } = src;
        systems.push(w);
        keys.set(key, src.slot ?? systems.length - 1);
      }
    }
    const cfg = workerdPodConfig({
      systems,
      rpcAddress: this.o.rpcAddress,
      ...(this.o.listenHost ? { listenHost: this.o.listenHost } : {}),
      basePort: this.o.basePort,
      healthPort: this.o.healthPort,
    });
    // Reachability is probed on a system socket: the G1 host's NetworkPolicy opens only those ports to it.
    const probePort = this.o.basePort + ([...keys.values()][0] ?? 0);
    return { cfg, hash: sha(JSON.stringify(cfg)).slice(0, 10), keys, probePort };
  }

  private async sync(podId: string, mine?: Source): Promise<void> {
    const { cfg, hash, keys, probePort } = this.render(podId, mine);
    const prev = this.pods.get(podId);
    // A pod without systems is never started (remove() deletes an emptied pod).
    if (prev?.hash === hash || keys.size === 0) return;
    const deadline = this.now() + (this.o.readyTimeoutMs ?? 120_000);
    const name = `wz-${this.o.owner}-${podId.replace(/^sandbox-/, "")}-${hash}-${randomBytes(3).toString("hex")}`;
    const groups = podConfigMaps(name, cfg.capnp, cfg.files);
    for (const g of groups.values()) {
      if (g.size > CONFIGMAP_BUDGET) {
        this.log({
          msg: "sandbox_config_too_large",
          level: "error",
          step: name,
          count: g.size,
          ...(mine ? { systemId: mine.systemId, env: mine.env } : {}),
        });
        throw unavailable("Код системы не помещается в песочницу");
      }
    }
    const labels = this.labels(podId);
    const configMaps = [...groups.keys()];
    const pool = (this.pool.listPods().find((p) => p.id === podId)?.pool ??
      "sandbox-free") as SandboxPoolName;
    let ip: string;
    let inPlace = false;
    try {
      for (const [cm, g] of groups) {
        await this.o.kube.createConfigMap({
          apiVersion: "v1",
          kind: "ConfigMap",
          metadata: { name: cm, namespace: this.o.namespace, labels },
          immutable: true,
          data: g.data,
        });
      }
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
      inPlace = await this.createPod(podId, pod, name, deadline, prev);
      const started = Math.max(deadline, this.now() + (this.o.podStartMs ?? 30_000));
      // The start's lines name the system it brings in (ids only: no code or data of systems).
      const start = this.start;
      const ctx: PodStartContext = mine
        ? { ...start, log: (l) => start.log({ ...l, systemId: mine.systemId, env: mine.env }) }
        : start;
      ip = await waitReachable(ctx, name, probePort, started);
    } catch (e) {
      // Nothing of a failed start stays behind (the old pod's ConfigMaps have other names): it would eat the quota.
      await this.drop(name, configMaps);
      throw e;
    }
    // The switch: from here on calls get the new pod; the old one goes after its calls, outside this pod's queue.
    this.pods.set(podId, { name, hash, ip, configMaps, systems: keys });
    this.log({
      msg: "sandbox_pod_ready",
      step: name,
      count: keys.size,
      mode: inPlace ? "in_place" : "rolling",
    });
    if (prev && !inPlace) this.retireLater(prev);
  }

  /**
   * Creates the pod next to the old one, waiting while the quota has no room (another owner's replacement, a pod being
   * deleted). inPlace owners wait quotaWaitMs, then replace in place: new calls wait for this sync (lease), the old pod
   * goes after its calls, and the create is retried for the rest of the budget — another owner that took the freed
   * room returns it once its own swap is done. true: the old pod is already gone.
   */
  private async createPod(
    podId: string,
    pod: Record<string, unknown>,
    name: string,
    deadline: number,
    prev?: PodRecord,
  ): Promise<boolean> {
    const inPlace = prev !== undefined && this.o.inPlace === true;
    const room = inPlace ? Math.min(deadline, this.now() + (this.o.quotaWaitMs ?? 10_000)) : deadline;
    if (await createWithinQuota(this.start, pod, name, room)) return false;
    if (inPlace && prev) {
      this.log({ msg: "sandbox_replace_in_place", level: "warn", step: prev.name });
      this.pods.delete(podId);
      await this.retire(prev, deadline);
      if (await createWithinQuota(this.start, pod, name, deadline)) return true;
    }
    this.log({ msg: "sandbox_quota_full", level: "error", step: name });
    throw unavailable(SANDBOX_FULL);
  }

  /** Removes a replaced pod once its calls have finished (at most drainMs, and not after `until`). */
  private async retire(r: PodRecord, until = Number.POSITIVE_INFINITY): Promise<void> {
    const end = Math.min(until, this.now() + (this.o.drainMs ?? 35_000));
    while (this.calls.get(r.ip) && this.now() < end) await this.wait(this.poll);
    await this.drop(r.name, r.configMaps);
  }

  private retireLater(r: PodRecord): void {
    const p: Promise<void> = this.retire(r).finally(() => this.retiring.delete(p));
    this.retiring.add(p);
  }

  /** Settles once the replaced pods draining in the background are gone (tests, shutdown). */
  async drained(): Promise<void> {
    while (this.retiring.size) await Promise.all([...this.retiring]);
  }

  /** Deletes a pod (null: already gone) and its ConfigMaps; a failed delete is logged, the next reconcile retries. */
  private async drop(name: string | null, configMaps: readonly string[]): Promise<void> {
    if (name)
      await this.o.kube
        .deletePod(name)
        .catch((e: unknown) =>
          this.log({ msg: "sandbox_delete_failed", level: "warn", step: name, error: e }),
        );
    for (const cm of configMaps)
      await this.o.kube
        .deleteConfigMap(cm)
        .catch((e: unknown) => this.log({ msg: "sandbox_delete_failed", level: "warn", step: cm, error: e }));
  }

  private serial<T>(podId: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(podId) ?? Promise.resolve();
    this.busy.set(podId, (this.busy.get(podId) ?? 0) + 1);
    const next = prev
      .catch(() => {})
      .then(f)
      .finally(() => {
        const n = (this.busy.get(podId) ?? 1) - 1;
        if (n > 0) this.busy.set(podId, n);
        else this.busy.delete(podId);
      });
    this.locks.set(podId, next);
    return next;
  }

  /** Base URL of the system's socket while a ready pod runs it, else null. */
  endpointOf(systemId: string, env: SandboxEnv): string | null {
    const p = this.pool.placement({ systemId, env });
    const r = p ? this.pods.get(p.podId) : undefined;
    return p && r?.systems.get(`${systemId}:${env}`) === p.slot
      ? `http://${r.ip}:${this.o.basePort + p.slot}`
      : null;
  }

  /**
   * The system's endpoint held for one call until release(): a replaced pod is removed only after it. While the pod is
   * being started or replaced in place (or was lost — then a sync is started here) the call waits, at most waitMs.
   * Rejects with FUNCTIONS_DISABLED: not placed, still restarting after waitMs, or its pod could not start.
   */
  async lease(systemId: string, env: SandboxEnv, waitMs: number): Promise<EndpointLease> {
    const end = this.now() + waitMs;
    let started = false;
    for (;;) {
      const endpoint = this.endpointOf(systemId, env);
      // endpointOf and the hold in one synchronous step: no switch and retire can come in between.
      if (endpoint) return { endpoint, release: this.hold(endpoint) };
      const p = this.pool.placement({ systemId, env });
      if (!p) throw unavailable(NOT_LOADED);
      const left = end - this.now();
      if (left <= 0) throw unavailable("Песочница функций перезапускается");
      if (this.busy.get(p.podId)) {
        // The queue's tail settles only once every queued operation is done: a real wait, never a settled promise.
        await this.within(this.locks.get(p.podId), Math.min(this.poll, left));
        continue;
      }
      // An idle queue and no endpoint: the last start failed or the pod was lost. This call starts one, once; its
      // failure is the call's answer at once, whatever is queued meanwhile.
      if (started) throw unavailable(NOT_LOADED);
      started = true;
      let failure: unknown;
      const mine = this.resync(p.podId).catch((e: unknown) => {
        failure = e ?? unavailable(NOT_LOADED);
      });
      await this.within(mine, left);
      if (failure) throw failure instanceof WizardError ? failure : unavailable(NOT_LOADED);
    }
  }

  /** Waits for `p` (settled either way) or `ms`, whichever comes first; the timer never outlives the wait. */
  private async within(p: Promise<unknown> | undefined, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = this.o.sleep
      ? this.o.sleep(ms)
      : new Promise<void>((r) => {
          timer = setTimeout(r, ms);
        });
    await Promise.race(p ? [p.then(noop, noop), elapsed] : [elapsed]);
    clearTimeout(timer);
  }

  /** Marks a call in flight on a pod (by the endpoint it was given); returns its release. */
  private hold(endpoint: string): () => void {
    const ip = endpoint.slice("http://".length, endpoint.lastIndexOf(":")); // endpointOf: http://<ip>:<port>
    this.calls.set(ip, (this.calls.get(ip) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.calls.get(ip) ?? 1) - 1;
      if (n > 0) this.calls.set(ip, n);
      else this.calls.delete(ip);
    };
  }

  executorFor(sys: { systemId: string; env: SandboxEnv; entities: readonly string[] }): GuestExecutor {
    if (!this.pool.placement({ systemId: sys.systemId, env: sys.env })) throw unavailable(NOT_LOADED);
    return new WorkerdExecutor({
      endpoint: () => this.endpointOf(sys.systemId, sys.env),
      lease: (waitMs) => this.lease(sys.systemId, sys.env, waitMs),
      systemId: sys.systemId,
      env: sys.env,
      rpc: this.o.rpc,
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
  }

  /**
   * Frees the system's slot; its pod is re-rendered without it, or removed when empty (after its calls). resync: false
   * leaves a pod that still serves other systems as it is (the next prepare re-renders it) — G1 frees its render
   * Worker so.
   */
  async remove(systemId: string, env: SandboxEnv, o: { resync?: boolean } = {}): Promise<void> {
    const p = this.pool.placement({ systemId, env });
    if (!p) return;
    this.pool.remove({ systemId, env });
    this.sources.delete(`${systemId}:${env}`);
    this.pending.delete(`${systemId}:${env}`);
    const emptied = await this.serial(p.podId, async () => {
      if (this.pool.podSlots(p.podId).some((x) => x !== null)) {
        if (o.resync !== false) await this.sync(p.podId);
        return undefined;
      }
      const r = this.pods.get(p.podId);
      this.pods.delete(p.podId);
      return r;
    });
    if (emptied) await this.retire(emptied);
  }

  /**
   * A pod that disappeared (node restart, eviction) is created again: every `intervalMs` each known pod is looked
   * up; a missing or failed one is re-synced from the sources kept here.
   */
  startWatchdog(intervalMs = 30_000): void {
    this.watchdog = setInterval(() => {
      void this.check().catch((e: unknown) =>
        this.log({ msg: "sandbox_watchdog_failed", level: "error", error: e }),
      );
    }, intervalMs);
    this.watchdog.unref();
  }

  async check(): Promise<void> {
    for (const podId of [...this.pods.keys()]) {
      // In the pod's queue: a sync that switched the record meanwhile is not undone with a stale one.
      await this.serial(podId, async () => {
        const r = this.pods.get(podId);
        if (!r) return;
        const p = await this.o.kube.getPod(r.name);
        if (p && p.phase !== "Failed") return;
        this.log({ msg: "sandbox_pod_lost", level: "warn", step: r.name, reason: p ? p.phase : "Missing" });
        this.pods.delete(podId);
        // A failed pod and the ConfigMaps of a lost one would hold quota and storage: removed before the restart.
        await this.drop(p ? r.name : null, r.configMaps);
        await this.sync(podId);
      });
    }
  }

  async close(): Promise<void> {
    if (this.watchdog) clearInterval(this.watchdog);
  }
}
