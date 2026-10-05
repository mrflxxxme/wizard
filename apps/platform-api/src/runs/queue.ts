// Run engine (workflows.yaml#execution): run lifecycle (#run_lifecycle), platform.locks, budget and the workflows
// interview_turn / build / publish / rollback. Three roles:
//   inprocess (M0, unit tests): in-process FIFO queue with global concurrency, restart recovery → WORKER_RESTARTED;
//   client (platform-api in M1): runs are enqueued as DBOS workflows (workflowID = runs.id), never executed here;
//   worker (apps/worker): executeRun() is the body of the DBOS workflow, every side effect is a checkpointed step.
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AppSpec } from "@wizard/appspec";
import {
  CircuitBreaker,
  createRegistry,
  createRouter,
  FixtureStore,
  LlmError,
  type RouteOutput,
  type Router,
  type RouterOptions,
} from "@wizard/llm";
import { createLogger } from "@wizard/pii/log";
import { type Selectable, sql } from "kysely";
import type postgres from "postgres";
import {
  backfillActions,
  httpRuntimeBackfill,
  type RuntimeAiBackfill,
  requestBackfills,
  runPendingBackfills,
} from "../ai/backfill.js";
import type { Billing } from "../billing/ledger.js";
import { assertPilotLimit } from "../billing/pilot-limits.js";
import type { Config } from "../config.js";
import { type Db, json } from "../db/index.js";
import type { RunsTable } from "../db/types.js";
import { ApiError } from "../errors.js";
import { ExportStore } from "../exports/storage.js";
import { type ExportRunInput, runExport } from "../exports/workflow.js";
import { recordDevelopmentRequest } from "../gaps/service.js";
import { ImportStore } from "../imports/storage.js";
import { IMPORT_CAP_MILLI, type ImportRunInput, runImportTable } from "../imports/workflow.js";
import { recordRunEnd, runsStarted } from "../ops/metrics.js";
import type { PublishOptions } from "../publish/prod.js";
import { draftSnapshot } from "../publish/snapshot.js";
import { type FlowHost, type FlowResult, runPublish, runRollback } from "../publish/workflows.js";
import type { SecretStore } from "../secrets/store.js";
import { insertMessage } from "../services/messages.js";
import {
  applyOpsRevision,
  commitFilesRevision,
  isSafePath,
  loadManifest,
  loadSpec,
  lockSystem,
  type Manifest,
} from "../services/revisions.js";
import { assertTransition, canTransition, type Stage, stageAfterBuild } from "../services/stage.js";
import type { BlobStore } from "../storage/blobs.js";
import {
  type Durable,
  type InputMessage,
  inProcessDurable,
  LocalMailboxes,
  TOPIC_INPUT,
  TOPIC_LOCK,
} from "./durable.js";
import { appendEvent, type EventBus, type EventType, type TxCtx, withTx } from "./events.js";
import { recordGateReport } from "./gates.js";
import { MODELS_UNAVAILABLE_RU, reportModelsUnavailable } from "./models-outage.js";
import {
  type BuildHost,
  type BuildOutcome,
  type BuildParams,
  type GateContext,
  type GateLevel,
  type GateReport,
  type HostRouteInput,
  type InputAnswer,
  type InputRequest,
  type InterviewContext,
  type InterviewOutput,
  type PointEditTarget,
  RunCancelled,
  type RunExecutors,
  RunFailure,
  type SecretInputRequest,
  type StepHost,
} from "./types.js";
import { DbUsageSink } from "./usage.js";

export const ACTIVE_STATUSES = ["queued", "waiting_lock", "running", "needs_input"] as const;
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);
export const NEEDS_LOCK: ReadonlySet<string> = new Set(["build", "publish", "rollback", "import_table"]);
const PLATFORM_EVENTS: ReadonlySet<string> = new Set([
  "run_started",
  "run_finished",
  "run_failed",
  "lock_waiting",
]);
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
/** Durable lock waiters re-check the lock this often even without a hand-over message. */
const LOCK_POLL_MS = 10_000;
/** Worker: how often running runs look for cancel_requested_at (the current LLM call is aborted). */
const CANCEL_POLL_MS = 1_000;
export const INPUT_TIMEOUT_MS = 24 * 3600_000;
/** workflows.yaml#workflows.interview_turn.budget */
export const INTERVIEW_CAP_MILLI = 2000;
const TERMINAL = "\u0000terminal";
const fallbackLog = createLogger({ svc: "platform-api" });

type Run = Selectable<RunsTable>;
type Result =
  | {
      status: "succeeded" | "cancelled";
      summary_ru: string;
      resultRevision?: number | null;
      prodUrl?: string | null;
    }
  | { status: "failed"; code: string; message_ru: string; retryable: boolean };

/** M1 (role client): how platform-api hands runs and messages to DBOS (apps/worker implements the workflows). */
export interface RunDispatcher {
  /** Enqueues the run workflow (workflowID = runs.id; idempotent). */
  enqueue(run: { id: string; kind: string; system_id: string | null }): Promise<void>;
  /** DBOS.send to the run workflow. */
  send(runId: string, topic: string, message: unknown, idempotencyKey?: string): Promise<void>;
  close(): Promise<void>;
}

export type EngineRole = "inprocess" | "client" | "worker";

export interface EngineDeps {
  db: Db;
  pg: postgres.Sql;
  bus: EventBus;
  blobs: BlobStore;
  config: Config;
  executors: RunExecutors;
  /** Credits ledger (billing.yaml#run_charging). */
  billing: Billing;
  /** Default inprocess; client needs `dispatcher` (worker: DBOS.send for messages sent outside a workflow). */
  role?: EngineRole;
  dispatcher?: RunDispatcher;
  /** Connector secrets entered at needs_input kind=secret (execution.M1.dbos_data). */
  secrets?: SecretStore;
  /** Router factory (tests); default createRouter with DbUsageSink. */
  createRouter?: (opts: RouterOptions) => Router;
  log?: (msg: string, err?: unknown) => void;
  /** publish/rollback: smoke check, DB roles, lock retry pauses (M1-04). */
  publish?: PublishOptions;
  /** M3-02: AI backfill on the runtime (default: HTTP to WIZARD_RUNTIME_INTERNAL_URL with WIZARD_INTERNAL_TOKEN). */
  aiBackfill?: RuntimeAiBackfill | null;
}

export interface NewRun {
  orgId: string;
  systemId: string;
  kind: "interview_turn" | "build" | "publish" | "rollback" | "import_table" | "export";
  mode?: "create" | "change" | "fix" | "point_edit" | null;
  input?: Record<string, unknown>;
  cardVersion?: number | null;
  estimateMilli?: number | null;
  capMilli?: number | null;
  startedBy: string;
}

/**
 * Fixture of a run mode (WIZARD_LLM_MODE=fixture, M3-01): a demo transcript is replayed by ordinal per call type, so a
 * point_edit run after the demo build reads its own transcript <suite>/<name>.<mode>.jsonl (written by
 * tools/fixtures/gen-golden.mjs) when it exists; otherwise the run uses WIZARD_FIXTURE as is.
 */
export function modeFixture(env: NodeJS.ProcessEnv, mode: string): RouterOptions["fixture"] {
  if ((env.WIZARD_LLM_MODE ?? "fixture") !== "fixture") return undefined;
  const [suite, name] = (env.WIZARD_FIXTURE ?? "").split("/");
  if ((suite !== "demo" && suite !== "eval" && suite !== "unit") || !name) return undefined;
  const opts = { suite, name: `${name}.${mode}`, lenient: env.WIZARD_FIXTURE_LENIENT === "1" } as const;
  return existsSync(new FixtureStore(opts).path) ? opts : undefined;
}

/** Run kinds that call models (the platform LLM cap applies to them, M2-15). */
export const LLM_RUN_KINDS: ReadonlySet<NewRun["kind"]> = new Set([
  "interview_turn",
  "build",
  "import_table",
]);

/**
 * Inserts a run. With `billing`: an interview turn needs available > 0, a build or an import holds its cap in the
 * same transaction (billing.yaml#run_charging; 402 INSUFFICIENT_CREDITS).
 */
export async function insertRun(t: TxCtx, r: NewRun, billing?: Billing): Promise<Run> {
  // M2-15: the platform LLM cap of the month refuses new LLM runs (publish/rollback/export use no LLM).
  if (billing && LLM_RUN_KINDS.has(r.kind)) await billing.assertLlmBudget();
  if (billing && r.kind === "interview_turn")
    await billing.requireForTurn(t.trx, r.orgId, r.capMilli ?? INTERVIEW_CAP_MILLI);
  // D70: pilot orgs — 5 builds and 20 edits in 30 days (402 BUILDS_LIMIT / EDITS_LIMIT).
  if (billing && r.kind === "build" && !billing.isExempt(r.orgId))
    await assertPilotLimit(t.trx, { orgId: r.orgId, mode: r.mode, now: billing.now() });
  const id = randomUUID();
  const run = await t.trx
    .insertInto("platform.runs")
    .values({
      id,
      org_id: r.orgId,
      system_id: r.systemId,
      kind: r.kind,
      mode: r.mode ?? null,
      input: json(r.input ?? {}),
      card_version: r.cardVersion ?? null,
      credits_estimate_milli: r.estimateMilli ?? null,
      credits_cap_milli:
        r.capMilli ??
        (r.kind === "interview_turn"
          ? INTERVIEW_CAP_MILLI
          : r.kind === "import_table"
            ? IMPORT_CAP_MILLI
            : null),
      started_by: r.startedBy,
      // workflows.yaml#execution.M1.engine: workflowID = runs.id.
      dbos_workflow_id: id,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  // import_table holds its fixed cap like a build (FU-6); publish/rollback cost nothing and are inserted without billing.
  if (billing && (r.kind === "build" || r.kind === "import_table") && run.credits_cap_milli !== null)
    await billing.hold(t.trx, {
      orgId: r.orgId,
      runId: run.id,
      systemId: r.systemId,
      amountMilli: Number(run.credits_cap_milli),
      key: `hold:${run.id}`,
      note: r.kind === "build" ? "Резерв на сборку (потолок из карточки)" : "Резерв на импорт таблицы",
    });
  return run;
}

function toResult(e: unknown, aborted: boolean): Result {
  if (e instanceof RunCancelled) return { status: "cancelled", summary_ru: e.summary_ru };
  if (e instanceof RunFailure)
    return { status: "failed", code: e.code, message_ru: e.message_ru, retryable: e.retryable };
  if (e instanceof LlmError) {
    if (e.code === "LLM_UNAVAILABLE")
      return {
        status: "failed",
        code: "LLM_UNAVAILABLE",
        message_ru: MODELS_UNAVAILABLE_RU,
        retryable: true,
      };
    if (e.code === "ABORTED" || aborted) return { status: "cancelled", summary_ru: "Прогон отменён" };
  }
  if (aborted) return { status: "cancelled", summary_ru: "Прогон отменён" };
  return {
    status: "failed",
    code: "INTERNAL",
    message_ru: "Внутренняя ошибка прогона. Попробуйте ещё раз.",
    retryable: true,
  };
}

/**
 * Routing policy of an org (product.yaml#decisions.D26_models_default): only a known restricted region (orgs.t1_restricted,
 * set by data-boundary.yaml#region_restriction sources) or «Только РФ» keeps the org on T0; an unknown region (NULL)
 * does not restrict T1. The router itself stays fail-safe for a missing t1Restricted field.
 */
export function orgPolicyOf(org: { ru_only: boolean; t1_restricted: boolean; region_code?: string | null }) {
  return { ruOnly: org.ru_only, t1Restricted: org.t1_restricted };
}

/** Counting semaphore: active (non-waiting) runs of a worker (WIZARD_RUN_CONCURRENCY). */
class Slots {
  #free: number;
  readonly #waiting: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async take(): Promise<void> {
    if (this.#free > 0) {
      this.#free--;
      return;
    }
    await new Promise<void>((r) => this.#waiting.push(r));
  }
  give(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free++;
  }
}

/** One executing run: its row (immutable fields), durability context and abort controller. */
interface Ctx {
  run: Run;
  D: Durable;
  ac: AbortController;
  /** Holds a worker slot (role worker, lock-needing runs). */
  slot: boolean;
  /** needs_input calls so far in this execution: a replay reaches the same ordinal at the same call. */
  inputs: number;
}

interface Routers {
  r?: Router;
  /** Internal events (model_switched) of the current call; awaited before the call's step ends. */
  pending: Promise<unknown>[];
  /** Replay of a fixture call: usage and events are not written again. */
  mute: boolean;
}

export class RunEngine {
  readonly #d: EngineDeps;
  readonly #role: EngineRole;
  readonly #queue: string[] = [];
  readonly #meta = new Map<string, string | null>();
  readonly #busyKeys = new Set<string>();
  readonly #active = new Set<string>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #boxes = new LocalMailboxes();
  readonly #lockWaiters = new Map<string, string[]>();
  readonly #circuit = new CircuitBreaker();
  readonly #slots: Slots;
  #cancelPoll: NodeJS.Timeout | undefined;
  #imports: ImportStore | undefined;
  #exports: ExportStore | undefined;
  #closed = false;

  constructor(deps: EngineDeps) {
    this.#d = deps;
    this.#role = deps.role ?? "inprocess";
    if (this.#role === "client" && !deps.dispatcher)
      throw new Error("RunEngine role client needs a dispatcher");
    this.#slots = new Slots(deps.config.runConcurrency);
  }

  get role(): EngineRole {
    return this.#role;
  }

  get #db(): Db {
    return this.#d.db;
  }

  #log(msg: string, err?: unknown): void {
    if (this.#d.log) this.#d.log(msg, err);
    else fallbackLog.error(msg, err);
  }

  #tx<T>(fn: (t: TxCtx) => Promise<T>): Promise<T> {
    return withTx(this.#db, this.#d.bus, fn);
  }

  /** Hands a persisted queued run to the executor; interview turns of one system run one at a time. */
  enqueue(run: { id: string; kind: string; system_id: string | null }, front = false): void {
    if (this.#closed) return;
    if (this.#role === "client") {
      this.#d.dispatcher?.enqueue(run).catch((e) => this.#log(`enqueue ${run.id} failed`, e));
      return;
    }
    if (this.#role === "worker") return;
    this.#meta.set(run.id, run.kind === "interview_turn" ? `interview:${run.system_id}` : null);
    if (front) this.#queue.unshift(run.id);
    else this.#queue.push(run.id);
    this.#pump();
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#active.size < this.#d.config.runConcurrency) {
      const idx = this.#queue.findIndex((id) => {
        const k = this.#meta.get(id);
        return !k || !this.#busyKeys.has(k);
      });
      if (idx < 0) return;
      const id = this.#queue.splice(idx, 1)[0] as string;
      const key = this.#meta.get(id) ?? null;
      if (key) this.#busyKeys.add(key);
      this.#active.add(id);
      const task: Promise<void> = this.executeRun(id, inProcessDurable(id, this.#boxes)).finally(() => {
        if (key) this.#busyKeys.delete(key);
        this.#meta.delete(id);
        this.#active.delete(id);
        this.#tasks.delete(task);
        this.#boxes.clear(id);
        this.#pump();
      });
      this.#tasks.add(task);
    }
  }

  /** Resolves when nothing is executing (tests). */
  async idle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }

  /** Stops accepting work (the worker calls it before DBOS.shutdown so no run is finalized while stopping). */
  stop(): void {
    this.#closed = true;
    if (this.#cancelPoll) clearInterval(this.#cancelPoll);
  }

  /** Stops accepting work and aborts executors WITHOUT finalizing runs (simulates a process stop). */
  async close(): Promise<void> {
    this.stop();
    for (const c of this.#controllers.values()) c.abort();
    for (const id of this.#controllers.keys()) this.#boxes.send(id, TOPIC_INPUT, { cancel: true });
    await Promise.allSettled([...this.#tasks]);
    await this.#d.dispatcher?.close();
  }

  /**
   * Worker: a run whose DBOS workflow ended without the terminal transaction (workflow error, recovery attempts
   * exhausted) → failed WORKER_RESTARTED, lock released and handed over (no-op for a terminal run).
   */
  async failAbandoned(runId: string): Promise<void> {
    const sys = await this.#tx((t) =>
      this.#finalize(t, runId, {
        status: "failed",
        code: "WORKER_RESTARTED",
        message_ru: "Прогон прервался на сервере. Запустите его ещё раз.",
        retryable: true,
      }),
    );
    if (sys) {
      const next = await this.#nextWaiter(sys);
      if (next) await this.#deliver(next, TOPIC_LOCK, { systemId: sys });
    }
  }

  /** workflows.yaml#execution.M0.restart: every non-terminal run → failed WORKER_RESTARTED (role inprocess). */
  async recover(): Promise<number> {
    if (this.#role !== "inprocess") return 0;
    const rows = await this.#db
      .selectFrom("platform.runs")
      .select("id")
      .where("status", "in", [...ACTIVE_STATUSES])
      .orderBy("created_at")
      .execute();
    for (const r of rows) {
      await this.#tx((t) =>
        this.#finalize(t, r.id, {
          status: "failed",
          code: "WORKER_RESTARTED",
          message_ru: "Сервер перезапустился во время прогона. Запустите его ещё раз.",
          retryable: true,
        }),
      );
    }
    return rows.length;
  }

  async #loadRun(id: string): Promise<Run | undefined> {
    return this.#db.selectFrom("platform.runs").selectAll().where("id", "=", id).executeTakeFirst();
  }

  /** Worker: aborts the current step of runs whose cancel was requested through platform-api. */
  #watchCancels(): void {
    if (this.#role !== "worker" || this.#cancelPoll || this.#closed) return;
    this.#cancelPoll = setInterval(() => {
      const ids = [...this.#controllers.keys()];
      if (ids.length === 0) return;
      this.#db
        .selectFrom("platform.runs")
        .select("id")
        .where("id", "in", ids)
        .where("cancel_requested_at", "is not", null)
        .execute()
        .then((rows) => {
          for (const r of rows) this.#controllers.get(r.id)?.abort();
        })
        .catch((e) => this.#log("cancel poll failed", e));
    }, CANCEL_POLL_MS);
    this.#cancelPoll.unref();
  }

  async #takeSlot(x: Ctx): Promise<void> {
    if (this.#role === "worker" && x.run.kind !== "interview_turn" && !x.slot) {
      await this.#slots.take();
      x.slot = true;
    }
  }

  #giveSlot(x: Ctx): void {
    if (x.slot) {
      x.slot = false;
      this.#slots.give();
    }
  }

  /**
   * The workflow body of one run: lock, start, the kind's steps, finalize. Role inprocess drives it from its queue;
   * apps/worker calls it inside the DBOS workflow with a DBOS-backed `D`.
   */
  async executeRun(id: string, D: Durable): Promise<void> {
    if (this.#role === "worker") {
      const task: Promise<void> = this.#executeRun(id, D).finally(() => this.#tasks.delete(task));
      this.#tasks.add(task);
      return task;
    }
    return this.#executeRun(id, D);
  }

  async #executeRun(id: string, D: Durable): Promise<void> {
    const ac = new AbortController();
    this.#controllers.set(id, ac);
    this.#watchCancels();
    let result: Result | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let locked = false;
    let x: Ctx | undefined;
    try {
      const status = await D.step("check_status", async () => (await this.#loadRun(id))?.status ?? null);
      if (status === null || TERMINAL_STATUSES.has(status)) return;
      // Fields read outside steps are immutable for the life of the run (kind, mode, org, system, input).
      const run = await this.#loadRun(id);
      if (!run) return;
      x = { run, D, ac, slot: false, inputs: 0 };
      if (NEEDS_LOCK.has(run.kind) && run.system_id) {
        let holder = await D.step("acquire_lock", () => this.#acquireLock(run, D.durable));
        if (holder === TERMINAL) return;
        if (holder !== null) {
          if (!D.durable) {
            await this.#waitLock(run, holder);
            return;
          }
          await D.step("lock_waiting", () => this.#markWaiting(run, holder as string));
          while (holder !== null) {
            await D.recv(TOPIC_LOCK, LOCK_POLL_MS);
            holder = await D.step("acquire_lock", () => this.#acquireLock(run, true));
            if (holder === TERMINAL) return;
          }
        }
        locked = true;
      }
      await this.#takeSlot(x);
      const started = await D.step("start", () => this.#start(run, D.durable));
      if (!started) {
        if (locked) {
          const sys = await D.step("release_lock", () => this.#releaseLockRow(run.id));
          await this.#handOver(D, sys);
        }
        return;
      }
      if (locked) {
        heartbeat = setInterval(() => {
          this.#heartbeat(id).catch((e) => this.#log("heartbeat failed", e));
        }, HEARTBEAT_MS);
        heartbeat.unref();
      }
      if (run.kind === "interview_turn") result = await this.#interview(x);
      else if (run.kind === "build") result = await this.#build(x, started.cap);
      else if (run.kind === "publish" || run.kind === "rollback") result = await this.#flow(x);
      else if (run.kind === "import_table") result = await this.#importTable(x);
      else if (run.kind === "export") result = await this.#export(x);
      else throw new RunFailure("INTERNAL", "Этот тип прогона ещё не поддерживается");
    } catch (e) {
      // A stopping worker leaves the workflow pending: DBOS resumes it on the next start.
      if (this.#closed && D.durable) throw e;
      if (!(e instanceof RunFailure || e instanceof RunCancelled || e instanceof LlmError))
        this.#log(`run ${id} failed`, e);
      if (x && e instanceof LlmError && e.code === "LLM_UNAVAILABLE" && !ac.signal.aborted) {
        const cx = x;
        const callType = typeof e.details.callType === "string" ? e.details.callType : null;
        await reportModelsUnavailable({
          db: this.#db,
          run: cx.run,
          callType,
          emit: (payload) => this.#emit(cx, "models_unavailable", payload),
          alert: this.#d.publish?.alert,
        }).catch((err) => this.#log(`run ${id}: models_unavailable report failed`, err));
      }
      result = toResult(e, ac.signal.aborted);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.#controllers.delete(id);
      if (x) this.#giveSlot(x);
    }
    if (result && !this.#closed) {
      const r = result;
      try {
        const sys = await D.step("finalize", () => this.#tx((t) => this.#finalize(t, id, r)));
        await this.#handOver(D, sys);
      } catch (e) {
        this.#log(`finalize ${id} failed`, e);
        if (D.durable) throw e;
      }
    }
  }

  /** The lock of `systemId` was released: the next waiter takes it (FIFO by created_at). */
  async #handOver(D: Durable, systemId: string | null): Promise<void> {
    if (!systemId) return;
    if (!D.durable) {
      this.#wakeLock(systemId);
      return;
    }
    const next = await D.step("next_waiter", () => this.#nextWaiter(systemId));
    if (next) await D.send(next, TOPIC_LOCK, { systemId });
  }

  async #nextWaiter(systemId: string): Promise<string | null> {
    const row = await this.#db
      .selectFrom("platform.runs")
      .select("id")
      .where("system_id", "=", systemId)
      .where("status", "=", "waiting_lock")
      .orderBy("created_at")
      .limit(1)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /**
   * null = acquired (or already ours), else the holder run id. Durable waiters also keep FIFO among themselves and
   * never take over a lease of a run that is still active (DBOS resumes it), and see their own cancellation.
   */
  async #acquireLock(run: Run, durable: boolean): Promise<string | null> {
    if (durable) {
      const cur = await this.#db
        .selectFrom("platform.runs")
        .select(["status", "created_at"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      if (TERMINAL_STATUSES.has(cur.status)) return TERMINAL;
      const older = await this.#db
        .selectFrom("platform.runs")
        .select("id")
        .where("system_id", "=", run.system_id as string)
        .where("status", "=", "waiting_lock")
        .where("id", "<>", run.id)
        .where("created_at", "<", cur.created_at)
        .orderBy("created_at")
        .limit(1)
        .executeTakeFirst();
      if (older) {
        const holder = await this.#db
          .selectFrom("platform.locks")
          .select("run_id")
          .where("system_id", "=", run.system_id as string)
          .executeTakeFirst();
        return holder?.run_id ?? older.id;
      }
    }
    const takeover = durable
      ? sql`platform.locks.run_id = EXCLUDED.run_id OR (platform.locks.lease_until < now() AND NOT EXISTS (
          SELECT 1 FROM platform.runs r WHERE r.id = platform.locks.run_id
            AND r.status IN ('queued','waiting_lock','running','needs_input')))`
      : sql`platform.locks.lease_until < now() OR platform.locks.run_id = EXCLUDED.run_id`;
    const res = await sql<{ run_id: string }>`
      INSERT INTO platform.locks (system_id, run_id, holder_user_id, lease_until)
      VALUES (${run.system_id}, ${run.id}, ${run.started_by}, now() + ${`${LEASE_MS} milliseconds`}::interval)
      ON CONFLICT (system_id) DO UPDATE
        SET run_id = EXCLUDED.run_id, holder_user_id = EXCLUDED.holder_user_id,
            acquired_at = now(), lease_until = EXCLUDED.lease_until
        WHERE ${takeover}
      RETURNING run_id`.execute(this.#db);
    if (res.rows.length > 0) return null;
    const holder = await this.#db
      .selectFrom("platform.locks")
      .select("run_id")
      .where("system_id", "=", run.system_id as string)
      .executeTakeFirst();
    return holder?.run_id ?? "";
  }

  /** Deletes the run's lock row; returns the system whose lock was released. */
  async #releaseLockRow(runId: string): Promise<string | null> {
    const rows = await this.#db
      .deleteFrom("platform.locks")
      .where("run_id", "=", runId)
      .returning("system_id")
      .execute();
    return rows[0]?.system_id ?? null;
  }

  async #heartbeat(runId: string): Promise<void> {
    await sql`UPDATE platform.locks SET lease_until = now() + ${`${LEASE_MS} milliseconds`}::interval WHERE run_id = ${runId}`.execute(
      this.#db,
    );
    await this.#db
      .updateTable("platform.runs")
      .set({ heartbeat_at: new Date() })
      .where("id", "=", runId)
      .execute();
  }

  /** queued → waiting_lock with lock_waiting (position = 1 + older waiters). */
  async #markWaiting(run: Run, holder: string, position?: number): Promise<void> {
    await this.#tx(async (t) => {
      const cur = await t.trx
        .selectFrom("platform.runs")
        .select(["status", "created_at"])
        .where("id", "=", run.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (cur.status !== "queued") return;
      await t.trx
        .updateTable("platform.runs")
        .set({ status: "waiting_lock" })
        .where("id", "=", run.id)
        .execute();
      const holderRun = holder
        ? await t.trx.selectFrom("platform.runs").select(["kind"]).where("id", "=", holder).executeTakeFirst()
        : undefined;
      const older =
        position ??
        Number(
          (
            await t.trx
              .selectFrom("platform.runs")
              .select((eb) => eb.fn.countAll().as("n"))
              .where("system_id", "=", run.system_id as string)
              .where("status", "=", "waiting_lock")
              .where("created_at", "<", cur.created_at)
              .executeTakeFirstOrThrow()
          ).n,
        ) + 1;
      await appendEvent(t, run.id, "lock_waiting", {
        holderRunId: holder,
        holderName:
          holderRun?.kind === "build"
            ? "Сборка"
            : holderRun?.kind === "publish"
              ? "Публикация"
              : holderRun?.kind === "rollback"
                ? "Откат"
                : "Другой прогон",
        position: older,
      });
    });
  }

  /** Role inprocess: the run leaves the queue until the holder releases the lock (#wakeLock). */
  async #waitLock(run: Run, holder: string): Promise<void> {
    const sysId = run.system_id as string;
    const list = this.#lockWaiters.get(sysId) ?? [];
    if (!list.includes(run.id)) list.push(run.id);
    this.#lockWaiters.set(sysId, list);
    await this.#markWaiting(run, holder, list.indexOf(run.id) + 1);
    // The holder may have released between the INSERT attempt and registration.
    const still = await this.#db
      .selectFrom("platform.locks")
      .select("run_id")
      .where("system_id", "=", sysId)
      .executeTakeFirst();
    if (!still) this.#wakeLock(sysId);
  }

  #wakeLock(systemId: string | null | undefined): void {
    if (!systemId) return;
    const list = this.#lockWaiters.get(systemId);
    const next = list?.shift();
    if (list && list.length === 0) this.#lockWaiters.delete(systemId);
    if (next) this.enqueue({ id: next, kind: "build", system_id: systemId }, true);
  }

  /**
   * queued|waiting_lock → running with run_started; null when cancelled meanwhile. `resumed` (durable): a re-run of
   * this step whose transaction committed before the worker died (no checkpoint) finds the run already running —
   * only this workflow starts it — and continues instead of leaving it unfinalized.
   */
  async #start(run: Run, resumed: boolean): Promise<{ base: number | null; cap: number | null } | null> {
    return this.#tx(async (t) => {
      const cur = await t.trx
        .selectFrom("platform.runs")
        .selectAll()
        .where("id", "=", run.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const cap = cur.credits_cap_milli === null ? null : Number(cur.credits_cap_milli);
      if (resumed && cur.status === "running") return { base: cur.base_revision, cap };
      if ((cur.status !== "queued" && cur.status !== "waiting_lock") || cur.cancel_requested_at) return null;
      const sys = cur.system_id
        ? await t.trx
            .selectFrom("platform.systems")
            .select("draft_revision")
            .where("id", "=", cur.system_id)
            .executeTakeFirst()
        : undefined;
      const base = sys?.draft_revision ?? null;
      await t.trx
        .updateTable("platform.runs")
        .set({ status: "running", started_at: new Date(), heartbeat_at: new Date(), base_revision: base })
        .where("id", "=", run.id)
        .execute();
      t.after?.push(() => runsStarted.inc({ kind: cur.kind }));
      await appendEvent(t, run.id, "run_started", {
        kind: cur.kind,
        ...(cur.mode ? { mode: cur.mode } : {}),
        baseRevision: base,
        credits:
          cap === null ? null : { estimate: Number(cur.credits_estimate_milli ?? 0) / 1000, cap: cap / 1000 },
      });
      return { base, cap };
    });
  }

  /** Terminal transition in one transaction: status, lock release, system stage, run_report, terminal event. */
  async #finalize(t: TxCtx, runId: string, r: Result): Promise<string | null> {
    const run = await t.trx
      .selectFrom("platform.runs")
      .selectAll()
      .where("id", "=", runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run || TERMINAL_STATUSES.has(run.status)) return null;
    const sys = run.system_id ? await lockSystem(t, run.system_id) : null;
    const isBuild = run.kind === "build";
    const isFlow = run.kind === "publish" || run.kind === "rollback";
    const resultRevision = isBuild
      ? sys && run.base_revision !== null && sys.draft_revision > run.base_revision
        ? sys.draft_revision
        : null
      : r.status === "succeeded"
        ? (r.resultRevision ?? null)
        : null;
    await t.trx
      .updateTable("platform.runs")
      .set({
        status: r.status,
        finished_at: new Date(),
        current_step: null,
        pending_input: null,
        result_revision: resultRevision,
        failure_code: r.status === "failed" ? r.code : null,
        failure_message_ru: r.status === "failed" ? r.message_ru : null,
      })
      .where("id", "=", runId)
      .execute();
    t.after?.push(() =>
      recordRunEnd({
        kind: run.kind,
        status: r.status,
        code: r.status === "failed" ? r.code : null,
        startedAt: run.started_at,
      }),
    );
    // release(+hold), charge(−min(used, cap)), refund — billing.yaml#run_charging.
    await this.#d.billing.settleRun(
      t.trx,
      run,
      r.status === "failed" ? { status: r.status, code: r.code } : r,
    );
    const released = await t.trx
      .deleteFrom("platform.locks")
      .where("run_id", "=", runId)
      .returning("system_id")
      .execute();
    if (sys && isBuild) {
      if (sys.stage === "building") {
        const next = stageAfterBuild(r.status === "succeeded", sys.preview_revision);
        assertTransition(sys.stage, next);
        await t.trx
          .updateTable("platform.systems")
          .set({ stage: next, updated_at: new Date() })
          .where("id", "=", sys.id)
          .execute();
      }
    }
    if (sys && (isBuild || isFlow)) {
      await insertMessage(t, {
        systemId: sys.id,
        role: "assistant",
        kind: "run_report",
        text: r.status === "failed" ? r.message_ru : r.summary_ru,
        payload: { runId, status: r.status },
        runId,
      });
    }
    if (r.status === "failed") {
      await appendEvent(t, runId, "run_failed", {
        code: r.code,
        message_ru: r.message_ru,
        retryable: r.retryable,
        lastGoodRevision: sys?.preview_revision ?? null,
      });
    } else {
      await appendEvent(t, runId, "run_finished", {
        status: r.status,
        resultRevision,
        creditsUsed: Number(run.credits_used_milli) / 1000,
        summary_ru: r.summary_ru,
        prodUrl: r.status === "succeeded" ? (r.prodUrl ?? null) : null,
      });
    }
    return released.length > 0 ? (released[0]?.system_id ?? null) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // HTTP-facing operations

  /** A message to a run's workflow: in-process mailbox or DBOS.send (role client). */
  async #deliver(runId: string, topic: string, message: unknown, key?: string): Promise<void> {
    if (this.#d.dispatcher) await this.#d.dispatcher.send(runId, topic, message, key);
    else this.#boxes.send(runId, topic, message);
  }

  /** POST /runs/:id/cancel (caller checked access). */
  async cancel(runId: string): Promise<void> {
    let direct = false;
    const released = await this.#tx(async (t) => {
      const run = await t.trx
        .selectFrom("platform.runs")
        .selectAll()
        .where("id", "=", runId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (TERMINAL_STATUSES.has(run.status))
        throw new ApiError("RUN_NOT_CANCELLABLE", "Прогон уже завершён — отменять нечего");
      await t.trx
        .updateTable("platform.runs")
        .set({ cancel_requested_at: new Date() })
        .where("id", "=", runId)
        .execute();
      if (run.status === "queued" || run.status === "waiting_lock") {
        direct = true;
        return this.#finalize(t, runId, { status: "cancelled", summary_ru: "Прогон отменён" });
      }
      return null;
    });
    if (direct) {
      if (this.#role === "client") {
        // The waiting workflow wakes, sees its terminal status and ends; the lock goes to the next waiter.
        await this.#deliver(runId, TOPIC_LOCK, { cancel: true }).catch((e) => this.#log("cancel send", e));
        const next = released ? await this.#nextWaiter(released) : null;
        if (next) await this.#deliver(next, TOPIC_LOCK, { systemId: released }).catch(() => {});
        return;
      }
      const qi = this.#queue.indexOf(runId);
      if (qi >= 0) this.#queue.splice(qi, 1);
      for (const list of this.#lockWaiters.values()) {
        const i = list.indexOf(runId);
        if (i >= 0) list.splice(i, 1);
      }
      this.#wakeLock(released);
      return;
    }
    this.#controllers.get(runId)?.abort();
    await this.#deliver(runId, TOPIC_INPUT, { cancel: true }, `${runId}:cancel`);
  }

  /** POST /runs/:id/input (caller checked access and body shape). Secret values go to the store, never to the run. */
  async provideInput(
    runId: string,
    body: { inputId: string; choice?: string; text?: string; secretValue?: string },
  ) {
    const message = await this.#tx(async (t): Promise<InputMessage> => {
      const run = await t.trx
        .selectFrom("platform.runs")
        .selectAll()
        .where("id", "=", runId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const pending = run.pending_input as {
        inputId: string;
        kind: "decision" | "secret";
        secretName?: string;
        options?: { id: string; freeText?: boolean }[];
      } | null;
      if (run.status !== "needs_input" || !pending)
        throw new ApiError("RUN_NOT_WAITING_INPUT", "Прогон сейчас не ждёт ответа");
      if (pending.inputId !== body.inputId)
        throw new ApiError("RUN_NOT_WAITING_INPUT", "Этот запрос уже неактуален — обновите страницу");
      let msg: InputMessage;
      if (pending.kind === "secret" && body.secretValue !== undefined) {
        const store = this.#d.secrets;
        if (!store || !pending.secretName || body.choice !== undefined || body.text !== undefined)
          throw new ApiError("VALIDATION_FAILED", "Передайте только значение секрета");
        if (body.secretValue.length === 0) throw new ApiError("VALIDATION_FAILED", "Значение секрета пустое");
        // execution.M1.dbos_data: the value is stored here, the workflow only gets secret://name.
        const ref = await store.put(t.trx, {
          orgId: run.org_id,
          systemId: run.system_id as string,
          env: "draft",
          name: pending.secretName,
          value: body.secretValue,
          createdBy: run.started_by,
        });
        msg = { inputId: pending.inputId, choice: null, secretRef: ref };
      } else {
        if (body.secretValue !== undefined)
          throw new ApiError("VALIDATION_FAILED", "Ввод секретов появится позже; выберите один из вариантов");
        const option = pending.options?.find((o) => o.id === body.choice);
        if (!body.choice || !option)
          throw new ApiError("VALIDATION_FAILED", "Выберите один из предложенных вариантов");
        if (body.text !== undefined && !option.freeText)
          throw new ApiError("VALIDATION_FAILED", "Для этого варианта свой текст не нужен");
        msg = {
          inputId: pending.inputId,
          choice: body.choice,
          ...(body.text !== undefined ? { text: body.text } : {}),
        };
      }
      await t.trx
        .updateTable("platform.runs")
        .set({ status: "running", pending_input: null })
        .where("id", "=", runId)
        .execute();
      await appendEvent(t, runId, "input_received", {
        inputId: pending.inputId,
        choice: pending.kind === "secret" ? null : (body.choice ?? null),
      });
      return msg;
    });
    await this.#deliver(runId, TOPIC_INPUT, message, `${runId}:${body.inputId}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Hosts

  /** Cancel check at a step boundary (checkpointed: a replay takes the same path). */
  async #ensureActive(x: Ctx): Promise<void> {
    if (x.ac.signal.aborted && !x.D.durable) throw new RunCancelled();
    const cancelled = await x.D.step("cancel_check", async () => {
      if (x.ac.signal.aborted) return true;
      const r = await this.#db
        .selectFrom("platform.runs")
        .select("cancel_requested_at")
        .where("id", "=", x.run.id)
        .executeTakeFirstOrThrow();
      return r.cancel_requested_at !== null;
    });
    if (cancelled) {
      x.ac.abort();
      throw new RunCancelled();
    }
  }

  async #emit(x: Ctx, type: EventType, payload: Record<string, unknown>): Promise<void> {
    await x.D.step(`emit:${type}`, () =>
      this.#tx(async (t) => {
        await appendEvent(t, x.run.id, type, payload);
        if (type === "step_started" && typeof payload.step === "string")
          await t.trx
            .updateTable("platform.runs")
            .set({ current_step: payload.step })
            .where("id", "=", x.run.id)
            .execute();
      }),
    );
  }

  async #step<T>(x: Ctx, name: string, label_ru: string, fn: () => Promise<T>): Promise<T> {
    await this.#ensureActive(x);
    await this.#emit(x, "step_started", { step: name, label_ru, attempt: 1 });
    const t0 = Date.now();
    const out = await fn();
    await this.#emit(x, "step_finished", { step: name, durationMs: Date.now() - t0 });
    return out;
  }

  #stepHost(x: Ctx, needsInput: (req: InputRequest) => Promise<InputAnswer>): StepHost {
    const routers: Routers = { pending: [], mute: false };
    const run = x.run;
    return {
      run: {
        id: run.id,
        orgId: run.org_id,
        systemId: run.system_id as string,
        kind: run.kind,
        mode: run.mode,
      },
      signal: x.ac.signal,
      // Durability lives in the host primitives (route, store, gates, emit); runStep only marks a boundary.
      runStep: async (_name, fn) => {
        await this.#ensureActive(x);
        return fn();
      },
      emit: async (type, payload) => {
        if (PLATFORM_EVENTS.has(type)) throw new Error(`event ${type} is emitted by the platform only`);
        await this.#emit(x, type, payload);
      },
      route: (input) => this.#route(x, routers, input, needsInput),
      recordDevelopmentRequest: async (input) => {
        await x.D.step("development_request", () => recordDevelopmentRequest(this.#db, run, input));
      },
    };
  }

  #router(x: Ctx, routers: Routers): Router {
    if (!routers.r) {
      const sink = new DbUsageSink(this.#db);
      const variant = x.run.mode === "point_edit" ? modeFixture(process.env, "point_edit") : undefined;
      const opts: RouterOptions = {
        ...(variant ? { fixture: variant } : {}),
        registry: createRegistry({ buildDefaultTier: this.#d.config.buildDefaultTier }),
        sink: { write: (rec) => (routers.mute ? undefined : sink.write(rec)) },
        circuit: this.#circuit,
        onEvent: (e) => {
          if (routers.mute) return;
          const { type, ...payload } = e;
          routers.pending.push(this.#emit(x, type, payload).catch((err) => this.#log("model_switched", err)));
        },
      };
      routers.r = (this.#d.createRouter ?? createRouter)(opts);
    }
    return routers.r;
  }

  async #route(
    x: Ctx,
    routers: Routers,
    input: HostRouteInput,
    needsInput: (req: InputRequest) => Promise<InputAnswer>,
  ): Promise<RouteOutput> {
    const { run, D } = x;
    await this.#ensureActive(x);
    const billing = this.#d.billing;
    // Budget check before every LLM step (workflows.yaml#run_lifecycle.budget).
    for (;;) {
      const b = await D.step("budget_check", async () => {
        const cur = await this.#db
          .selectFrom("platform.runs")
          .select(["credits_used_milli", "credits_cap_milli"])
          .where("id", "=", run.id)
          .executeTakeFirstOrThrow();
        if (cur.credits_cap_milli === null) return null;
        const used = Number(cur.credits_used_milli);
        const cap = Number(cur.credits_cap_milli);
        const ub = Math.round((input.upperBoundCredits ?? 0) * 1000);
        if (used + ub <= cap && used < cap) return null;
        const n = Math.ceil((0.25 * cap) / 1000);
        // raise_cap_N holds N more credits; without them the option is not offered (billing.yaml#run_charging).
        const canRaise =
          run.kind === "build" &&
          (billing.isExempt(run.org_id) ||
            (await billing.readBalance(this.#db, run.org_id)).available >= n * 1000);
        return { used, cap, n, canRaise };
      });
      if (!b) break;
      const { used, cap, n, canRaise } = b;
      await this.#emit(x, "budget_exceeded", {
        used: used / 1000,
        cap: cap / 1000,
        nextStep: input.step ?? input.callType,
      });
      if (run.kind !== "build")
        throw new RunFailure(
          "BUDGET_STOPPED",
          "Этот ответ получился слишком объёмным. Попробуйте сформулировать вопрос короче.",
        );
      // D31, D70: the client sees no credits — the internal cap is «работа сборки».
      const ans = await needsInput({
        decisionId: "budget",
        prompt_ru: canRaise
          ? "Сборка потребовала больше работы, чем рассчитывали. Продолжить или остановить?"
          : "Сборка потребовала больше работы, чем рассчитывали, а внутренний запас организации закончился. Сборку придётся остановить — напишите команде, и мы поможем.",
        options: canRaise
          ? [
              { id: `raise_cap_${n}`, label: "Продолжить сборку", recommended: true },
              { id: "stop", label: "Остановить" },
            ]
          : [{ id: "stop", label: "Остановить", recommended: true }],
      });
      if (ans.choice === "stop") throw new RunCancelled("Сборка остановлена");
      const newCap = cap + n * 1000;
      await D.step("raise_cap", () =>
        this.#tx(async (t) => {
          await t.trx.selectFrom("platform.runs").select("id").where("id", "=", run.id).forUpdate().execute();
          await billing
            .hold(t.trx, {
              orgId: run.org_id,
              runId: run.id,
              systemId: run.system_id,
              amountMilli: n * 1000,
              key: `hold:${run.id}:cap:${newCap}`,
              note: `Увеличение лимита сборки на ${n} кр.`,
            })
            .catch((e: unknown) => {
              if (e instanceof ApiError && e.code === "INSUFFICIENT_CREDITS")
                throw new RunCancelled(
                  "Сборка остановлена: закончился внутренний запас организации. Напишите команде, и мы поможем.",
                );
              throw e;
            });
          await t.trx
            .updateTable("platform.runs")
            .set({ credits_cap_milli: newCap })
            .where("id", "=", run.id)
            .execute();
        }),
      );
    }
    const router = this.#router(x, routers);
    const { step, upperBoundCredits: _ub, ...rest } = input;
    const ctx = {
      orgId: run.org_id,
      runId: run.id,
      systemId: run.system_id ?? undefined,
      ...(step ? { step } : {}),
    };
    // The LLM step: its output is kept by reference (L3-09); usage and credits are written with it.
    const out = await D.step(
      `llm:${step ?? input.callType}`,
      async () => {
        const org = await this.#db
          .selectFrom("platform.orgs")
          .select(["ru_only", "t1_restricted", "region_code"])
          .where("id", "=", run.org_id)
          .executeTakeFirstOrThrow();
        const used0 = await this.#db
          .selectFrom("platform.runs")
          .select(["credits_used_milli", "credits_cap_milli"])
          .where("id", "=", run.id)
          .executeTakeFirstOrThrow();
        routers.pending = [];
        const res = await router.route({
          ...rest,
          orgPolicy: orgPolicyOf(org),
          ctx: {
            ...ctx,
            ...(used0.credits_cap_milli !== null
              ? {
                  budget: {
                    capCredits: Number(used0.credits_cap_milli) / 1000,
                    spentCredits: Number(used0.credits_used_milli) / 1000,
                  },
                }
              : {}),
          },
          signal: x.ac.signal,
        });
        await Promise.all(routers.pending);
        await this.#tx(async (t) => {
          const row = await t.trx
            .updateTable("platform.runs")
            .set((eb) => ({ credits_used_milli: eb("credits_used_milli", "+", String(res.creditsMilli)) }))
            .where("id", "=", run.id)
            .returning(["credits_used_milli", "credits_cap_milli", "credits_estimate_milli"])
            .executeTakeFirstOrThrow();
          await appendEvent(t, run.id, "budget_update", {
            used: Number(row.credits_used_milli) / 1000,
            cap: Number(row.credits_cap_milli ?? 0) / 1000,
            ...(row.credits_estimate_milli !== null
              ? { estimate: Number(row.credits_estimate_milli) / 1000 }
              : {}),
          });
        });
        return res;
      },
      { offload: true },
    );
    if (D.replayed && router.mode === "fixture") {
      // A fixture router answers by order within the run: replayed calls advance it without new usage rows.
      routers.mute = true;
      try {
        const org = await this.#db
          .selectFrom("platform.orgs")
          .select(["ru_only", "t1_restricted", "region_code"])
          .where("id", "=", run.org_id)
          .executeTakeFirstOrThrow();
        await router.route({ ...rest, orgPolicy: orgPolicyOf(org), ctx });
      } catch {
        // the checkpointed answer stands
      } finally {
        routers.mute = false;
      }
    }
    return out;
  }

  async #needsInput(
    x: Ctx,
    req: InputRequest | SecretInputRequest,
  ): Promise<InputAnswer & { secretRef?: string }> {
    await this.#ensureActive(x);
    // The id is a function of the call's position, not random: a worker killed after the transaction below but
    // before its checkpoint re-runs the step, and an answer sent meanwhile (keyed by this id) must still match.
    const secret = req.kind === "secret";
    const ordinal = x.inputs++;
    const tag = createHash("sha256").update(`${x.run.id}:input:${ordinal}`).digest("hex").slice(0, 8);
    const inputId = `${secret ? "secret" : req.decisionId}-${tag}`;
    const pending = await x.D.step("needs_input", async () => {
      const p = secret
        ? {
            inputId,
            kind: "secret" as const,
            secretName: req.secretName,
            prompt_ru: req.prompt_ru,
            ...(req.options ? { options: req.options } : {}),
            expiresAt: new Date(Date.now() + INPUT_TIMEOUT_MS).toISOString(),
          }
        : {
            inputId,
            kind: "decision" as const,
            decisionId: req.decisionId,
            prompt_ru: req.prompt_ru,
            options: req.options,
            expiresAt: new Date(Date.now() + INPUT_TIMEOUT_MS).toISOString(),
          };
      return this.#tx(async (t) => {
        await t.trx.selectFrom("platform.runs").select("id").where("id", "=", x.run.id).forUpdate().execute();
        // Re-run of a step whose transaction committed: the request is already out (maybe answered, which moved
        // the run to running), so nothing is written again and the original deadline stays.
        const prior = await t.trx
          .selectFrom("platform.run_events")
          .select("payload")
          .where("run_id", "=", x.run.id)
          .where("type", "=", "needs_input")
          .where(sql<boolean>`payload->>'inputId' = ${inputId}`)
          .executeTakeFirst();
        if (prior) return { inputId, expiresAt: (prior.payload as { expiresAt: string }).expiresAt };
        await t.trx
          .updateTable("platform.runs")
          .set({ status: "needs_input", pending_input: json(p) })
          .where("id", "=", x.run.id)
          .execute();
        await appendEvent(t, x.run.id, "needs_input", p);
        return { inputId, expiresAt: p.expiresAt };
      });
    });
    // A waiting run does not hold a concurrency slot.
    const inproc = this.#role === "inprocess";
    if (inproc) {
      this.#active.delete(x.run.id);
      this.#pump();
    }
    this.#giveSlot(x);
    try {
      for (;;) {
        const left = Math.max(1000, Date.parse(pending.expiresAt) - Date.now());
        const msg = await x.D.recv<InputMessage>(TOPIC_INPUT, Math.min(left, INPUT_TIMEOUT_MS));
        if (!msg) throw new RunFailure("INPUT_TIMEOUT", "Ответа не было 24 часа — прогон остановлен");
        if ("cancel" in msg) throw new RunCancelled();
        if (msg.inputId !== pending.inputId) continue;
        await this.#takeSlot(x);
        if (msg.secretRef) return { choice: msg.choice ?? "secret", secretRef: msg.secretRef };
        return { choice: msg.choice ?? "", ...(msg.text !== undefined ? { text: msg.text } : {}) };
      }
    } finally {
      if (inproc) this.#active.add(x.run.id);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Workflows

  async #interview(x: Ctx): Promise<Result> {
    const { run, D } = x;
    const base = this.#stepHost(x, () => {
      throw new RunFailure("INTERNAL", "Ход интервью не может ждать ввода");
    });
    const systemId = run.system_id as string;
    const context = await this.#step(x, "load_context", "Читаю историю", () =>
      D.step("load_context", () => this.#interviewContext(run, systemId), { offload: true }),
    );
    const out = await this.#step(x, "orchestrate", "Думаю над ответом", () =>
      this.#d.executors.interviewTurn({ ...base, context }),
    );
    await this.#step(x, "persist_output", "Сохраняю ответ", () =>
      D.step("persist_output", () => this.#tx((t) => this.#persistInterview(t, run, out))),
    );
    return { status: "succeeded", summary_ru: "Ход интервью завершён" };
  }

  async #interviewContext(run: Run, systemId: string): Promise<InterviewContext> {
    const sys = await this.#db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    const msgs = await this.#db
      .selectFrom("platform.messages")
      .selectAll()
      .where("system_id", "=", systemId)
      .orderBy("seq", "desc")
      .limit(200)
      .execute();
    const input = run.input as { trigger?: InterviewContext["trigger"]; answers?: unknown[] };
    const org = await this.#db
      .selectFrom("platform.orgs")
      .select(["id", "plan", "ru_only", "t1_restricted", "region_code"])
      .where("id", "=", sys.org_id)
      .executeTakeFirstOrThrow();
    const prev = await this.#db
      .selectFrom("platform.runs")
      .select(sql<Record<string, unknown> | null>`input->'executorState'`.as("state"))
      .where("system_id", "=", systemId)
      .where("kind", "=", "interview_turn")
      .where("status", "=", "succeeded")
      .where(sql<boolean>`input ? 'executorState'`)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return {
      system: {
        id: sys.id,
        name: sys.name,
        stage: sys.stage,
        draftRevision: sys.draft_revision,
        previewRevision: sys.preview_revision,
      },
      trigger: input.trigger ?? "message",
      messages: msgs.reverse().map((m) => ({
        id: m.id,
        seq: m.seq,
        role: m.role,
        kind: m.kind,
        ...(m.text !== null ? { text: m.text } : {}),
        ...(m.payload ? { payload: m.payload } : {}),
      })),
      spec: await loadSpec(this.#db, sys, sys.draft_revision),
      pendingQuestions: sys.pending_questions,
      card: sys.card,
      ...(input.answers ? { answers: input.answers } : {}),
      org: { id: org.id, plan: org.plan, policy: orgPolicyOf(org) },
      state: prev?.state ?? null,
    };
  }

  async #persistInterview(t: TxCtx, run: Run, out: InterviewOutput): Promise<void> {
    const sys = await lockSystem(t, run.system_id as string);
    const stage = sys.stage as Stage;
    if (out.state) {
      // Executor state (OrchSession) lives with the turn that produced it; load_context reads the latest one.
      await t.trx
        .updateTable("platform.runs")
        .set({ input: sql`input || jsonb_build_object('executorState', ${json(out.state)})` })
        .where("id", "=", run.id)
        .execute();
    }
    const move = async (to: Stage, extra: Record<string, unknown> = {}) => {
      const set: Record<string, unknown> = { ...extra, updated_at: new Date(), last_activity_at: new Date() };
      if (to !== stage) {
        assertTransition(stage, to);
        set.stage = to;
      }
      await t.trx.updateTable("platform.systems").set(set).where("id", "=", sys.id).execute();
    };
    if (out.notice && out.notice.categories.length > 0) {
      const m = await insertMessage(t, {
        systemId: sys.id,
        role: "system",
        kind: "notice",
        payload: { type: "pii", categories: out.notice.categories },
        runId: run.id,
      });
      await appendEvent(t, run.id, "chat_output", { kind: "notice", messageId: m.id });
    }
    if (out.kind === "questions") {
      if (!Array.isArray(out.questions) || out.questions.length === 0)
        throw new RunFailure(
          "ORCH_INVALID_OUTPUT",
          "Не удалось сформулировать вопросы. Попробуйте ещё раз.",
          true,
        );
      const m = await insertMessage(t, {
        systemId: sys.id,
        role: "assistant",
        kind: "questions",
        text: out.text ?? null,
        payload: {
          questionIds: out.questions.map((q) => q.id),
          ...(out.analysis ? { analysis: out.analysis } : {}),
        },
        runId: run.id,
      });
      if (stage !== "building")
        await move(stage === "card" ? "interview" : stage, { pending_questions: json(out.questions) });
      await appendEvent(t, run.id, "chat_output", { kind: "questions", messageId: m.id });
      return;
    }
    if (out.kind === "card") {
      const card = out.card;
      const cap = (card.cap as { credits?: unknown } | undefined)?.credits;
      if (!card.estimate || typeof cap !== "number" || !Number.isInteger(cap) || cap < 1)
        throw new RunFailure(
          "ORCH_INVALID_OUTPUT",
          "Карточка системы получилась неполной. Попробуйте ещё раз.",
          true,
        );
      const kind = sys.preview_revision !== null ? "change" : "create";
      if (kind === "change" && typeof card.summary !== "string")
        throw new RunFailure("ORCH_INVALID_OUTPUT", "В карточке правки нет описания изменений.", true);
      const cardVersion = sys.card_version + 1;
      const full = { ...card, cardVersion, kind };
      const m = await insertMessage(t, {
        systemId: sys.id,
        role: "assistant",
        kind: "card",
        text: out.text ?? null,
        payload: { cardVersion },
        runId: run.id,
      });
      if (stage === "card" || canTransition(stage, "card")) {
        const title =
          typeof card.title === "string" && kind === "create" ? card.title.slice(0, 80) : undefined;
        await move("card", {
          card: json(full),
          card_version: cardVersion,
          pending_questions: json([]),
          ...(title ? { name: title } : {}),
        });
      }
      await appendEvent(t, run.id, "chat_output", {
        kind: kind === "change" ? "change_proposal" : "card",
        messageId: m.id,
        cardVersion,
      });
      return;
    }
    const m = await insertMessage(t, {
      systemId: sys.id,
      role: "assistant",
      kind: "text",
      text: out.text,
      runId: run.id,
    });
    await appendEvent(t, run.id, "chat_output", { kind: "answer", messageId: m.id });
  }

  /** Files of the committed draft revision (ui/** and functions/**). */
  async #filesAt(systemId: string, version: number): Promise<Map<string, string>> {
    const m = await loadManifest(this.#db, this.#d.blobs, systemId, version);
    const out = new Map<string, string>();
    for (const [p, sha] of Object.entries(m))
      if (p.startsWith("ui/") || p.startsWith("functions/"))
        out.set(p, (await this.#d.blobs.get(sha)).toString("utf8"));
    return out;
  }

  async #build(x: Ctx, capMilli: number | null): Promise<Result> {
    const { run } = x;
    if (run.mode === "change") await this.#draftSnapshot(x);
    const input = run.input as {
      card?: Record<string, unknown>;
      target?: PointEditTarget;
      fromRevision?: number;
    };
    const mode = (run.mode ?? "create") as BuildParams["mode"];
    if (mode === "point_edit" && !input.target)
      throw new RunFailure("INTERNAL", "Не указан элемент для правки по клику");
    const out = await this.#runBuilder(x, {
      card: input.card ?? {},
      cap: Number(capMilli ?? 0) / 1000,
      mode,
      ...(mode === "point_edit" && input.target ? { target: input.target } : {}),
    });
    if (mode === "point_edit" && input.target && typeof input.fromRevision === "number")
      await this.#assertPointEditScope(x, input.fromRevision, input.target.file);
    if (out?.status === "cancelled")
      return { status: "cancelled", summary_ru: out.summary_ru ?? "Сборка остановлена" };
    if (run.mode === "change") await this.#aiBackfill(x, input.card ?? null);
    return { status: "succeeded", summary_ru: out?.summary_ru ?? "Сборка завершена" };
  }

  /**
   * M3-02: card.aiBackfill of an approved change card → backfill requests for draft and prod (db.yaml#ai_backfills);
   * the draft one runs now over the draft records (prod after its publication, publish/workflows.ts). A failed
   * backfill does not fail the build: the action itself works, the rows stay as they were.
   */
  async #aiBackfill(x: Ctx, card: Record<string, unknown> | null): Promise<void> {
    const { run, D } = x;
    const systemId = run.system_id as string;
    const sys = await this.#db
      .selectFrom("platform.systems")
      .select(["name", "schema_key", "preview_revision"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    if (sys.preview_revision === null) return;
    const spec = await loadSpec(this.#db, { id: systemId, name: sys.name }, sys.preview_revision);
    const actions = backfillActions(card, spec);
    if (actions.length === 0) return;
    await D.step("ai_backfill_request", () =>
      requestBackfills(this.#db, { systemId, runId: run.id, actions }),
    );
    await this.#step(x, "ai_backfill", "Заполняю старые записи с помощью ИИ", () =>
      D.step(
        "ai_backfill",
        async () => {
          const res = await runPendingBackfills(this.#db, {
            systemId,
            systemKey: sys.schema_key,
            env: "draft",
            spec,
            runtime: this.#d.aiBackfill ?? httpRuntimeBackfill(this.#d.config),
          });
          for (const r of res.filter((b) => b.stopCode))
            this.#log("ai_backfill stopped", new Error(`${r.action}: ${r.stopCode}`));
          return res.length;
        },
        { offload: true },
      ),
    );
  }

  /** The build executor over this run's durable BuildHost (build runs; import_table schema_ops). */
  async #runBuilder(x: Ctx, params: BuildParams): Promise<BuildOutcome | undefined> {
    const { run, D } = x;
    const needsInput = (req: InputRequest | SecretInputRequest) => this.#needsInput(x, req);
    const base = this.#stepHost(x, needsInput);
    const systemId = run.system_id as string;
    const pending = new Map<string, string | null>();
    const system = () =>
      this.#db
        .selectFrom("platform.systems")
        .selectAll()
        .where("id", "=", systemId)
        .executeTakeFirstOrThrow();
    const manifestNow = async (): Promise<Manifest> => {
      const s = await system();
      return loadManifest(this.#db, this.#d.blobs, systemId, s.draft_revision);
    };
    // point_edit (builder.yaml#point_and_edit): the working tree may change target.file only; the builder already
    // refuses other paths with TARGET_ONLY, the store refuses them again (defence in depth, M3-01).
    const only = params.mode === "point_edit" ? (params.target?.file ?? null) : null;
    const checkPath = (p: string) => {
      if (!isSafePath(p) || !(p.startsWith("ui/") || p.startsWith("functions/")))
        throw new Error(`Путь ${p} вне ui/** и functions/**`);
      if (params.mode === "point_edit" && p !== only)
        throw new Error(`TARGET_ONLY: в правке по клику можно менять только ${only}`);
    };
    const commitFiles = async () => {
      if (pending.size === 0) return null;
      await this.#ensureActive(x);
      const changes = [...pending].map(([path, content]) => ({
        path,
        content: content === null ? null : Buffer.from(content, "utf8"),
      }));
      const version = await D.step("commit_files", async () => {
        const r = await this.#tx((t) =>
          commitFilesRevision(t, this.#d.blobs, { systemId, changes, runId: run.id, author: "agent" }),
        );
        return r.version;
      });
      pending.clear();
      return { revision: version };
    };
    const filesAt = async () => this.#filesAt(systemId, (await system()).draft_revision);
    const host: BuildHost = {
      ...base,
      managesBudget: true,
      needsInput,
      qa: this.#d.executors.qa ?? {
        generate: async () => {
          throw new Error("QA-агент не подключён");
        },
        explain: async () => {
          throw new Error("QA-агент не подключён");
        },
      },
      store: {
        getSpec: async () => {
          const s = await D.step("get_spec", async () => {
            const sys = await system();
            return { version: sys.draft_revision, name: sys.name };
          });
          // Revisions are immutable: the spec is read by version, not checkpointed.
          return {
            spec: await loadSpec(this.#db, { id: systemId, name: s.name }, s.version),
            version: s.version,
          };
        },
        applyOps: async (ops, expectedVersion, idemKey) => {
          if (params.mode === "point_edit")
            throw new Error("TARGET_ONLY: в правке по клику спека не меняется (ask_orchestrator)");
          await this.#ensureActive(x);
          return D.step(
            "apply_ops",
            () =>
              this.#tx((t) =>
                applyOpsRevision(t, this.#d.blobs, {
                  systemId,
                  ops,
                  expectedVersion,
                  kind: "ops",
                  author: "agent",
                  runId: run.id,
                  idempotencyKey: idemKey ?? null,
                }),
              ),
            { offload: true },
          );
        },
        writeFile: async (path, content) => {
          checkPath(path);
          pending.set(path, content);
        },
        deleteFile: async (path) => {
          checkPath(path);
          pending.set(path, null);
        },
        readFile: async (path) => {
          if (pending.has(path)) return pending.get(path) ?? null;
          const sha = await D.step("read_file", async () => (await manifestNow())[path] ?? null);
          return sha ? (await this.#d.blobs.get(sha)).toString("utf8") : null;
        },
        listFiles: async (prefix = "") => {
          const all = new Set(await D.step("list_files", async () => Object.keys(await manifestNow())));
          for (const [p, c] of pending) c === null ? all.delete(p) : all.add(p);
          return [...all].filter((p) => p.startsWith(prefix)).sort();
        },
        commitFiles,
      },
      runGates: (level, overrides) =>
        base.runStep(`gate_${level}`, () => this.#gate(x, level, commitFiles, filesAt, overrides)),
    };
    const out = await this.#d.executors.build(host, params);
    await commitFiles();
    return out;
  }

  /**
   * import_table (workflows.yaml#workflows.import_table): steps live in ../imports/workflow.ts. The uploaded file stays
   * in the ImportStore; checkpoints hold only import-row state and the mapping (never cell values).
   */
  async #importTable(x: Ctx): Promise<Result> {
    const { run, D } = x;
    const needsInput = (req: InputRequest) => this.#needsInput(x, req);
    const base = this.#stepHost(x, needsInput);
    this.#imports ??= new ImportStore(this.#d.config.importsDir, this.#d.config.secretsKey);
    const out = await runImportTable({
      run: {
        id: run.id,
        orgId: run.org_id,
        systemId: run.system_id as string,
        input: run.input as unknown as ImportRunInput,
      },
      db: this.#db,
      pg: this.#d.pg,
      store: this.#imports,
      ...(this.#d.publish?.migratorRole ? { migratorRole: this.#d.publish.migratorRole } : {}),
      step: (name, label, fn) => this.#step(x, name, label, fn),
      once: (name, fn) => D.step(name, fn, { offload: true }),
      route: base.route,
      needsInput,
      buildChange: async (card, cap) => {
        const r = await this.#runBuilder(x, { card, cap, mode: "change" });
        if (r?.status === "cancelled") throw new RunCancelled(r.summary_ru ?? "Импорт остановлен");
        return r ?? {};
      },
    });
    return { status: "succeeded", summary_ru: out.summary_ru, resultRevision: out.resultRevision };
  }

  /** export (workflows.yaml#workflows.export_data): steps live in ../exports/workflow.ts; each step is a checkpoint. */
  async #export(x: Ctx): Promise<Result> {
    const { run, D } = x;
    this.#exports ??= new ExportStore(this.#d.config.artifactsDir, this.#d.config.secretsKey);
    const out = await runExport({
      run: { id: run.id, systemId: run.system_id as string, input: run.input as unknown as ExportRunInput },
      db: this.#db,
      pg: this.#d.pg,
      store: this.#exports,
      ...(this.#d.publish?.migratorRole ? { migratorRole: this.#d.publish.migratorRole } : {}),
      signal: x.ac.signal,
      // Outputs are counts per table and the archive size (no cell values), kept inline.
      step: (name, label, fn) => this.#step(x, name, label, () => D.step(name, fn)),
      log: (m, e) => this.#log(m, e),
    });
    return { status: "succeeded", summary_ru: out.summary_ru };
  }

  /**
   * M3-01 exit check (builder.yaml#point_and_edit.test): the files diff of the run = {target.file}. A violation
   * cannot pass the guards above; if it ever does, the run fails rather than report a wider change as done.
   */
  async #assertPointEditScope(x: Ctx, fromRevision: number, file: string): Promise<void> {
    const systemId = x.run.system_id as string;
    const changed = await x.D.step("point_edit_scope", async () => {
      const sys = await this.#db
        .selectFrom("platform.systems")
        .select("draft_revision")
        .where("id", "=", systemId)
        .executeTakeFirstOrThrow();
      const before = await loadManifest(this.#db, this.#d.blobs, systemId, fromRevision);
      const after = await loadManifest(this.#db, this.#d.blobs, systemId, sys.draft_revision);
      return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
        (p) => before[p] !== after[p],
      );
    });
    const foreign = changed.filter((p) => p !== file);
    if (foreign.length > 0)
      throw new RunFailure(
        "TARGET_ONLY",
        `Правка по клику затронула другие файлы (${foreign.slice(0, 3).join(", ")}) — изменения не приняты.`,
      );
  }

  /** workflows.yaml#workflows.build.steps.draft_snapshot (mode=change, prod exists, not yet copied from it). */
  async #draftSnapshot(x: Ctx): Promise<void> {
    const { run, D } = x;
    const plan = await D.step("draft_snapshot_plan", async () => {
      const sys = await this.#db
        .selectFrom("platform.systems")
        .selectAll()
        .where("id", "=", run.system_id as string)
        .executeTakeFirstOrThrow();
      if (sys.prod_revision === null) return null;
      const live = await this.#db
        .selectFrom("platform.publications")
        .select("id")
        .where("system_id", "=", sys.id)
        .where("status", "=", "live")
        .executeTakeFirst();
      if (!live) return null;
      const versions = [sys.prod_revision, sys.schema_hwm_revision, sys.preview_revision].filter(
        (v): v is number => v !== null && v > 0,
      );
      return { id: sys.id, name: sys.name, systemKey: sys.schema_key, versions, marker: live.id };
    });
    if (!plan) return;
    const specs: AppSpec[] = [];
    for (const v of plan.versions) specs.push(await loadSpec(this.#db, plan, v));
    await this.#step(
      x,
      "draft_snapshot",
      "Копирую данные работающей системы в черновик, личные данные заменяю примерами",
      () =>
        D.step(
          "draft_snapshot",
          () =>
            draftSnapshot(this.#d.pg, {
              systemKey: plan.systemKey,
              specs,
              marker: plan.marker,
              ...(this.#d.publish?.migratorRole ? { migratorRole: this.#d.publish.migratorRole } : {}),
            }),
          { offload: true },
        ),
    );
  }

  /** publish / rollback runs (workflows.yaml#workflows.publish, #rollback): steps live in ../publish/workflows.ts. */
  async #flow(x: Ctx): Promise<Result> {
    const { run, D } = x;
    const systemId = run.system_id as string;
    const filesAt = async (): Promise<Map<string, string>> => {
      const s = await this.#db
        .selectFrom("platform.systems")
        .select("draft_revision")
        .where("id", "=", systemId)
        .executeTakeFirstOrThrow();
      return this.#filesAt(systemId, s.draft_revision);
    };
    const host: FlowHost = {
      run,
      db: this.#db,
      pg: this.#d.pg,
      blobs: this.#d.blobs,
      config: this.#d.config,
      gates: this.#d.executors.gates,
      signal: x.ac.signal,
      options: this.#d.publish ?? {},
      tx: (fn) => this.#tx(fn),
      step: (name, label, fn) => this.#step(x, name, label, () => D.step(name, fn, { offload: true })),
      once: (name, fn) => D.step(name, fn, { offload: true }),
      draftG0: () =>
        this.#step(x, "gate_G0", "Проверяю, что черновик собирается", () =>
          this.#gate(x, "G0", async () => null, filesAt, undefined),
        ),
      ...(this.#d.aiBackfill !== undefined ? { aiBackfill: this.#d.aiBackfill } : {}),
    };
    const out: FlowResult = run.kind === "publish" ? await runPublish(host) : await runRollback(host);
    return { status: "succeeded", ...out };
  }

  async #gate(
    x: Ctx,
    level: GateLevel,
    commitFiles: () => Promise<unknown>,
    filesAt: () => Promise<Map<string, string>>,
    overrides: Partial<GateContext> | undefined,
  ): Promise<GateReport> {
    const gates = this.#d.executors.gates;
    if (!gates) throw new RunFailure("INTERNAL", "Проверки (гейты) пока не подключены к платформе", true);
    await commitFiles();
    const { run } = x;
    const systemId = run.system_id as string;
    // One checkpoint: gate_started, the gate, gate_reports + gate_result and the post-G0 draft steps.
    return x.D.step(
      `gate_${level}`,
      async () => {
        const sys = await this.#db
          .selectFrom("platform.systems")
          .selectAll()
          .where("id", "=", systemId)
          .executeTakeFirstOrThrow();
        const revision = sys.draft_revision;
        await this.#emit(x, "gate_started", { level, revision });
        const spec: AppSpec = await loadSpec(this.#db, sys, revision);
        const files = await filesAt();
        const ctx: GateContext = {
          spec,
          prevSpec:
            sys.preview_revision !== null ? await loadSpec(this.#db, sys, sys.preview_revision) : null,
          specVersion: revision,
          files,
          env: "draft",
          systemKey: sys.schema_key,
          db: this.#d.pg,
          milestone: this.#d.config.milestone,
          signal: x.ac.signal,
          ...overrides,
        };
        const report = { ...(await gates(level, ctx)), level };
        // G1 of a build: the QA scenarios it ran are kept when it passes (db.yaml#g1_checks) for the publish G1.
        const qa = level === "G1" && ctx.checks?.length ? { spec, checks: ctx.checks } : undefined;
        await this.#tx((t) => recordGateReport(t, { runId: run.id, systemId, revision, report, qa }));
        if (level === "G0" && report.passed && this.#d.executors.onG0Passed) {
          const r = await this.#d.executors.onG0Passed({
            systemId,
            systemKey: sys.schema_key,
            revision,
            spec,
            files,
            runId: run.id,
            prevSpec: ctx.prevSpec,
          });
          if (r?.bundleKey) {
            const bundleKey = r.bundleKey;
            await this.#tx(async (t) => {
              await t.trx
                .updateTable("platform.revisions")
                .set({ bundle_key: bundleKey })
                .where("system_id", "=", systemId)
                .where("version", "=", revision)
                .execute();
              await t.trx
                .updateTable("platform.systems")
                .set({ preview_revision: revision, updated_at: new Date() })
                .where("id", "=", systemId)
                .execute();
            });
          }
        }
        return report;
      },
      { offload: true },
    );
  }
}
