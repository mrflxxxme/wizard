// Execution context of one run (workflows.yaml#execution): in-process in M0 and unit tests, DBOS in apps/worker (M1).
// Every side effect of a workflow goes through step(); waits for user input and lock hand-over go through recv().
import { LlmError, type LlmErrorCode } from "@wizard/llm";
import { safeError } from "@wizard/pii/log";
import { ApiError, type ErrorCode } from "../errors.js";
import { RunCancelled, RunFailure } from "./types.js";

export interface StepOptions {
  /**
   * The result is replayed by reference only: the durable store keeps it outside dbos.* and DBOS records a ref
   * (execution.M1.dbos_data, L3-09). Use for LLM outputs, specs, reports and anything with user content.
   */
  offload?: boolean;
}

export interface Durable {
  /** true: steps are checkpointed and replayed after a worker restart (DBOS). */
  readonly durable: boolean;
  /** Checkpointed step (DBOS.runStep); nested calls run inline. */
  step<T>(name: string, fn: () => Promise<T>, o?: StepOptions): Promise<T>;
  /** true when the last step() returned a checkpoint instead of executing (replay after a restart). */
  readonly replayed: boolean;
  /** Durable wait for a message to this run (DBOS.recv); null on timeout. */
  recv<T>(topic: string, timeoutMs: number): Promise<T | null>;
  /** Durable message to another run's workflow (DBOS.send). */
  send(runId: string, topic: string, message: unknown): Promise<void>;
}

/** Topics of run workflows. */
export const TOPIC_INPUT = "input";
export const TOPIC_LOCK = "lock";

/** Message on TOPIC_INPUT: an answer of POST /runs/:id/input or a cancel request. */
export type InputMessage =
  | { cancel: true }
  | { inputId: string; choice: string | null; text?: string; secretRef?: string };

/** Errors crossing a checkpoint: domain classes survive replay, anything else is reduced (no raw messages). */
export type EncodedError =
  | { t: "RunFailure"; code: string; message_ru: string; retryable: boolean }
  | { t: "RunCancelled"; summary_ru: string }
  | { t: "LlmError"; code: string; message: string }
  | { t: "ApiError"; code: string; message_ru: string; details?: Record<string, unknown> }
  | { t: "Error"; name: string; code?: string; detail: Record<string, unknown> };

export function encodeError(e: unknown): EncodedError {
  if (e instanceof RunFailure)
    return { t: "RunFailure", code: e.code, message_ru: e.message_ru, retryable: e.retryable };
  if (e instanceof RunCancelled) return { t: "RunCancelled", summary_ru: e.summary_ru };
  if (e instanceof LlmError) return { t: "LlmError", code: e.code, message: e.message };
  if (e instanceof ApiError)
    return {
      t: "ApiError",
      code: e.code,
      message_ru: e.message_ru,
      ...(e.details ? { details: e.details } : {}),
    };
  const s = safeError(e);
  return { t: "Error", name: s.type, ...(s.code ? { code: s.code } : {}), detail: { ...s } };
}

/** An error rebuilt after a checkpoint; generic errors keep only the safeError fields. */
export class ReplayedError extends Error {
  constructor(
    override readonly name: string,
    readonly code: string | undefined,
    readonly detail: Record<string, unknown>,
  ) {
    super(`step failed: ${name}${code ? ` ${code}` : ""}`);
  }
}

export function decodeError(e: EncodedError): Error {
  switch (e.t) {
    case "RunFailure":
      return new RunFailure(e.code, e.message_ru, e.retryable);
    case "RunCancelled":
      return new RunCancelled(e.summary_ru);
    case "LlmError":
      return new LlmError(e.code as LlmErrorCode, e.message);
    case "ApiError":
      return new ApiError(e.code as ErrorCode, e.message_ru, e.details);
    default:
      return new ReplayedError(e.name, e.code, e.detail);
  }
}

interface Mailbox {
  queue: unknown[];
  wake?: () => void;
}

/** In-process messages between the HTTP handlers and running workflows of one RunEngine (M0 / unit tests). */
export class LocalMailboxes {
  readonly #boxes = new Map<string, Mailbox>();

  #box(runId: string, topic: string): Mailbox {
    const k = `${runId}\u0000${topic}`;
    let b = this.#boxes.get(k);
    if (!b) {
      b = { queue: [] };
      this.#boxes.set(k, b);
    }
    return b;
  }

  send(runId: string, topic: string, message: unknown): void {
    const b = this.#box(runId, topic);
    b.queue.push(message);
    b.wake?.();
  }

  async recv<T>(runId: string, topic: string, timeoutMs: number): Promise<T | null> {
    const b = this.#box(runId, topic);
    if (b.queue.length === 0) {
      let timer: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        b.wake = resolve;
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      clearTimeout(timer);
      b.wake = undefined;
    }
    const m = b.queue.shift();
    if (b.queue.length === 0) this.#boxes.delete(`${runId}\u0000${topic}`);
    return m === undefined ? null : (m as T);
  }

  /** Drops the mailboxes of a finished run. */
  clear(runId: string): void {
    for (const k of this.#boxes.keys()) if (k.startsWith(`${runId}\u0000`)) this.#boxes.delete(k);
  }
}

/** Identity steps and in-memory mailboxes (workflows.yaml#execution.M0: durability is not promised). */
export function inProcessDurable(runId: string, boxes: LocalMailboxes): Durable {
  return {
    durable: false,
    replayed: false,
    step: (_name, fn) => fn(),
    recv: (topic, timeoutMs) => boxes.recv(runId, topic, timeoutMs),
    send: async (to, topic, message) => boxes.send(to, topic, message),
  };
}
