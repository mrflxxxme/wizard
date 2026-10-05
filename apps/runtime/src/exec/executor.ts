// Parent side of the unsafe-local function executor (security/isolation.yaml#M0_M1): a pool of Node child
// processes (./child.mjs) per bundle, IPC protocol, per-call deadlines with SIGKILL, host ctx dispatch.
import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type CurrentUser, type FnKind, WizardError } from "@wizard/sdk";
import { isSerializationFailure } from "@wizard/sdk/host";

export const CHILD_PATH = fileURLToPath(new URL("./child.mjs", import.meta.url));
/** Guest runtime shared with the M2 workerd Worker; the only file outside the bundle the child may read. */
export const GUEST_PATH = fileURLToPath(new URL("../sandbox/guest.mjs", import.meta.url));
/** Hard ceiling of any call in unsafe-local mode (sdk.md §2.1). */
export const UNSAFE_CEILING_MS = 5000;

/**
 * Node flags of an executor process: permission model with read access to the bundle folder (and the guest runtime
 * file) only, no --allow-child-process / --allow-worker / --allow-addons; bounded heap. Spawned with env {} and no
 * argv.
 */
export function executorFlags(bundleDir: string, maxOldSpaceMb = 128): string[] {
  return [
    "--permission",
    `--allow-fs-read=${bundleDir}`,
    `--allow-fs-read=${GUEST_PATH}`,
    "--experimental-vm-modules",
    "--disable-warning=ExperimentalWarning",
    `--max-old-space-size=${maxOldSpaceMb}`,
  ];
}

/** Validator descriptor as reported by the child (see child.mjs serValidator). */
export interface SerializedValidator {
  kind: string;
  isOptional?: boolean;
  min?: number;
  max?: number;
  entity?: string;
  value?: unknown;
  values?: unknown[];
  pattern?: { source: string; flags: string };
  item?: SerializedValidator;
  inner?: SerializedValidator;
  shape?: Record<string, SerializedValidator>;
}

export interface GuestFunction {
  kind: FnKind;
  args: Record<string, SerializedValidator>;
}

/** ctx built by createFunctionHost for one call; the child reaches it only through `dispatch`. */
export type HostCtx = Readonly<Record<string, unknown>>;

export interface ExecutorOptions {
  /** Absolute artifact folder: the only path the child may read. */
  bundleDir: string;
  entities: readonly string[];
  maxProcesses?: number;
  /** Idle processes are stopped after this delay (default 60 s). */
  idleMs?: number;
  maxOldSpaceMb?: number;
  /** Timeout of spawning + loading the bundle (default 10 s). */
  loadTimeoutMs?: number;
}

export class FunctionsLoadError extends Error {
  override name = "FunctionsLoadError";
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  hostCtx: HostCtx;
  timer: ReturnType<typeof setTimeout>;
  /** Error that must fail the call even if the guest swallowed it (serialization failure, limits). */
  fatal?: unknown;
}

export type ChildMsg = Record<string, unknown>;

const DB_METHODS = new Set([
  "get",
  "getBy",
  "list",
  "first",
  "count",
  "paginate",
  "insert",
  "patch",
  "delete",
]);
const SCHEDULER_METHODS = new Set(["runAfter", "runAt", "cancel"]);

/** Process currently executing the handler whose ctx call is being served (routes nested runQuery/runMutation). */
const current = new AsyncLocalStorage<ExecProcess>();

function own(o: unknown, key: unknown): unknown {
  if (typeof o !== "object" || o === null || typeof key !== "string") return undefined;
  return Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined;
}

export function errorPayload(e: unknown): { code: string; details: unknown } {
  return e instanceof WizardError ? { code: e.code, details: e.details } : { code: "INTERNAL", details: {} };
}

/** Host errors that fail the whole call even if guest code catches them (internal, limits, serialization). */
export function isFatalHostError(e: unknown): boolean {
  const code = e instanceof WizardError ? e.code : null;
  return code === null || code === "LIMIT_EXCEEDED" || code === "TIMEOUT" || isSerializationFailure(e);
}

/** Executes one guest request against the host ctx; everything the child sends is untrusted. */
export async function dispatch(ctx: HostCtx, m: ChildMsg): Promise<unknown> {
  const params = Array.isArray(m.params) ? (m.params as unknown[]) : [];
  const forbidden = () => new WizardError("FORBIDDEN", { message: "Операция недоступна в этой функции" });
  switch (m.op) {
    case "db": {
      if (m.target !== "db" && m.target !== "systemDb") throw forbidden();
      const table = own(own(ctx, m.target), m.entity);
      const fn = own(table, m.method);
      if (!DB_METHODS.has(String(m.method)) || typeof fn !== "function") throw forbidden();
      return fn(...params);
    }
    case "scheduler": {
      const fn = own(own(ctx, "scheduler"), m.method);
      if (!SCHEDULER_METHODS.has(String(m.method)) || typeof fn !== "function") throw forbidden();
      return fn(...params);
    }
    case "run": {
      const fn = own(ctx, m.kind === "query" ? "runQuery" : m.kind === "mutation" ? "runMutation" : "");
      if (typeof fn !== "function") throw forbidden();
      return fn(String(m.name), m.args ?? {});
    }
    case "http": {
      // M2-52: ctx.http.fetch — the host client decides (hosts, limits, secrets); only JSON crosses back.
      const fetchFn = own(own(ctx, "http"), "fetch");
      if (typeof fetchFn !== "function") throw new WizardError("EGRESS_DISABLED");
      const init = typeof m.init === "object" && m.init !== null && !Array.isArray(m.init) ? m.init : {};
      const r = (await fetchFn(String(m.url ?? ""), init)) as {
        status: number;
        contentType?: string | null;
        text(): Promise<string>;
      };
      return { status: r.status, contentType: r.contentType ?? null, body: await r.text() };
    }
    case "connector": {
      const fn = own(own(own(ctx, "connectors"), m.integration), m.method);
      if (typeof fn !== "function") {
        throw new WizardError("NOT_FOUND", { message: "Интеграция или действие не найдены" });
      }
      return fn(m.input);
    }
    default:
      throw forbidden();
  }
}

class ExecProcess {
  readonly child: ChildProcess;
  readonly ready: Promise<Record<string, GuestFunction>>;
  dead = false;
  private seq = 0;
  private readonly calls = new Map<number, Pending>();
  private settleReady: { resolve(v: Record<string, GuestFunction>): void; reject(e: unknown): void };
  private killedFor: "timeout" | "close" | null = null;

  constructor(
    readonly owner: FunctionExecutor,
    o: Required<Pick<ExecutorOptions, "bundleDir" | "maxOldSpaceMb" | "loadTimeoutMs">> & {
      entities: readonly string[];
    },
  ) {
    let settle!: typeof this.settleReady;
    this.ready = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.settleReady = settle;
    this.ready.catch(() => {});
    this.child = spawn(process.execPath, [...executorFlags(o.bundleDir, o.maxOldSpaceMb), CHILD_PATH], {
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.child.on("message", (m: ChildMsg) => this.onMessage(m));
    this.child.on("exit", (code, signal) => this.onExit(code, signal));
    this.child.on("error", () => this.onExit(null, null));
    const loadTimer = setTimeout(() => {
      this.settleReady.reject(new FunctionsLoadError("functions bundle load timed out"));
      this.kill("close");
    }, o.loadTimeoutMs);
    this.ready.finally(() => clearTimeout(loadTimer)).catch(() => {});
    this.child.send({ t: "init", dir: o.bundleDir, entities: [...o.entities] });
    this.setRef(true);
  }

  private setRef(on: boolean): void {
    const ch = this.child.channel as { ref?: () => void; unref?: () => void } | undefined;
    if (on) {
      this.child.ref();
      ch?.ref?.();
    } else {
      this.child.unref();
      ch?.unref?.();
    }
  }

  get inFlight(): number {
    return this.calls.size;
  }

  run(
    name: string,
    kind: FnKind,
    args: unknown,
    user: CurrentUser,
    now: Date,
    hostCtx: HostCtx,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.dead) return Promise.reject(new WizardError("INTERNAL"));
    this.seq += 1;
    const id = this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.kill("timeout"), timeoutMs);
      this.calls.set(id, { resolve, reject, hostCtx, timer });
      this.setRef(true);
      this.child.send({
        t: "call",
        id,
        name,
        kind,
        args,
        now: now.toISOString(),
        user: { id: user.id, role: user.role, isAdmin: user.isAdmin, attrs: { ...user.attrs } },
      });
    });
  }

  private settle(id: number, fn: (p: Pending) => void): void {
    const p = this.calls.get(id);
    if (!p) return;
    this.calls.delete(id);
    clearTimeout(p.timer);
    if (this.calls.size === 0) this.setRef(false);
    fn(p);
  }

  private onMessage(m: ChildMsg): void {
    if (typeof m !== "object" || m === null) return;
    switch (m.t) {
      case "ready":
        this.settleReady.resolve((m.fns ?? {}) as Record<string, GuestFunction>);
        this.setRef(false);
        return;
      case "load_error":
        this.settleReady.reject(new FunctionsLoadError(String(m.message)));
        this.kill("close");
        return;
      case "req":
        void this.onRequest(m);
        return;
      case "log": {
        const p = this.calls.get(Number(m.call));
        const log = own(p?.hostCtx, "log");
        const fn = own(log, m.level);
        if (typeof fn === "function") {
          const fields = typeof m.fields === "object" && m.fields !== null ? m.fields : {};
          fn(String(m.msg).slice(0, 1000), fields);
        }
        return;
      }
      case "done":
        this.settle(Number(m.id), (p) => {
          if (p.fatal !== undefined) return p.reject(p.fatal);
          if (m.ok === true) return p.resolve(m.value);
          const err = (m.error ?? {}) as { code?: unknown; details?: unknown };
          const code = typeof err.code === "string" ? err.code : "INTERNAL";
          const details = typeof err.details === "object" && err.details !== null ? err.details : {};
          p.reject(new WizardError(code, details as Record<string, never>));
        });
        return;
    }
  }

  private async onRequest(m: ChildMsg): Promise<void> {
    const p = this.calls.get(Number(m.call));
    let reply: Record<string, unknown>;
    if (!p) {
      reply = { ok: false, error: { code: "INTERNAL", details: {} } };
    } else {
      try {
        const value = await current.run(this, () => dispatch(p.hostCtx, m));
        reply = { ok: true, value: value === undefined ? null : value };
      } catch (e) {
        if (isFatalHostError(e)) p.fatal ??= e;
        reply = { ok: false, error: errorPayload(e) };
      }
    }
    if (!this.dead && this.child.connected) {
      this.child.send({ t: "reply", call: m.call, id: m.id, ...reply });
    }
  }

  kill(reason: "timeout" | "close"): void {
    if (this.dead) return;
    this.killedFor = reason;
    this.child.kill("SIGKILL");
    this.fail();
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (!this.dead) {
      this.settleReady.reject(new FunctionsLoadError(`executor exited (${code ?? signal})`));
    }
    this.fail(code, signal);
  }

  private fail(code: number | null = null, signal: NodeJS.Signals | null = null): void {
    this.dead = true;
    this.owner.forget(this);
    const err =
      this.killedFor === "timeout"
        ? new WizardError("TIMEOUT")
        : signal === "SIGABRT" || code === 134
          ? new WizardError("LIMIT_EXCEEDED", { message: "Функции не хватило памяти", limit: "memory" })
          : new WizardError("INTERNAL");
    for (const id of [...this.calls.keys()]) this.settle(id, (p) => p.reject(err));
    this.setRef(false);
  }
}

/** Pool of executor processes for one bundle; one top-level call per process at a time. */
export class FunctionExecutor {
  private readonly all = new Set<ExecProcess>();
  private readonly idle: ExecProcess[] = [];
  private readonly waiters: (() => void)[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly o: Required<ExecutorOptions>;

  constructor(o: ExecutorOptions) {
    this.o = { maxProcesses: 4, idleMs: 60_000, maxOldSpaceMb: 128, loadTimeoutMs: 10_000, ...o };
  }

  /** Functions exported by the bundle (spawns one process and loads it). */
  async functions(): Promise<Record<string, GuestFunction>> {
    const p = await this.acquire();
    try {
      return await p.ready;
    } finally {
      this.release(p);
    }
  }

  /** Number of live processes (tests). */
  get size(): number {
    return this.all.size;
  }

  async run(
    name: string,
    kind: FnKind,
    args: unknown,
    user: CurrentUser,
    now: Date,
    hostCtx: HostCtx,
    timeoutMs: number,
  ): Promise<unknown> {
    const nested = current.getStore();
    if (nested && nested.owner === this && !nested.dead) {
      return nested.run(name, kind, args, user, now, hostCtx, timeoutMs);
    }
    const p = await this.acquire();
    try {
      return await p.run(name, kind, args, user, now, hostCtx, timeoutMs);
    } finally {
      this.release(p);
    }
  }

  private async acquire(): Promise<ExecProcess> {
    for (;;) {
      if (this.closed) throw new FunctionsLoadError("executor is closed");
      const p = this.idle.pop();
      if (p) {
        if (p.dead) continue;
        return p;
      }
      if (this.all.size < this.o.maxProcesses) {
        const fresh = new ExecProcess(this, this.o);
        this.all.add(fresh);
        try {
          await fresh.ready;
        } catch (e) {
          fresh.kill("close");
          this.wake();
          throw e;
        }
        return fresh;
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  private release(p: ExecProcess): void {
    if (!p.dead && !this.closed) {
      this.idle.push(p);
      this.armIdle();
    }
    this.wake();
  }

  private wake(): void {
    this.waiters.shift()?.();
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      for (const p of this.idle.splice(0)) p.kill("close");
    }, this.o.idleMs);
    this.idleTimer.unref();
  }

  /** Called by a process that died: frees its slot. */
  forget(p: ExecProcess): void {
    this.all.delete(p);
    const i = this.idle.indexOf(p);
    if (i >= 0) this.idle.splice(i, 1);
    this.wake();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const p of [...this.all]) p.kill("close");
    for (const w of this.waiters.splice(0)) w();
  }
}
