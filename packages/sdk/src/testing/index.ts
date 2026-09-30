// @wizard/sdk/testing — createTestHost(spec): run functions against in-memory tables with the spec's
// permission matrix (ops, rowFilter/rowFilterOps, hiddenFields, readonlyFields), no Postgres needed.
import { type AppSpec, validateSpec } from "@wizard/appspec";
import { WizardError } from "../errors.js";
import {
  CallMeter,
  createDbFacade,
  DEFAULT_LIMITS,
  type Limits,
  type RawDoc,
  type RawWhere,
} from "../host/db.js";
import {
  type CallResult,
  createFunctionHost,
  type FunctionHost,
  type FunctionHostOptions,
  SYSTEM_USER,
} from "../host/executor.js";
import { SYSTEM_ROLE } from "../host/permissions.js";
import type { CurrentUser, Id, PaginationOpts } from "../sdk.js";
import {
  createIdGenerator,
  type InvalidateEvent,
  MemoryTransactions,
  type StoredJob,
  type UserRecord,
} from "./memory.js";

export {
  createIdGenerator,
  type InvalidateEvent,
  MemoryDb,
  MemoryTransactions,
  type UserRecord,
} from "./memory.js";

/** Untyped table API for tests written outside a generated app (inside an app use Doc<E>/DbWriter). */
export interface LooseTable {
  get(id: string): Promise<RawDoc | null>;
  getBy(field: string, value: unknown): Promise<RawDoc | null>;
  list(opts?: { where?: RawWhere; order?: "asc" | "desc"; limit?: number }): Promise<RawDoc[]>;
  first(opts?: { where?: RawWhere; order?: "asc" | "desc" }): Promise<RawDoc | null>;
  count(opts?: { where?: RawWhere }): Promise<number>;
  paginate(
    opts: { where?: RawWhere; order?: "asc" | "desc" },
    page: PaginationOpts,
  ): Promise<{ items: RawDoc[]; continueCursor: string | null; isDone: boolean }>;
  insert(doc: RawDoc): Promise<string>;
  patch(id: string, patch: RawDoc): Promise<void>;
  delete(id: string): Promise<void>;
}
export type LooseDb = Readonly<Record<string, LooseTable>>;

export interface ConnectorCall {
  integration: string;
  method: string;
  input: unknown;
}

export interface TestHostOptions {
  /** name → default export of functions/<file>.ts */
  functions?: Readonly<Record<string, unknown>>;
  /** Start time of the controllable clock (default: real now). */
  now?: Date | string;
  /** Override connector clients per integration name (defaults record calls and succeed). */
  connectors?: Readonly<Record<string, unknown>>;
  limits?: Partial<Limits>;
  /** Validate the spec with @wizard/appspec validateSpec (default true; false when the spec is newer than appspec). */
  validate?: boolean;
  log?: FunctionHostOptions["log"];
}

export interface JobRun {
  id: string;
  name: string;
  ok: boolean;
  result?: unknown;
  error?: unknown;
}

export interface TestHost {
  readonly spec: AppSpec;
  readonly functions: FunctionHost;
  /** Creates a row of the system `users` entity. Contacts (phone, email, telegram_*) stay host-only. */
  createUser(role: string, record?: Readonly<Record<string, unknown>>): CurrentUser & { id: Id<"users"> };
  /** Public-role (anonymous) user. */
  anonymous(role: string): CurrentUser;
  /**
   * POST /api/fn/:name semantics (public, roles, collectsPii consent). Returns `result`; throws WizardError.
   * `consent: true` stands for a valid `_consent` body field.
   */
  call(name: string, args: unknown, user: CurrentUser, opts?: { consent?: boolean }): Promise<unknown>;
  /** Like `call` but returns `{result, deps}` and allows `via: "internal"`. */
  callRaw(
    name: string,
    args: unknown,
    user: CurrentUser,
    via?: "api" | "internal",
    opts?: { consent?: boolean },
  ): Promise<CallResult>;
  /** Runs code in one write transaction with `db` acting as `user` (data API semantics) and `systemDb`. */
  run<T>(user: CurrentUser, fn: (db: LooseDb, systemDb: LooseDb) => Promise<T>): Promise<T>;
  /** Inserts rows as `__system`; returns ids. */
  seed(entity: string, docs: readonly RawDoc[]): Promise<string[]>;
  /** Committed rows of an entity (raw, including hidden fields). */
  rows(entity: string): RawDoc[];
  /** Pending scheduled jobs. */
  jobs(): StoredJob[];
  /** Runs jobs due at the current clock as `__system` (at-least-once semantics are not simulated). */
  runDueJobs(): Promise<JobRun[]>;
  now(): Date;
  setNow(d: Date | string): void;
  advance(ms: number): void;
  /** Invalidation events published after each commit. */
  readonly events: InvalidateEvent[];
  readonly connectorCalls: ConnectorCall[];
}

const TEST_CONSENT = { policyVersion: "test", textHash: "test" };

const CONNECTOR_METHODS: Record<string, Record<string, (input: unknown) => unknown>> = {
  telegram: { sendToUser: () => ({ delivered: true }) },
  email: { sendTemplate: () => ({ messageId: `test-${Math.random().toString(36).slice(2, 10)}` }) },
  yookassa: {
    refund: () => ({
      refundId: `test-refund-${Math.random().toString(36).slice(2, 10)}`,
      status: "succeeded",
    }),
    getPaymentStatus: () => "none",
  },
  qr: { revoke: () => undefined },
};

export function createTestHost(specInput: AppSpec | unknown, opts: TestHostOptions = {}): TestHost {
  let spec: AppSpec;
  if (opts.validate === false) spec = specInput as AppSpec;
  else {
    const r = validateSpec(specInput);
    if (!r.ok) {
      throw new Error(
        `createTestHost: invalid spec: ${r.errors.map((e) => `${e.code} ${e.path}`).join("; ")}`,
      );
    }
    spec = r.spec;
  }

  let clockMs = opts.now ? new Date(opts.now).getTime() : Date.now();
  const clock = () => new Date(clockMs);
  const newId = createIdGenerator();
  const users = new Map<string, UserRecord>();
  const events: InvalidateEvent[] = [];
  const connectorCalls: ConnectorCall[] = [];
  const tx = new MemoryTransactions({ spec, clock, newId, users, onCommit: (e) => events.push(...e) });
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const entities = spec.entities.map((e) => e.name);

  const connectors: Record<string, unknown> = {};
  for (const integ of spec.integrations ?? []) {
    const override = opts.connectors?.[integ.name];
    if (override) {
      connectors[integ.name] = override;
      continue;
    }
    const methods = CONNECTOR_METHODS[integ.connector] ?? {};
    const client: Record<string, (input: unknown) => Promise<unknown>> = {};
    for (const [method, impl] of Object.entries(methods)) {
      client[method] = async (input) => {
        connectorCalls.push({ integration: integ.name, method, input });
        return impl(input);
      };
    }
    connectors[integ.name] = client;
  }

  const functions = createFunctionHost({
    spec,
    functions: opts.functions ?? {},
    transactions: tx,
    connectors: () => connectors,
    limits,
    clock,
    retryDelay: async () => {},
    log: opts.log,
  });

  const roleOf = (role: string) => {
    const r = spec.roles.find((x) => x.name === role);
    if (!r) throw new Error(`createTestHost: unknown role ${role}`);
    return r;
  };

  const host: TestHost = {
    spec,
    functions,
    events,
    connectorCalls,
    createUser(role, record = {}) {
      const r = roleOf(role);
      const id = newId();
      const row: UserRecord = { display_name: `Тест ${role}`, ...record, id, role };
      users.set(id, row);
      return {
        id: id as Id<"users">,
        role: role as CurrentUser["role"],
        attrs: { display_name: String(row.display_name) },
        isAdmin: r.isAdmin === true,
      };
    },
    anonymous(role) {
      const r = roleOf(role);
      return { id: null, role: role as CurrentUser["role"], attrs: {}, isAdmin: r.isAdmin === true };
    },
    async call(name, args, user, o) {
      return (await host.callRaw(name, args, user, "api", o)).result;
    },
    callRaw(name, args, user, via = "api", o = {}) {
      return functions.call(name, args, { user, via, ...(o.consent ? { consent: TEST_CONSENT } : {}) });
    },
    run(user, fn) {
      return tx.run("write", user, async (t) => {
        const meter = new CallMeter({
          ...limits,
          maxReads: Number.POSITIVE_INFINITY,
          maxWrites: Number.POSITIVE_INFINITY,
        });
        const db = createDbFacade(t.db, entities, meter, { readOnly: false }) as unknown as LooseDb;
        const systemDb = createDbFacade(t.systemDb, entities, meter, {
          readOnly: false,
        }) as unknown as LooseDb;
        return fn(db, systemDb);
      });
    },
    seed(entity, docs) {
      return host.run(SYSTEM_USER, async (_db, systemDb) => {
        const table = systemDb[entity];
        if (!table) throw new WizardError("NOT_FOUND", { message: `Сущность ${entity} не найдена` });
        const ids: string[] = [];
        for (const d of docs) ids.push(await table.insert(d));
        return ids;
      });
    },
    rows(entity) {
      return [...(tx.state.tables.get(entity)?.values() ?? [])].map((r) => ({ ...r }));
    },
    jobs() {
      return [...tx.state.jobs.values()].map((j) => ({ ...j }));
    },
    async runDueJobs() {
      const due = [...tx.state.jobs.values()]
        .filter((j) => j.runAt.getTime() <= clockMs)
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
      const out: JobRun[] = [];
      for (const job of due) {
        await tx.run("write", SYSTEM_USER, async (t) => t.scheduler.cancel(job.id));
        try {
          const r = await functions.call(job.name, job.args, { user: SYSTEM_USER, via: "internal" });
          out.push({ id: job.id, name: job.name, ok: true, result: r.result });
        } catch (error) {
          out.push({ id: job.id, name: job.name, ok: false, error });
        }
      }
      return out;
    },
    now: clock,
    setNow(d) {
      clockMs = new Date(d).getTime();
    },
    advance(ms) {
      clockMs += ms;
    },
  };
  return host;
}

export { SYSTEM_ROLE, SYSTEM_USER };
