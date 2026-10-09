// V3-32 test double of the Kubernetes API for the repository sandbox's pod runner: pods, ConfigMaps and PVCs of one
// namespace with a quota, statuses in the API's own shape (parsed by the runner's podStatusOf), logs with tailLines and
// limitBytes. A pod either follows a script (states by poll, fake clock) or is emulated like a kubelet would run it:
// its volumes become temp directories (ConfigMaps written out, a PVC a directory kept per claim), the containers run in
// order as local processes — the real restore and save scripts, and the run step's `timeout <argv>` with argv chosen
// by the test itself (node -e …), never a client's code.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubeError } from "@wizard/runtime";
import {
  podStatusOf,
  type RepoKube,
  type RepoKubeKind,
  type RepoKubeObject,
  type RepoPodStatus,
} from "../src/repo-agent/index.js";

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects as the runner renders them
export type Obj = Record<string, any>;

export interface Scripted {
  /** Polls answered «Pending» before the outcome (Infinity — never ends). */
  pending?: number;
  /** While pending: a waiting reason of the restore container, or PodScheduled=False. */
  waiting?: string;
  unschedulable?: boolean;
  /** The final status (raw, as the API sends it). */
  status?: Obj;
  logs?: Record<string, string>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A container status block: terminated with this exit code (and reason), or running/waiting. */
export function term(
  name: string,
  exitCode: number,
  o: { reason?: string; ms?: number; at?: number } = {},
): Obj {
  const at = o.at ?? Date.parse("2026-10-09T10:00:00Z");
  return {
    name,
    state: {
      terminated: {
        exitCode,
        reason: o.reason ?? (exitCode === 0 ? "Completed" : "Error"),
        startedAt: iso(at),
        finishedAt: iso(at + (o.ms ?? 1000)),
      },
    },
  };
}

export function finalStatus(
  phase: "Succeeded" | "Failed",
  init: Obj[],
  containers: Obj[] = [],
  pod: { reason?: string; message?: string } = {},
): Obj {
  return {
    status: {
      phase,
      ...pod,
      conditions: [{ type: "PodScheduled", status: "True" }],
      initContainerStatuses: init,
      containerStatuses: containers,
    },
  };
}

export class FakeRepoKube implements RepoKube {
  readonly objects: Record<RepoKubeKind, Map<string, Obj>> = {
    pods: new Map(),
    configmaps: new Map(),
    persistentvolumeclaims: new Map(),
  };
  /** Every pod ever created (deleted ones too), in order. */
  readonly created: Obj[] = [];
  readonly calls: string[] = [];
  /** Fake clock (scripted pods); emulated pods use real time. */
  t = Date.parse("2026-10-09T10:00:00Z");
  readonly now = () => this.t;
  readonly sleep = (ms: number) => {
    this.t += ms;
    return new Promise<void>((r) => setImmediate(r));
  };
  /** Creates refused with «exceeded quota» before one passes (per kind). */
  quotaRefusals: Partial<Record<RepoKubeKind, number>> = {};
  /** Scripted outcome of a pod; undefined — emulate it. */
  script?: (pod: Obj) => Scripted | undefined;
  /** Directory of the emulation (PVCs live in <root>/pvc/<claim>). */
  readonly root = mkdtempSync(join(tmpdir(), "wz-repo-kube-"));
  readonly #status = new Map<string, Obj>();
  readonly #logs = new Map<string, Record<string, string>>();
  readonly #scripted = new Map<string, { s: Scripted; polls: number }>();
  readonly #children = new Map<string, ChildProcess>();
  readonly #jobs = new Map<string, Promise<void>>();

  async create(kind: RepoKubeKind, obj: Obj): Promise<void> {
    const name = obj.metadata.name as string;
    this.calls.push(`create ${kind} ${name}`);
    const left = this.quotaRefusals[kind] ?? 0;
    if (left > 0) {
      this.quotaRefusals[kind] = left - 1;
      throw new KubeError(403, `${kind} "${name}" is forbidden: exceeded quota: wizard-sandbox`);
    }
    if (this.objects[kind].has(name)) throw new KubeError(409, "already exists");
    const stored = structuredClone(obj);
    stored.metadata.creationTimestamp = iso(this.t);
    this.objects[kind].set(name, stored);
    if (kind !== "pods") return;
    this.created.push(stored);
    const s = this.script?.(stored);
    if (s) this.#scripted.set(name, { s, polls: 0 });
    else
      this.#jobs.set(
        name,
        this.#emulate(stored).catch((e: unknown) => {
          // What the kubelet would report: the pod cannot start (a missing ConfigMap or PVC).
          this.#status.set(name, { phase: "Failed", reason: "Emulation", message: String(e) });
        }),
      );
  }

  async delete(kind: RepoKubeKind, name: string): Promise<void> {
    this.calls.push(`delete ${kind} ${name}`);
    this.objects[kind].delete(name);
    const child = kind === "pods" ? this.#children.get(name) : undefined;
    if (child?.pid && child.exitCode === null)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
  }

  async list(kind: RepoKubeKind, selector: string): Promise<RepoKubeObject[]> {
    const [k, v] = selector.split("=") as [string, string];
    return [...this.objects[kind].values()]
      .filter((o) => o.metadata.labels?.[k] === v)
      .map((o) => ({
        name: o.metadata.name,
        labels: o.metadata.labels ?? {},
        createdAt: Date.parse(o.metadata.creationTimestamp),
      }));
  }

  async getPod(name: string): Promise<RepoPodStatus | null> {
    const pod = this.objects.pods.get(name);
    if (!pod) return null;
    const sc = this.#scripted.get(name);
    if (sc) {
      sc.polls += 1;
      if (sc.polls <= (sc.s.pending ?? 0) || !sc.s.status) {
        return podStatusOf({
          metadata: pod.metadata,
          status: {
            phase: "Pending",
            conditions: [
              {
                type: "PodScheduled",
                status: sc.s.unschedulable ? "False" : "True",
                reason: "Unschedulable",
              },
            ],
            initContainerStatuses: sc.s.waiting
              ? [{ name: "restore", state: { waiting: { reason: sc.s.waiting } } }]
              : [],
          },
        });
      }
      return podStatusOf({ metadata: pod.metadata, ...sc.s.status });
    }
    const st = this.#status.get(name);
    return podStatusOf({ metadata: pod.metadata, status: st ?? { phase: "Running" } });
  }

  async podLog(
    name: string,
    container: string,
    o: { tailLines: number; limitBytes: number },
  ): Promise<string> {
    const text = this.#scripted.get(name)?.s.logs?.[container] ?? this.#logs.get(name)?.[container] ?? "";
    const lines = text.split("\n");
    const tail = lines.slice(-o.tailLines - (text.endsWith("\n") ? 1 : 0)).join("\n");
    return Buffer.from(tail).subarray(0, o.limitBytes).toString("utf8");
  }

  /** Settles once every emulated pod has finished. */
  async idle(): Promise<void> {
    await Promise.all([...this.#jobs.values()]);
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  /** A kubelet in miniature: volumes as directories, containers in order as local processes. */
  async #emulate(pod: Obj): Promise<void> {
    const name = pod.metadata.name as string;
    const dir = mkdtempSync(join(this.root, `${name}-`));
    const vols = new Map<string, string>();
    for (const v of pod.spec.volumes as Obj[]) {
      if (v.persistentVolumeClaim) {
        const claim = v.persistentVolumeClaim.claimName as string;
        if (!this.objects.persistentvolumeclaims.has(claim)) throw new Error(`no PVC ${claim}`);
        const p = join(this.root, "pvc", claim);
        mkdirSync(p, { recursive: true });
        vols.set(v.name, p);
        continue;
      }
      const p = join(dir, `vol-${v.name}`);
      mkdirSync(p, { recursive: true });
      vols.set(v.name, p);
      for (const src of v.projected?.sources ?? []) {
        const cm = this.objects.configmaps.get(src.configMap.name);
        if (!cm) throw new Error(`no ConfigMap ${src.configMap.name}`);
        for (const [k, b64] of Object.entries(cm.binaryData ?? {}))
          writeFileSync(join(p, k), Buffer.from(b64 as string, "base64"));
      }
    }
    const logs: Record<string, string> = {};
    this.#logs.set(name, logs);
    const statuses: { init: Obj[]; containers: Obj[] } = { init: [], containers: [] };
    const publish = (phase: string) =>
      this.#status.set(name, {
        phase,
        conditions: [{ type: "PodScheduled", status: "True" }],
        initContainerStatuses: statuses.init,
        containerStatuses: statuses.containers,
      });
    publish("Pending");
    const steps = [
      ...(pod.spec.initContainers as Obj[]).map((c) => ["init", c] as const),
      ...(pod.spec.containers as Obj[]).map((c) => ["containers", c] as const),
    ];
    for (const [list, c] of steps) {
      if (!this.objects.pods.has(name)) return;
      const mounts = new Map<string, string>();
      for (const m of c.volumeMounts as Obj[]) mounts.set(m.mountPath, vols.get(m.name) as string);
      // The scripts find their mounts through WZ_*; /in/{snap,changes} are gathered under one directory.
      const inDir = join(dir, `in-${c.name}`);
      mkdirSync(inDir, { recursive: true });
      for (const sub of ["snap", "changes"]) {
        const at = mounts.get(`/in/${sub}`);
        if (at) symlinkSync(at, join(inDir, sub));
      }
      const work = mounts.get("/work") ?? join(dir, "nowork");
      const tmp = mounts.get("/tmp") ?? join(dir, "notmp");
      const local = (v: string) =>
        v.replace(/^\/(work|tmp)(?=\/|$)/, (_, m: string) => (m === "work" ? work : tmp));
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
      for (const e of (c.env ?? []) as Obj[]) env[e.name] = local(String(e.value));
      Object.assign(env, {
        WZ_WORK: work,
        WZ_STORE: mounts.get("/store") ?? join(dir, "nostore"),
        WZ_IN: inDir,
      });
      const [bin, ...args] = c.command as string[];
      const started = Date.now();
      statuses[list].push({ name: c.name, state: { running: { startedAt: iso(started) } } });
      publish("Running");
      const { code, out } = await new Promise<{ code: number; out: string }>((resolve) => {
        const child = spawn(bin as string, args, {
          cwd: c.workingDir ? local(c.workingDir) : dir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        this.#children.set(name, child);
        let out = "";
        child.stdout?.on("data", (b: Buffer) => {
          out += b.toString("utf8");
        });
        child.stderr?.on("data", (b: Buffer) => {
          out += b.toString("utf8");
        });
        child.on("error", (e) => resolve({ code: 127, out: String(e) }));
        child.on("close", (code, signal) =>
          resolve({ code: code ?? (signal === "SIGKILL" ? 137 : 143), out }),
        );
      });
      logs[c.name] = out;
      statuses[list][statuses[list].length - 1] = {
        name: c.name,
        state: {
          terminated: {
            exitCode: code,
            reason: code === 0 ? "Completed" : "Error",
            startedAt: iso(started),
            finishedAt: iso(Date.now()),
          },
        },
      };
      if (code !== 0) return void publish("Failed");
    }
    publish("Succeeded");
  }
}
