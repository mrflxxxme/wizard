// Runtime side of M2 function execution (security/isolation.yaml#M2): calls go to the system's Worker in its sandbox
// pod over HTTP; every ctx.* call comes back through SandboxRpc with the capability token issued for this call.
// Same surface as the unsafe-local FunctionExecutor (exec/executor.ts), so exec/host.ts builds the FunctionHost
// over either of them.
import { type CurrentUser, type FnKind, WizardError } from "@wizard/sdk";
import type { GuestFunction, HostCtx } from "../exec/executor.js";
import type { SandboxEnv } from "./capability.js";
import type { SandboxRpc } from "./rpc.js";

/** What exec/host.ts needs from an executor (FunctionExecutor and WorkerdExecutor). */
export interface GuestExecutor {
  functions(): Promise<Record<string, GuestFunction>>;
  run(
    name: string,
    kind: FnKind,
    args: unknown,
    user: CurrentUser,
    now: Date,
    hostCtx: HostCtx,
    timeoutMs: number,
  ): Promise<unknown>;
  close(): void;
}

/** Executors of loaded systems in sandbox mode (RuntimeServices.sandbox). */
export interface SandboxExecutors {
  /**
   * Makes the system's Worker run this functions source before executorFor (the orchestrator places it and starts or
   * replaces its pod, M2-18). Absent when pods are placed elsewhere (tests with a fixed endpoint).
   */
  prepare?(sys: {
    systemId: string;
    env: SandboxEnv;
    entities: readonly string[];
    functionsSource: string;
  }): Promise<void>;
  executorFor(sys: { systemId: string; env: SandboxEnv; entities: readonly string[] }): GuestExecutor;
  /**
   * Frees the system's slot (V3-18: the runtime dropped it — unpublished, deleted, evicted, unpinned); resync: false
   * leaves the pod's other systems running as they are.
   */
  remove?(systemId: string, env: SandboxEnv, o?: { resync?: boolean }): Promise<void>;
  /** Systems whose slot was freed by the sandbox itself (idle, excluded for hanging): the runtime drops its copy. */
  onReleased?(listener: (systemId: string, env: SandboxEnv) => void): void;
}

/** An endpoint held for one call: a replaced pod is removed only after the calls it was given have released it. */
export interface EndpointLease {
  endpoint: string;
  release(): void;
  /** The call hit its time limit or lost its connection (the orchestrator's watchdog blames its system on a restart). */
  fail?(): void;
}

/** Below this much of its time limit left, a call is not started (it could only time out). */
export const MIN_CALL_MS = 50;
const RESTARTING = "Песочница функций перезапускается";

export interface WorkerdExecutorOptions {
  /**
   * Base URL of the system's socket in its pod (http://<pod-ip>:<basePort + slot>); a function is asked on every
   * call (pods restart with new addresses). null → the system is not placed (503 FUNCTIONS_DISABLED).
   */
  endpoint: string | (() => string | null);
  /**
   * Instead of `endpoint` (the orchestrator): the endpoint held for one call, waited for at most waitMs while the
   * system's pod is (re)starting; rejects with FUNCTIONS_DISABLED.
   */
  lease?: (waitMs: number) => Promise<EndpointLease>;
  systemId: string;
  env: SandboxEnv;
  rpc: SandboxRpc;
  fetch?: typeof fetch;
  /** Loading the function list (default 10 s). */
  loadTimeoutMs?: number;
  /** A call hit its wall limit: the pod may be stuck in a loop (liveness restarts it; tests restart workerd). */
  onTimeout?: () => void;
}

const CODE_RE = /^[A-Z][A-Z0-9_]{2,40}$/;

function isAbort(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

export class WorkerdExecutor implements GuestExecutor {
  private readonly f: typeof fetch;
  private closed = false;

  constructor(private readonly o: WorkerdExecutorOptions) {
    this.f = o.fetch ?? fetch;
  }

  /**
   * The endpoint for one call within its time limit: waiting for a restarting pod counts against it, and a call left
   * with less than MIN_CALL_MS is not started — it never runs after its caller gave up. Returns the time left.
   */
  private async acquire(limitMs: number): Promise<Required<EndpointLease> & { left: number }> {
    const started = Date.now();
    let lease: EndpointLease;
    if (this.o.lease) lease = await this.o.lease(limitMs);
    else {
      const e = typeof this.o.endpoint === "function" ? this.o.endpoint() : this.o.endpoint;
      if (!e) throw new WizardError("FUNCTIONS_DISABLED", { message: "Функции системы не загружены" });
      lease = { endpoint: e, release: () => {} };
    }
    const left = limitMs - (Date.now() - started);
    if (left < MIN_CALL_MS) {
      lease.release();
      throw new WizardError("FUNCTIONS_DISABLED", { message: RESTARTING });
    }
    return { endpoint: lease.endpoint, release: () => lease.release(), fail: () => lease.fail?.(), left };
  }

  async functions(): Promise<Record<string, GuestFunction>> {
    const { endpoint: base, release, left } = await this.acquire(this.o.loadTimeoutMs ?? 10_000);
    try {
      const res = await this.f(`${base}/__wizard/functions`, { signal: AbortSignal.timeout(left) });
      if (!res.ok) throw new Error(`sandbox functions: HTTP ${res.status}`);
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null || Array.isArray(body))
        throw new Error("sandbox functions: shape");
      return body as Record<string, GuestFunction>;
    } finally {
      release();
    }
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
    if (this.closed) throw new WizardError("INTERNAL");
    const { endpoint: base, release, fail, left } = await this.acquire(timeoutMs);
    const call = this.o.rpc.open({ systemId: this.o.systemId, env: this.o.env, hostCtx, timeoutMs: left });
    try {
      let res: Response;
      try {
        res = await this.f(`${base}/__wizard/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            token: call.token,
            name,
            kind,
            args,
            now: now.toISOString(),
            user: { id: user.id, role: user.role, isAdmin: user.isAdmin, attrs: { ...user.attrs } },
          }),
          signal: AbortSignal.timeout(left),
        });
      } catch (e) {
        fail();
        if (isAbort(e)) {
          this.o.onTimeout?.();
          throw new WizardError("TIMEOUT");
        }
        throw new WizardError("INTERNAL");
      }
      const out = (await res.json().catch(() => null)) as {
        ok?: boolean;
        value?: unknown;
        error?: { code?: unknown; details?: unknown };
      } | null;
      if (call.fatal !== undefined) throw call.fatal;
      if (!res.ok || !out) throw new WizardError("INTERNAL");
      if (out.ok === true) return out.value ?? null;
      const code =
        typeof out.error?.code === "string" && CODE_RE.test(out.error.code) ? out.error.code : "INTERNAL";
      const details =
        typeof out.error?.details === "object" &&
        out.error.details !== null &&
        !Array.isArray(out.error.details)
          ? out.error.details
          : {};
      throw new WizardError(code, details as Record<string, never>);
    } finally {
      // The token dies with the call: replaying it later gets 403 even before exp.
      call.close();
      release();
    }
  }

  close(): void {
    this.closed = true;
  }
}

/** SandboxExecutors over a placement lookup: systemId/env → base URL of its Worker socket (null → not placed). */
export function createWorkerdSandbox(o: {
  rpc: SandboxRpc;
  endpointOf: (systemId: string, env: SandboxEnv) => string | null;
  fetch?: typeof fetch;
  onTimeout?: (systemId: string, env: SandboxEnv) => void;
}): SandboxExecutors {
  return {
    executorFor(sys) {
      if (!o.endpointOf(sys.systemId, sys.env)) {
        throw new WizardError("FUNCTIONS_DISABLED", { message: "Функции системы не загружены" });
      }
      return new WorkerdExecutor({
        endpoint: () => o.endpointOf(sys.systemId, sys.env),
        systemId: sys.systemId,
        env: sys.env,
        rpc: o.rpc,
        ...(o.fetch ? { fetch: o.fetch } : {}),
        onTimeout: () => o.onTimeout?.(sys.systemId, sys.env),
      });
    },
  };
}
