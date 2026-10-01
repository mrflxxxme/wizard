// Parent side of render/child.mjs: spawns the sandboxed render process, answers its fetches, enforces deadlines
// (SIGKILL on overrun; the next render gets a fresh process).
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RENDER_CHILD = fileURLToPath(new URL("./child.mjs", import.meta.url));

export interface RenderJob {
  file: string;
  path: string;
  routes: string[];
  roleSpec: unknown;
}

export interface GuestFetch {
  method: string;
  path: string;
  body: string | null;
}

export type RenderOutcome =
  | {
      kind: "done";
      ok: boolean;
      html?: string;
      error?: string;
      passes?: number;
      loading?: number;
      logs: { level: string; text: string }[];
    }
  | { kind: "timeout" }
  | { kind: "crash"; message: string };

type Msg =
  | { t: "ready" }
  | { t: "fatal"; message: string }
  | ({ t: "fetch"; id: number } & GuestFetch)
  | { t: "done"; id: number; ok: boolean; [k: string]: unknown };

export function renderFlags(dir: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${dir}`,
    "--disable-warning=ExperimentalWarning",
    "--max-old-space-size=256",
  ];
}

export class RenderProcess {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private onMsg: ((m: Msg) => void) | null = null;
  private onExit: ((why: string) => void) | null = null;
  private seq = 0;

  constructor(
    private readonly dir: string,
    private readonly answer: (req: GuestFetch) => Promise<{ status: number; body: string }>,
  ) {}

  private start(timeoutMs: number): Promise<void> {
    const child = spawn(process.execPath, [...renderFlags(this.dir), RENDER_CHILD], {
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.child = child;
    // Events of a process this object already dropped (killed after a timeout) are ignored.
    child.on("message", (m: Msg) => {
      if (this.child === child) this.onMsg?.(m);
    });
    const gone = (why: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = null;
      this.onExit?.(why);
    };
    child.on("exit", (code, signal) => gone(`exit ${code ?? signal}`));
    child.on("error", () => gone("spawn error"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new Error("render process load timed out"));
      }, timeoutMs);
      this.onExit = (why) => {
        clearTimeout(timer);
        reject(new Error(`render process ${why}`));
      };
      this.onMsg = (m) => {
        if (m.t === "ready") {
          clearTimeout(timer);
          this.onExit = null;
          resolve();
        } else if (m.t === "fatal") {
          clearTimeout(timer);
          reject(new Error(String(m.message)));
        }
      };
      child.send({ t: "init", dir: this.dir });
    });
  }

  /** Loads the bundle once; a load failure is reported by every render as crash. */
  async render(job: RenderJob, timeoutMs: number): Promise<RenderOutcome> {
    const started = Date.now();
    try {
      this.ready ??= this.start(timeoutMs);
      await this.ready;
    } catch (e) {
      this.ready = null;
      this.kill();
      return { kind: "crash", message: String((e as Error).message) };
    }
    const child = this.child;
    if (!child) return { kind: "crash", message: "render process is gone" };
    this.seq += 1;
    const id = this.seq;
    return new Promise<RenderOutcome>((resolve) => {
      let settled = false;
      const finish = (o: RenderOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onMsg = null;
        this.onExit = null;
        resolve(o);
      };
      const timer = setTimeout(
        () => {
          this.kill();
          finish({ kind: "timeout" });
        },
        Math.max(1, timeoutMs - (Date.now() - started)),
      );
      this.onExit = (why) => finish({ kind: "crash", message: why });
      this.onMsg = (m) => {
        if (m.t === "fetch") {
          const req = { method: String(m.method), path: String(m.path), body: m.body ?? null };
          this.answer(req).then(
            (res) => {
              if (!settled && this.child === child)
                child.send({ t: "reply", id: m.id, ok: true, status: res.status, body: res.body });
            },
            () => {
              if (!settled && this.child === child) child.send({ t: "reply", id: m.id, ok: false });
            },
          );
        } else if (m.t === "done" && m.id === id) {
          finish({
            kind: "done",
            ok: m.ok === true,
            ...(typeof m.html === "string" ? { html: m.html } : {}),
            ...(typeof m.error === "string" ? { error: m.error } : {}),
            ...(typeof m.passes === "number" ? { passes: m.passes } : {}),
            ...(typeof m.loading === "number" ? { loading: m.loading } : {}),
            logs: Array.isArray(m.logs)
              ? (m.logs as unknown[]).slice(0, 50).map((l) => ({
                  level: String((l as { level?: unknown })?.level ?? ""),
                  text: String((l as { text?: unknown })?.text ?? "").slice(0, 500),
                }))
              : [],
          });
        } else if (m.t === "fatal") finish({ kind: "crash", message: String(m.message) });
      };
      child.send({ t: "render", id, ...job });
    });
  }

  kill(): void {
    const c = this.child;
    this.child = null;
    this.ready = null;
    if (c && c.exitCode === null) c.kill("SIGKILL");
  }
}
