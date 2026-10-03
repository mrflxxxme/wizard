// Kubernetes stand-in of the sandbox e2e tests (M2-18/M2-19): ConfigMaps become folders laid out as the kubelet mounts
// their items, a created pod becomes a local `workerd serve` process (WORKERD_BIN) listening on 127.0.0.1.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { KubeApi, KubePodStatus } from "@wizard/runtime";

// biome-ignore lint/suspicious/noExplicitAny: Kubernetes objects as the orchestrator renders them
type Obj = Record<string, any>;

export const WORKERD_BIN = process.env.WORKERD_BIN ?? "workerd";

/** First port of n consecutive free ports on 127.0.0.1. */
export async function freePortRange(n: number): Promise<number> {
  const free = (p: number) =>
    new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(true)));
    });
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 20_000);
    let ok = true;
    for (let i = 0; i < n && ok; i++) ok = await free(base + i);
    if (ok) return base;
  }
  throw new Error(`no ${n} consecutive free ports`);
}

export class ProcessKube implements KubeApi {
  private readonly cms = new Map<string, Obj>();
  readonly procs = new Map<string, { child: ChildProcess; dir: string; out: () => string }>();
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
    // Local "pods" share 127.0.0.1 and its ports; in the cluster every pod has its own IP. One process at a time.
    for (const name of [...this.procs.keys()]) await this.deletePod(name);
    const dir = mkdtempSync(join(tmpdir(), "wz-kube-"));
    for (const src of pod.spec.volumes[0].projected.sources.map((x: Obj) => x.configMap)) {
      const cm = this.cms.get(src.name);
      if (!cm) throw new Error(`no ConfigMap ${src.name}`);
      for (const { key, path } of src.items as { key: string; path: string }[]) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), cm.data[key]);
      }
    }
    let out = "";
    const child = spawn(WORKERD_BIN, ["serve", join(dir, "config.capnp"), "--verbose"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {},
    });
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.stderr?.on("data", (b: Buffer) => {
      out += b.toString();
    });
    this.procs.set(pod.metadata.name, { child, dir, out: () => out.slice(-4000) });
  }
  async deletePod(name: string) {
    const p = this.procs.get(name);
    this.procs.delete(name);
    if (!p) return;
    if (process.env.WZ_KUBE_DEBUG) console.error(`--- workerd ${name}\n${p.out()}`);
    if (p.child.exitCode === null && p.child.signalCode === null) {
      await new Promise<void>((resolve) => {
        p.child.once("exit", () => resolve());
        p.child.kill("SIGKILL");
      });
    }
    rmSync(p.dir, { recursive: true, force: true });
  }
  async getPod(name: string): Promise<KubePodStatus | null> {
    const p = this.procs.get(name);
    if (!p) return null;
    if (p.child.exitCode !== null) {
      return {
        name,
        phase: "Failed",
        ready: false,
        podIP: null,
        reason: `exit ${p.child.exitCode}: ${p.out()}`,
        labels: {},
      };
    }
    const ready = await fetch(`http://127.0.0.1:${this.healthPort}/`, { signal: AbortSignal.timeout(500) })
      .then((r) => r.ok)
      .catch(() => false);
    return { name, phase: "Running", ready, podIP: ready ? "127.0.0.1" : null, reason: null, labels: {} };
  }
  async listPods() {
    return [];
  }
  async stopAll() {
    for (const name of [...this.procs.keys()]) await this.deletePod(name);
  }
}
