// A pod's workerd process for the CI sandbox job (*.sandbox.test.ts): writes the generated config.capnp and its
// embedded files to a temp dir and runs `workerd serve` as a plain process. Used only under WIZARD_SANDBOX_E2E=1.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkerdPodConfig } from "../../src/index.js";

/** workerd binary: the CI job installs the npm package `workerd` and exports WORKERD_BIN. */
export const WORKERD_BIN = process.env.WORKERD_BIN ?? "workerd";

export interface WrittenConfig {
  dir: string;
  file: string;
  cleanup(): void;
}

/** config.capnp + embedded files in a fresh mkdtemp dir. */
export function writePodConfig(cfg: WorkerdPodConfig): WrittenConfig {
  const dir = mkdtempSync(join(tmpdir(), "wz-workerd-"));
  for (const [rel, text] of Object.entries(cfg.files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const file = join(dir, "config.capnp");
  writeFileSync(file, cfg.capnp);
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function tryListen(port: number): Promise<ReturnType<typeof createServer> | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

/** First port of n consecutive free TCP ports on 127.0.0.1 (health socket + one socket per system slot). */
export async function freePortRange(n: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 20_000);
    const held: ReturnType<typeof createServer>[] = [];
    for (let i = 0; i < n; i++) {
      const s = await tryListen(base + i);
      if (!s) break;
      held.push(s);
    }
    await Promise.all(held.map((s) => new Promise<void>((r) => s.close(() => r()))));
    if (held.length === n) return base;
  }
  throw new Error(`no ${n} consecutive free ports`);
}

export interface WorkerdProcess {
  child: ChildProcess;
  stderr(): string;
  stop(): Promise<void>;
}

function spawnWorkerd(file: string): { child: ChildProcess; stderr(): string } {
  let err = "";
  const child = spawn(WORKERD_BIN, ["serve", file, "--verbose"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {},
  });
  child.stdout?.on("data", (b: Buffer) => {
    err += b.toString();
  });
  child.stderr?.on("data", (b: Buffer) => {
    err += b.toString();
  });
  return { child, stderr: () => err.slice(-4000) };
}

/** Starts workerd with the config and waits until the health socket answers. */
export async function startWorkerd(
  written: WrittenConfig,
  healthPort: number,
  timeoutMs = 30_000,
): Promise<WorkerdProcess> {
  const { child, stderr } = spawnWorkerd(written.file);
  let exited: number | null | undefined;
  child.on("exit", (code) => {
    exited = code;
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited !== undefined) throw new Error(`workerd exited ${exited}: ${stderr()}`);
    try {
      const r = await fetch(`http://127.0.0.1:${healthPort}/`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`workerd not healthy in ${timeoutMs} ms: ${stderr()}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    child,
    stderr,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

/** Runs workerd with a config that must fail to load: resolves with its exit code (null → still running). */
export async function workerdLoadResult(
  written: WrittenConfig,
  healthPort: number,
  waitMs = 20_000,
): Promise<{ exitCode: number | null; healthy: boolean; stderr: string }> {
  const { child, stderr } = spawnWorkerd(written.file);
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
  const deadline = Date.now() + waitMs;
  let healthy = false;
  let exitCode: number | null = null;
  while (Date.now() < deadline) {
    const done = await Promise.race([
      exit,
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 250)),
    ]);
    if (done !== "pending") {
      exitCode = done;
      break;
    }
    try {
      const r = await fetch(`http://127.0.0.1:${healthPort}/`, { signal: AbortSignal.timeout(500) });
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      // not listening
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exit;
  }
  return { exitCode, healthy, stderr: stderr() };
}
