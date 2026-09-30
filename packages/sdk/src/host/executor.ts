// Function execution contract (sdk.md §2, runtime.yaml#functions). apps/runtime supplies a
// TransactionRunner over Postgres; createTestHost supplies an in-memory one. Isolation (vm/worker,
// hard timeouts for synchronous loops) stays in the runtime.
import type { AppSpec } from "@wizard/appspec";
import { isFunctionDef, type RegisteredFunction } from "../define.js";
import { makeError, WizardError } from "../errors.js";
import type { CurrentUser, ErrorDetails, FnKind, HttpClient, Json, LogFields, Logger } from "../types.js";
import { validateArgs } from "../validators.js";
import { CallMeter, createDbFacade, type DbAdapter, DEFAULT_LIMITS, jsonBytes, type Limits } from "./db.js";
import { functionAllowsRole, SYSTEM_ROLE } from "./permissions.js";

export interface ScheduledJob {
  runAt: Date;
  name: string;
  args: unknown;
}

/** Outbox writer bound to a transaction (runtime.yaml#postgres.system_tables._w_jobs). */
export interface SchedulerAdapter {
  enqueue(job: ScheduledJob): Promise<string>;
  cancel(jobId: string): Promise<void>;
}

/** Handles valid inside one transaction. `db` acts as the subject; `systemDb` as `__system`. */
export interface TxContext {
  db: DbAdapter;
  systemDb: DbAdapter;
  scheduler: SchedulerAdapter;
  /** Transaction start time (ctx.now). */
  now: Date;
}

export type TxMode = "read" | "write";

/**
 * Runs `fn` in one transaction: read → REPEATABLE READ READ ONLY, write → SERIALIZABLE (sdk.md §2.2).
 * MUST roll back when `fn` rejects and publish invalidation events only after commit.
 * Serialization failures are rethrown with `code` "40001" or "40P01" so the executor can retry.
 */
export interface TransactionRunner {
  run<T>(mode: TxMode, user: CurrentUser, fn: (tx: TxContext) => Promise<T>): Promise<T>;
}

export interface CallOptionsHost {
  user: CurrentUser;
  /** "api" = POST /api/fn/:name: only public functions and allowed roles. "internal" = scheduler/workflows. */
  via?: "api" | "internal";
}

export interface CallResult {
  result: unknown;
  /** Entities read during the call (sdk.md §3 useQuery invalidation). */
  deps: string[];
}

/** What apps/runtime exposes to its HTTP layer and scheduler. */
export interface FunctionHost {
  call(name: string, args: unknown, opts: CallOptionsHost): Promise<CallResult>;
}

export interface FunctionHostOptions {
  spec: AppSpec;
  /** name → default export of functions/<file>.ts */
  functions: Readonly<Record<string, unknown>>;
  transactions: TransactionRunner;
  /** Connector clients for actions, keyed by integration name (the host resolves recipients). */
  connectors?: (user: CurrentUser) => Readonly<Record<string, unknown>>;
  /** ctx.http for actions; M0–M1: absent → EGRESS_DISABLED. */
  http?: (fnName: string) => HttpClient;
  log?: (level: "info" | "warn" | "error", msg: string, fields: LogFields, fn: string) => void;
  limits?: Partial<Limits>;
  clock?: () => Date;
  /** Retry delay for serialization failures; default 10–50 ms jitter. */
  retryDelay?: () => Promise<void>;
  maxRetries?: number;
}

export const SYSTEM_USER: CurrentUser = Object.freeze({
  id: null,
  role: SYSTEM_ROLE,
  attrs: Object.freeze({}),
  isAdmin: false,
}) as CurrentUser;

export function isSerializationFailure(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "40001" || code === "40P01";
}

function sanitizeLogFields(fields: LogFields | undefined): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    // Strings (except ids, which the type system allows as Id) are masked: sdk.md §2.5.
    out[k] = typeof v === "number" || typeof v === "boolean" || v === null ? v : ("***" as unknown as number);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WizardError("TIMEOUT")), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function defaultRetryDelay(): Promise<void> {
  return new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 41)));
}

export function createFunctionHost(o: FunctionHostOptions): FunctionHost {
  const limits: Limits = { ...DEFAULT_LIMITS, ...o.limits };
  const entities = o.spec.entities.map((e) => e.name);
  const clock = o.clock ?? (() => new Date());
  const maxRetries = o.maxRetries ?? 3;
  const retryDelay = o.retryDelay ?? defaultRetryDelay;

  function resolve(name: string): { def: RegisteredFunction; kind: FnKind } {
    const meta = o.spec.functions?.find((f) => f.name === name);
    const def = o.functions[name];
    if (!meta || !isFunctionDef(def)) {
      throw new WizardError("NOT_FOUND", { message: "Функция не найдена" });
    }
    if (def.kind !== meta.kind) {
      throw new WizardError("INTERNAL", { message: "Вид функции не совпадает со спецификацией" });
    }
    return { def, kind: def.kind };
  }

  function logger(fn: string): Logger {
    const emit = (level: "info" | "warn" | "error") => (msg: string, f?: LogFields) =>
      o.log?.(level, msg, sanitizeLogFields(f), fn);
    return { info: emit("info"), warn: emit("warn"), error: emit("error") };
  }

  function schedulerFor(adapter: () => Promise<SchedulerAdapter> | SchedulerAdapter, now: () => Date) {
    const enqueue = async (at: Date, name: string, args: unknown) => {
      if (!o.spec.functions?.some((f) => f.name === name)) {
        throw new WizardError("NOT_FOUND", { message: `Функция ${name} не найдена` });
      }
      return (await adapter()).enqueue({ runAt: at, name, args });
    };
    return {
      runAfter: (delayMs: number, name: string, args: unknown) =>
        enqueue(new Date(now().getTime() + Math.max(0, delayMs)), name, args),
      runAt: (at: Date | string, name: string, args: unknown) => {
        const d = at instanceof Date ? at : new Date(at);
        if (Number.isNaN(d.getTime()))
          throw new WizardError("VALIDATION_FAILED", { message: "Неверная дата" });
        return enqueue(d, name, args);
      },
      cancel: async (id: string) => (await adapter()).cancel(id),
    };
  }

  function baseCtx(user: CurrentUser, now: Date, fn: string) {
    return {
      user,
      now,
      error: (code: string, details?: ErrorDetails) => makeError(code, details),
      log: logger(fn),
    };
  }

  async function runTx(
    kind: "query" | "mutation",
    def: RegisteredFunction,
    name: string,
    args: unknown,
    user: CurrentUser,
    meter: CallMeter,
  ): Promise<unknown> {
    const handler = def.handler as (ctx: unknown, args: unknown) => unknown;
    const readOnly = kind === "query";
    let attempt = 0;
    for (;;) {
      try {
        return await o.transactions.run(readOnly ? "read" : "write", user, async (tx) => {
          const db = createDbFacade(tx.db, entities, meter, { readOnly });
          const systemDb = createDbFacade(tx.systemDb, entities, meter, { readOnly });
          const ctx = readOnly
            ? { ...baseCtx(user, tx.now, name), db, systemDb }
            : {
                ...baseCtx(user, tx.now, name),
                db,
                systemDb,
                scheduler: schedulerFor(
                  () => tx.scheduler,
                  () => tx.now,
                ),
              };
          return withTimeout(
            Promise.resolve().then(() => handler(ctx, args)),
            readOnly ? limits.queryTimeoutMs : limits.mutationTimeoutMs,
          );
        });
      } catch (e) {
        if (!readOnly && isSerializationFailure(e) && attempt < maxRetries) {
          attempt += 1;
          meter.reads = 0;
          meter.writes = 0;
          await retryDelay();
          continue;
        }
        if (isSerializationFailure(e))
          throw new WizardError("CONFLICT", { message: "Данные изменились, повторите" });
        throw e;
      }
    }
  }

  async function runAction(
    def: RegisteredFunction,
    name: string,
    args: unknown,
    user: CurrentUser,
    meter: CallMeter,
  ): Promise<unknown> {
    const handler = def.handler as (ctx: unknown, args: unknown) => unknown;
    let calls = 0;
    const nested = (kind: "query" | "mutation") => async (n: string, a: unknown) => {
      calls += 1;
      if (calls > limits.maxRunCalls) {
        throw new WizardError("LIMIT_EXCEEDED", {
          message: `Не больше ${limits.maxRunCalls} вызовов runQuery/runMutation`,
          limit: "run_calls",
        });
      }
      const r = await invoke(n, a, user, kind);
      for (const d of r.deps) meter.deps.add(d);
      return r.result;
    };
    const now = clock();
    const ctx = {
      ...baseCtx(user, now, name),
      scheduler: schedulerFor(
        // Each scheduler call from an action is its own short write transaction.
        () => ({
          enqueue: (job: ScheduledJob) =>
            o.transactions.run("write", user, (tx) => tx.scheduler.enqueue(job)),
          cancel: (id: string) => o.transactions.run("write", user, (tx) => tx.scheduler.cancel(id)),
        }),
        clock,
      ),
      connectors: o.connectors?.(user) ?? {},
      http: o.http?.(name) ?? {
        fetch: async () => {
          throw new WizardError("EGRESS_DISABLED");
        },
      },
      runQuery: nested("query"),
      runMutation: nested("mutation"),
    };
    return withTimeout(
      Promise.resolve().then(() => handler(ctx, args)),
      limits.actionTimeoutMs,
    );
  }

  async function invoke(
    name: string,
    args: unknown,
    user: CurrentUser,
    expect?: FnKind,
  ): Promise<CallResult> {
    const { def, kind } = resolve(name);
    if (expect && kind !== expect) {
      throw new WizardError("FORBIDDEN", { message: `Функция ${name} не является ${expect}` });
    }
    const a = args ?? {};
    if (jsonBytes(a) > limits.maxArgsBytes) throw new WizardError("PAYLOAD_TOO_LARGE");
    const issues = validateArgs(def.args, a);
    if (issues.length > 0) {
      throw new WizardError("VALIDATION_FAILED", {
        message: "Проверьте заполнение полей",
        fields: issues.map((i) => ({ field: i.field, code: i.code, message: i.message })),
      });
    }
    const meter = new CallMeter(limits);
    const result =
      kind === "action"
        ? await runAction(def, name, a, user, meter)
        : await runTx(kind, def, name, a, user, meter);
    if (result !== undefined && jsonBytes(result) > limits.maxResultBytes) {
      throw new WizardError("LIMIT_EXCEEDED", { message: "Результат больше 4 МиБ", limit: "result_size" });
    }
    return {
      result: result === undefined ? null : (JSON.parse(JSON.stringify(result)) as Json),
      deps: [...meter.deps],
    };
  }

  return {
    async call(name, args, opts) {
      const user = opts.user;
      if (opts.via !== "internal") {
        const meta = o.spec.functions?.find((f) => f.name === name);
        if (meta?.public !== true) throw new WizardError("NOT_FOUND", { message: "Функция не найдена" });
        if (!functionAllowsRole(o.spec, name, user.role)) {
          throw new WizardError(user.id === null ? "UNAUTHENTICATED" : "FORBIDDEN");
        }
      }
      return invoke(name, args, user);
    },
  };
}
