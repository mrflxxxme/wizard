// M0 run engine (workflows.yaml#execution.M0): in-process FIFO queue, global concurrency, platform.locks,
// run lifecycle (workflows.yaml#run_lifecycle) and restart recovery.
import { randomUUID } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import {
  CircuitBreaker,
  createRegistry,
  createRouter,
  LlmError,
  type Router,
  type RouterOptions,
} from "@wizard/llm";
import { type Selectable, sql } from "kysely";
import type postgres from "postgres";
import type { Config } from "../config.js";
import { type Db, json } from "../db/index.js";
import type { RunsTable } from "../db/types.js";
import { ApiError } from "../errors.js";
import { insertMessage } from "../services/messages.js";
import {
  applyOpsRevision,
  commitFilesRevision,
  isSafePath,
  loadManifest,
  loadSpec,
  lockSystem,
} from "../services/revisions.js";
import { assertTransition, canTransition, type Stage, stageAfterBuild } from "../services/stage.js";
import type { BlobStore } from "../storage/blobs.js";
import { appendEvent, type EventBus, type EventType, type TxCtx, withTx } from "./events.js";
import { recordGateReport } from "./gates.js";
import {
  type BuildHost,
  type GateContext,
  type GateLevel,
  type GateReport,
  type HostRouteInput,
  type InputAnswer,
  type InputRequest,
  type InterviewContext,
  type InterviewOutput,
  RunCancelled,
  type RunExecutors,
  RunFailure,
  type StepHost,
} from "./types.js";
import { DbUsageSink } from "./usage.js";

export const ACTIVE_STATUSES = ["queued", "waiting_lock", "running", "needs_input"] as const;
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);
const NEEDS_LOCK: ReadonlySet<string> = new Set(["build", "publish", "rollback", "import_table"]);
const PLATFORM_EVENTS: ReadonlySet<string> = new Set([
  "run_started",
  "run_finished",
  "run_failed",
  "lock_waiting",
]);
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 30_000;
export const INPUT_TIMEOUT_MS = 24 * 3600_000;
/** workflows.yaml#workflows.interview_turn.budget */
export const INTERVIEW_CAP_MILLI = 2000;

type Run = Selectable<RunsTable>;
type Result =
  | { status: "succeeded" | "cancelled"; summary_ru: string }
  | { status: "failed"; code: string; message_ru: string; retryable: boolean };

export interface EngineDeps {
  db: Db;
  pg: postgres.Sql;
  bus: EventBus;
  blobs: BlobStore;
  config: Config;
  executors: RunExecutors;
  /** Router factory (tests); default createRouter with DbUsageSink. */
  createRouter?: (opts: RouterOptions) => Router;
  log?: (msg: string, err?: unknown) => void;
}

interface Waiter {
  resolve(a: InputAnswer): void;
  reject(e: unknown): void;
}

export interface NewRun {
  orgId: string;
  systemId: string;
  kind: "interview_turn" | "build";
  mode?: "create" | "change" | "fix" | null;
  input?: Record<string, unknown>;
  cardVersion?: number | null;
  estimateMilli?: number | null;
  capMilli?: number | null;
  startedBy: string;
}

export async function insertRun(t: TxCtx, r: NewRun): Promise<Run> {
  return t.trx
    .insertInto("platform.runs")
    .values({
      org_id: r.orgId,
      system_id: r.systemId,
      kind: r.kind,
      mode: r.mode ?? null,
      input: json(r.input ?? {}),
      card_version: r.cardVersion ?? null,
      credits_estimate_milli: r.estimateMilli ?? null,
      credits_cap_milli: r.capMilli ?? (r.kind === "interview_turn" ? INTERVIEW_CAP_MILLI : null),
      started_by: r.startedBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

function toResult(e: unknown, aborted: boolean): Result {
  if (e instanceof RunCancelled) return { status: "cancelled", summary_ru: e.summary_ru };
  if (e instanceof RunFailure)
    return { status: "failed", code: e.code, message_ru: e.message_ru, retryable: e.retryable };
  if (e instanceof LlmError) {
    if (e.code === "LLM_UNAVAILABLE")
      return { status: "failed", code: "LLM_UNAVAILABLE", message_ru: e.message, retryable: true };
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

export class RunEngine {
  readonly #d: EngineDeps;
  readonly #queue: string[] = [];
  readonly #meta = new Map<string, string | null>();
  readonly #busyKeys = new Set<string>();
  readonly #active = new Set<string>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #waiters = new Map<string, Waiter>();
  readonly #lockWaiters = new Map<string, string[]>();
  readonly #circuit = new CircuitBreaker();
  #closed = false;

  constructor(deps: EngineDeps) {
    this.#d = deps;
  }

  get #db(): Db {
    return this.#d.db;
  }

  #log(msg: string, err?: unknown): void {
    (this.#d.log ?? ((m, e) => console.error(`[platform-api] ${m}`, e ?? "")))(msg, err);
  }

  #tx<T>(fn: (t: TxCtx) => Promise<T>): Promise<T> {
    return withTx(this.#db, this.#d.bus, fn);
  }

  /** Adds a persisted queued run; interview turns of one system run one at a time. */
  enqueue(run: { id: string; kind: string; system_id: string | null }, front = false): void {
    if (this.#closed) return;
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
      const task: Promise<void> = this.#execute(id).finally(() => {
        if (key) this.#busyKeys.delete(key);
        this.#meta.delete(id);
        this.#active.delete(id);
        this.#tasks.delete(task);
        this.#pump();
      });
      this.#tasks.add(task);
    }
  }

  /** Resolves when nothing is executing (tests). */
  async idle(): Promise<void> {
    while (this.#tasks.size > 0) await Promise.allSettled([...this.#tasks]);
  }

  /** Stops accepting work and aborts executors WITHOUT finalizing runs (simulates a process stop). */
  async close(): Promise<void> {
    this.#closed = true;
    for (const c of this.#controllers.values()) c.abort();
    for (const w of this.#waiters.values()) w.reject(new RunCancelled());
    await Promise.allSettled([...this.#tasks]);
  }

  /** workflows.yaml#execution.M0.restart: every non-terminal run → failed WORKER_RESTARTED. */
  async recover(): Promise<number> {
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

  async #execute(id: string): Promise<void> {
    const ac = new AbortController();
    this.#controllers.set(id, ac);
    let result: Result | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let locked = false;
    try {
      const run = await this.#loadRun(id);
      if (!run || TERMINAL_STATUSES.has(run.status)) return;
      if (NEEDS_LOCK.has(run.kind) && run.system_id) {
        const holder = await this.#acquireLock(run);
        if (holder) {
          await this.#waitLock(run, holder);
          return;
        }
        locked = true;
      }
      if (!(await this.#start(run))) {
        if (locked) await this.#releaseLock(run.id, run.system_id);
        return;
      }
      if (locked) {
        heartbeat = setInterval(() => {
          this.#heartbeat(id).catch((e) => this.#log("heartbeat failed", e));
        }, HEARTBEAT_MS);
        heartbeat.unref();
      }
      if (run.kind === "interview_turn") result = await this.#interview(run, ac);
      else if (run.kind === "build") result = await this.#build(run, ac);
      else throw new RunFailure("INTERNAL", "Этот тип прогона ещё не поддерживается");
    } catch (e) {
      if (!(e instanceof RunFailure || e instanceof RunCancelled || e instanceof LlmError))
        this.#log(`run ${id} failed`, e);
      result = toResult(e, ac.signal.aborted);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.#controllers.delete(id);
      if (result && !this.#closed) {
        const r = result;
        await this.#tx((t) => this.#finalize(t, id, r))
          .then((sys) => this.#wakeLock(sys))
          .catch((e) => this.#log(`finalize ${id} failed`, e));
      }
    }
  }

  async #acquireLock(run: Run): Promise<string | null> {
    const res = await sql<{ run_id: string }>`
      INSERT INTO platform.locks (system_id, run_id, holder_user_id, lease_until)
      VALUES (${run.system_id}, ${run.id}, ${run.started_by}, now() + ${`${LEASE_MS} milliseconds`}::interval)
      ON CONFLICT (system_id) DO UPDATE
        SET run_id = EXCLUDED.run_id, holder_user_id = EXCLUDED.holder_user_id,
            acquired_at = now(), lease_until = EXCLUDED.lease_until
        WHERE platform.locks.lease_until < now() OR platform.locks.run_id = EXCLUDED.run_id
      RETURNING run_id`.execute(this.#db);
    if (res.rows.length > 0) return null;
    const holder = await this.#db
      .selectFrom("platform.locks")
      .select("run_id")
      .where("system_id", "=", run.system_id as string)
      .executeTakeFirst();
    return holder?.run_id ?? "";
  }

  async #releaseLock(runId: string, systemId: string | null): Promise<void> {
    await this.#db.deleteFrom("platform.locks").where("run_id", "=", runId).execute();
    this.#wakeLock(systemId);
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

  async #waitLock(run: Run, holder: string): Promise<void> {
    const sysId = run.system_id as string;
    const list = this.#lockWaiters.get(sysId) ?? [];
    if (!list.includes(run.id)) list.push(run.id);
    this.#lockWaiters.set(sysId, list);
    await this.#tx(async (t) => {
      const cur = await t.trx
        .selectFrom("platform.runs")
        .select(["status"])
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
      await appendEvent(t, run.id, "lock_waiting", {
        holderRunId: holder,
        holderName: holderRun?.kind === "build" ? "Сборка" : "Другой прогон",
        position: list.indexOf(run.id) + 1,
      });
    });
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

  async #start(run: Run): Promise<boolean> {
    return this.#tx(async (t) => {
      const cur = await t.trx
        .selectFrom("platform.runs")
        .selectAll()
        .where("id", "=", run.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if ((cur.status !== "queued" && cur.status !== "waiting_lock") || cur.cancel_requested_at) return false;
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
      const cap = cur.credits_cap_milli;
      await appendEvent(t, run.id, "run_started", {
        kind: cur.kind,
        ...(cur.mode ? { mode: cur.mode } : {}),
        baseRevision: base,
        credits:
          cap === null
            ? null
            : { estimate: Number(cur.credits_estimate_milli ?? 0) / 1000, cap: Number(cap) / 1000 },
      });
      return true;
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
    const resultRevision =
      isBuild && sys && run.base_revision !== null && sys.draft_revision > run.base_revision
        ? sys.draft_revision
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
        prodUrl: null,
      });
    }
    return released.length > 0 ? (released[0]?.system_id ?? null) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // HTTP-facing operations

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
    this.#waiters.get(runId)?.reject(new RunCancelled());
  }

  /** POST /runs/:id/input (caller checked access and body shape). */
  async provideInput(
    runId: string,
    body: { inputId: string; choice?: string; text?: string; secretValue?: string },
  ) {
    const answer = await this.#tx(async (t) => {
      const run = await t.trx
        .selectFrom("platform.runs")
        .selectAll()
        .where("id", "=", runId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const pending = run.pending_input as
        | (Omit<InputRequest, "kind"> & { inputId: string; kind: "decision" | "secret" })
        | null;
      if (run.status !== "needs_input" || !pending)
        throw new ApiError("RUN_NOT_WAITING_INPUT", "Прогон сейчас не ждёт ответа");
      if (pending.inputId !== body.inputId)
        throw new ApiError("RUN_NOT_WAITING_INPUT", "Этот запрос уже неактуален — обновите страницу");
      if (body.secretValue !== undefined)
        throw new ApiError("VALIDATION_FAILED", "Ввод секретов появится позже; выберите один из вариантов");
      const option = pending.options?.find((o) => o.id === body.choice);
      if (!body.choice || !option)
        throw new ApiError("VALIDATION_FAILED", "Выберите один из предложенных вариантов");
      if (body.text !== undefined && !option.freeText)
        throw new ApiError("VALIDATION_FAILED", "Для этого варианта свой текст не нужен");
      await t.trx
        .updateTable("platform.runs")
        .set({ status: "running", pending_input: null })
        .where("id", "=", runId)
        .execute();
      await appendEvent(t, runId, "input_received", {
        inputId: pending.inputId,
        choice: pending.kind === "secret" ? null : body.choice,
      });
      return { choice: body.choice, ...(body.text !== undefined ? { text: body.text } : {}) };
    });
    this.#waiters.get(runId)?.resolve(answer);
  }

  // ---------------------------------------------------------------------------------------------
  // Hosts

  async #ensureActive(runId: string, ac: AbortController): Promise<void> {
    if (ac.signal.aborted) throw new RunCancelled();
    const r = await this.#db
      .selectFrom("platform.runs")
      .select("cancel_requested_at")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    if (r.cancel_requested_at) {
      ac.abort();
      throw new RunCancelled();
    }
  }

  async #emit(runId: string, type: EventType, payload: Record<string, unknown>): Promise<void> {
    await this.#tx(async (t) => {
      await appendEvent(t, runId, type, payload);
      if (type === "step_started" && typeof payload.step === "string")
        await t.trx
          .updateTable("platform.runs")
          .set({ current_step: payload.step })
          .where("id", "=", runId)
          .execute();
    });
  }

  async #step<T>(
    run: Run,
    ac: AbortController,
    name: string,
    label_ru: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.#ensureActive(run.id, ac);
    await this.#emit(run.id, "step_started", { step: name, label_ru, attempt: 1 });
    const t0 = Date.now();
    const out = await fn();
    await this.#emit(run.id, "step_finished", { step: name, durationMs: Date.now() - t0 });
    return out;
  }

  #stepHost(
    run: Run,
    ac: AbortController,
    needsInput: (req: InputRequest) => Promise<InputAnswer>,
  ): StepHost {
    const routers: { r?: Router } = {};
    return {
      run: {
        id: run.id,
        orgId: run.org_id,
        systemId: run.system_id as string,
        kind: run.kind,
        mode: run.mode,
      },
      signal: ac.signal,
      runStep: async (_name, fn) => {
        await this.#ensureActive(run.id, ac);
        return fn();
      },
      emit: async (type, payload) => {
        if (PLATFORM_EVENTS.has(type)) throw new Error(`event ${type} is emitted by the platform only`);
        await this.#emit(run.id, type, payload);
      },
      route: (input) => this.#route(run, ac, routers, input, needsInput),
    };
  }

  async #route(
    run: Run,
    ac: AbortController,
    routers: { r?: Router },
    input: HostRouteInput,
    needsInput: (req: InputRequest) => Promise<InputAnswer>,
  ) {
    await this.#ensureActive(run.id, ac);
    // Budget check before every LLM step (workflows.yaml#run_lifecycle.budget).
    for (;;) {
      const cur = await this.#db
        .selectFrom("platform.runs")
        .select(["credits_used_milli", "credits_cap_milli"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      if (cur.credits_cap_milli === null) break;
      const used = Number(cur.credits_used_milli);
      const cap = Number(cur.credits_cap_milli);
      const ub = Math.round((input.upperBoundCredits ?? 0) * 1000);
      if (used + ub <= cap && used < cap) break;
      await this.#emit(run.id, "budget_exceeded", {
        used: used / 1000,
        cap: cap / 1000,
        nextStep: input.step ?? input.callType,
      });
      if (run.kind !== "build")
        throw new RunFailure(
          "BUDGET_STOPPED",
          "Ход интервью превысил лимит кредитов. Переформулируйте запрос короче.",
        );
      const n = Math.ceil((0.25 * cap) / 1000);
      const ans = await needsInput({
        decisionId: "budget",
        prompt_ru: `Лимит сборки (${cap / 1000} кр.) исчерпан. Увеличить лимит на ${n} кр. или остановить?`,
        options: [
          { id: `raise_cap_${n}`, label: `Увеличить на ${n} кр.`, recommended: true },
          { id: "stop", label: "Остановить" },
        ],
      });
      if (ans.choice === "stop") throw new RunCancelled("Сборка остановлена по лимиту кредитов");
      await this.#db
        .updateTable("platform.runs")
        .set({ credits_cap_milli: cap + n * 1000 })
        .where("id", "=", run.id)
        .execute();
    }
    const org = await this.#db
      .selectFrom("platform.orgs")
      .select(["ru_only", "t1_restricted", "region_code"])
      .where("id", "=", run.org_id)
      .executeTakeFirstOrThrow();
    const internal: Promise<unknown>[] = [];
    if (!routers.r) {
      const opts: RouterOptions = {
        registry: createRegistry({ buildDefaultTier: this.#d.config.buildDefaultTier }),
        sink: new DbUsageSink(this.#db),
        circuit: this.#circuit,
        onEvent: (e) => {
          const { type, ...payload } = e;
          internal.push(this.#emit(run.id, type, payload).catch((err) => this.#log("model_switched", err)));
        },
      };
      routers.r = (this.#d.createRouter ?? createRouter)(opts);
    }
    const { step, upperBoundCredits: _ub, ...rest } = input;
    const used0 = await this.#db
      .selectFrom("platform.runs")
      .select(["credits_used_milli", "credits_cap_milli"])
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    const out = await routers.r.route({
      ...rest,
      orgPolicy: { ruOnly: org.ru_only, t1Restricted: org.t1_restricted || org.region_code === null },
      ctx: {
        orgId: run.org_id,
        runId: run.id,
        systemId: run.system_id ?? undefined,
        ...(step ? { step } : {}),
        ...(used0.credits_cap_milli !== null
          ? {
              budget: {
                capCredits: Number(used0.credits_cap_milli) / 1000,
                spentCredits: Number(used0.credits_used_milli) / 1000,
              },
            }
          : {}),
      },
      signal: ac.signal,
    });
    await Promise.all(internal);
    await this.#tx(async (t) => {
      const row = await t.trx
        .updateTable("platform.runs")
        .set((eb) => ({ credits_used_milli: eb("credits_used_milli", "+", String(out.creditsMilli)) }))
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
    return out;
  }

  async #needsInput(run: Run, ac: AbortController, req: InputRequest): Promise<InputAnswer> {
    await this.#ensureActive(run.id, ac);
    const inputId = `${req.decisionId}-${randomUUID().slice(0, 8)}`;
    const pending = {
      inputId,
      kind: "decision" as const,
      decisionId: req.decisionId,
      prompt_ru: req.prompt_ru,
      options: req.options,
      expiresAt: new Date(Date.now() + INPUT_TIMEOUT_MS).toISOString(),
    };
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => this.#waiters.get(run.id)?.reject(new RunCancelled());
    const answer = new Promise<InputAnswer>((resolve, reject) => {
      this.#waiters.set(run.id, { resolve, reject });
      timer = setTimeout(
        () => reject(new RunFailure("INPUT_TIMEOUT", "Ответа не было 24 часа — прогон остановлен")),
        INPUT_TIMEOUT_MS,
      );
      timer.unref();
    });
    ac.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await this.#tx(async (t) => {
        await t.trx
          .updateTable("platform.runs")
          .set({ status: "needs_input", pending_input: json(pending) })
          .where("id", "=", run.id)
          .execute();
        await appendEvent(t, run.id, "needs_input", pending);
      });
      // A waiting run does not hold a concurrency slot.
      this.#active.delete(run.id);
      this.#pump();
      return await answer;
    } finally {
      clearTimeout(timer);
      ac.signal.removeEventListener("abort", onAbort);
      this.#waiters.delete(run.id);
      this.#active.add(run.id);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Workflows

  async #interview(run: Run, ac: AbortController): Promise<Result> {
    const base = this.#stepHost(run, ac, () => {
      throw new RunFailure("INTERNAL", "Ход интервью не может ждать ввода");
    });
    const systemId = run.system_id as string;
    const context = await this.#step(run, ac, "load_context", "Читаю историю", async () => {
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
      const ctx: InterviewContext = {
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
      };
      return ctx;
    });
    const out = await this.#step(run, ac, "orchestrate", "Думаю над ответом", () =>
      this.#d.executors.interviewTurn({ ...base, context }),
    );
    await this.#step(run, ac, "persist_output", "Сохраняю ответ", () =>
      this.#tx((t) => this.#persistInterview(t, run, out)),
    );
    return { status: "succeeded", summary_ru: "Ход интервью завершён" };
  }

  async #persistInterview(t: TxCtx, run: Run, out: InterviewOutput): Promise<void> {
    const sys = await lockSystem(t, run.system_id as string);
    const stage = sys.stage as Stage;
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

  async #build(run: Run, ac: AbortController): Promise<Result> {
    const needsInput = (req: InputRequest) => this.#needsInput(run, ac, req);
    const base = this.#stepHost(run, ac, needsInput);
    const systemId = run.system_id as string;
    const pending = new Map<string, string | null>();
    const system = () =>
      this.#db
        .selectFrom("platform.systems")
        .selectAll()
        .where("id", "=", systemId)
        .executeTakeFirstOrThrow();
    const committed = async () => {
      const s = await system();
      return loadManifest(this.#db, this.#d.blobs, systemId, s.draft_revision);
    };
    const readCommitted = async (path: string) => {
      const sha = (await committed())[path];
      return sha ? (await this.#d.blobs.get(sha)).toString("utf8") : null;
    };
    const checkPath = (p: string) => {
      if (!isSafePath(p) || !(p.startsWith("ui/") || p.startsWith("functions/")))
        throw new Error(`Путь ${p} вне ui/** и functions/**`);
    };
    const commitFiles = async () => {
      if (pending.size === 0) return null;
      await this.#ensureActive(run.id, ac);
      const changes = [...pending].map(([path, content]) => ({
        path,
        content: content === null ? null : Buffer.from(content, "utf8"),
      }));
      const r = await this.#tx((t) =>
        commitFilesRevision(t, this.#d.blobs, { systemId, changes, runId: run.id, author: "agent" }),
      );
      pending.clear();
      return { revision: r.version };
    };
    const filesAt = async (): Promise<Map<string, string>> => {
      const m = await committed();
      const out = new Map<string, string>();
      for (const [p, sha] of Object.entries(m)) {
        if (p.startsWith("ui/") || p.startsWith("functions/"))
          out.set(p, (await this.#d.blobs.get(sha)).toString("utf8"));
      }
      return out;
    };
    const host: BuildHost = {
      ...base,
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
          const s = await system();
          return { spec: await loadSpec(this.#db, s, s.draft_revision), version: s.draft_revision };
        },
        applyOps: async (ops, expectedVersion, idemKey) => {
          await this.#ensureActive(run.id, ac);
          return this.#tx((t) =>
            applyOpsRevision(t, this.#d.blobs, {
              systemId,
              ops,
              expectedVersion,
              kind: "ops",
              author: "agent",
              runId: run.id,
              idempotencyKey: idemKey ?? null,
            }),
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
        readFile: async (path) => (pending.has(path) ? (pending.get(path) ?? null) : readCommitted(path)),
        listFiles: async (prefix = "") => {
          const all = new Set(Object.keys(await committed()));
          for (const [p, c] of pending) c === null ? all.delete(p) : all.add(p);
          return [...all].filter((p) => p.startsWith(prefix)).sort();
        },
        commitFiles,
      },
      runGates: (level, overrides) =>
        base.runStep(`gate_${level}`, () => this.#gate(run, ac, level, commitFiles, filesAt, overrides)),
    };
    const input = run.input as { card?: Record<string, unknown> };
    const out = await this.#d.executors.build(host, {
      card: input.card ?? {},
      cap: Number(run.credits_cap_milli ?? 0) / 1000,
      mode: (run.mode ?? "create") as "create" | "change" | "fix",
    });
    await commitFiles();
    if (out?.status === "cancelled")
      return { status: "cancelled", summary_ru: out.summary_ru ?? "Сборка остановлена" };
    return { status: "succeeded", summary_ru: out?.summary_ru ?? "Сборка завершена" };
  }

  async #gate(
    run: Run,
    ac: AbortController,
    level: GateLevel,
    commitFiles: () => Promise<unknown>,
    filesAt: () => Promise<Map<string, string>>,
    overrides: Partial<GateContext> | undefined,
  ): Promise<GateReport> {
    const gates = this.#d.executors.gates;
    if (!gates) throw new RunFailure("INTERNAL", "Проверки (гейты) пока не подключены к платформе", true);
    await commitFiles();
    const systemId = run.system_id as string;
    const sys = await this.#db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    const revision = sys.draft_revision;
    await this.#emit(run.id, "gate_started", { level, revision });
    const spec: AppSpec = await loadSpec(this.#db, sys, revision);
    const files = await filesAt();
    const ctx: GateContext = {
      spec,
      prevSpec: sys.preview_revision !== null ? await loadSpec(this.#db, sys, sys.preview_revision) : null,
      specVersion: revision,
      files,
      env: "draft",
      systemKey: sys.schema_key,
      db: this.#d.pg,
      milestone: this.#d.config.milestone,
      signal: ac.signal,
      ...overrides,
    };
    const report = { ...(await gates(level, ctx)), level };
    await this.#tx((t) => recordGateReport(t, { runId: run.id, systemId, revision, report }));
    if (level === "G0" && report.passed && this.#d.executors.onG0Passed) {
      const r = await this.#d.executors.onG0Passed({
        systemId,
        systemKey: sys.schema_key,
        revision,
        spec,
        files,
        runId: run.id,
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
  }
}
