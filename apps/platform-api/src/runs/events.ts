// Run events: specs/platform/workflows.yaml#events. The table is the source of truth; the bus only wakes SSE readers.
import type { Transaction } from "kysely";
import { type DB, type Db, json } from "../db/index.js";

export const EVENT_TYPES = [
  "run_started",
  "plan_ready",
  "step_started",
  "step_finished",
  "agent_message",
  "chat_output",
  "model_switched",
  "models_unavailable",
  "ops_applied",
  "file_written",
  "gate_started",
  "gate_result",
  "budget_update",
  "budget_exceeded",
  "lock_waiting",
  "needs_input",
  "input_received",
  "run_finished",
  "run_failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Written to run_events, never streamed to the user (workflows.yaml#events.rules). */
export const INTERNAL_EVENTS: ReadonlySet<string> = new Set(["model_switched", "models_unavailable"]);
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["run_finished", "run_failed"]);

export interface RunEvent {
  runId: string;
  seq: number;
  type: string;
  ts: string;
  payload: Record<string, unknown>;
}

type Listener = (e: RunEvent) => void;

export class EventBus {
  readonly #listeners = new Map<string, Set<Listener>>();
  subscribe(runId: string, fn: Listener): () => void {
    let set = this.#listeners.get(runId);
    if (!set) {
      set = new Set();
      this.#listeners.set(runId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.#listeners.delete(runId);
    };
  }
  publish(e: RunEvent): void {
    for (const fn of this.#listeners.get(e.runId) ?? []) {
      try {
        fn(e);
      } catch {
        // a broken subscriber must not break the writer
      }
    }
  }
}

export interface TxCtx {
  trx: Transaction<DB>;
  events: RunEvent[];
  /** Side effects after commit (metrics, M2-09); never run when the transaction rolls back. */
  after?: (() => void)[];
}

/** Runs fn in a transaction; events appended inside are published to the bus after commit, then `after` hooks run. */
export async function withTx<T>(db: Db, bus: EventBus, fn: (t: TxCtx) => Promise<T>): Promise<T> {
  const events: RunEvent[] = [];
  const after: (() => void)[] = [];
  const out = await db.transaction().execute((trx) => fn({ trx, events, after }));
  for (const e of events) bus.publish(e);
  for (const f of after) {
    try {
      f();
    } catch {
      // Metrics must never break a committed transition.
    }
  }
  return out;
}

/** Appends an event with the next gap-free seq (run row locked for the rest of the transaction). */
export async function appendEvent(
  t: TxCtx,
  runId: string,
  type: EventType,
  payload: Record<string, unknown>,
): Promise<RunEvent> {
  await t.trx
    .selectFrom("platform.runs")
    .select("id")
    .where("id", "=", runId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const { next } = await t.trx
    .selectFrom("platform.run_events")
    .select((eb) => eb.fn.coalesce(eb.fn.max("seq"), eb.lit(0)).as("next"))
    .where("run_id", "=", runId)
    .executeTakeFirstOrThrow();
  const seq = Number(next) + 1;
  const row = await t.trx
    .insertInto("platform.run_events")
    .values({ run_id: runId, seq, type, payload: json(payload) })
    .returning("ts")
    .executeTakeFirstOrThrow();
  const e: RunEvent = { runId, seq, type, ts: new Date(row.ts).toISOString(), payload };
  t.events.push(e);
  return e;
}

export async function listEvents(db: Db, runId: string, afterSeq: number): Promise<RunEvent[]> {
  const rows = await db
    .selectFrom("platform.run_events")
    .selectAll()
    .where("run_id", "=", runId)
    .where("seq", ">", afterSeq)
    .orderBy("seq")
    .execute();
  return rows.map((r) => ({
    runId: r.run_id,
    seq: r.seq,
    type: r.type,
    ts: new Date(r.ts).toISOString(),
    payload: r.payload,
  }));
}
