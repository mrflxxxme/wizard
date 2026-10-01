// Child processes of the worker tests (worker entry, platform-api, runtime) with captured output.
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

/** apps/worker: `--import tsx` resolves from here. */
const APP_DIR = join(import.meta.dirname, "..");
export const ENTRY = join(import.meta.dirname, "fixtures", "entry.ts");

export interface Proc {
  child: ChildProcess;
  out(): string;
  exited: Promise<void>;
}

/** One node process (no tsx wrapper process), so kill -9 hits the worker itself. */
export function start(script: string, env: Record<string, string>): Proc {
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: APP_DIR,
  });
  let out = "";
  child.stdout?.on("data", (d) => {
    out += d;
  });
  child.stderr?.on("data", (d) => {
    out += d;
  });
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  return { child, out: () => out, exited };
}

export async function waitOut(p: Proc, text: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!p.out().includes(text)) {
    if (Date.now() > end || p.child.exitCode !== null) throw new Error(`no "${text}" in:\n${p.out()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function stopProc(p: Proc, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill(signal);
  await p.exited;
}

export function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}
