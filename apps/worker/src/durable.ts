// Durable (platform-api runs/durable.ts) over DBOS Transact: steps are DBOS.runStep checkpoints, waits are
// DBOS.recv/send. Offloaded outputs and every error are reduced before they reach dbos.* (L3-09).
import { DBOS } from "@dbos-inc/dbos-sdk";
import { type Durable, decodeError, type EncodedError, encodeError } from "@wizard/platform-api";
import type { StepRef, StepStore } from "./step-store.js";

/** Poll period of waits for user input and lock hand-over. */
export const RECV_POLL_MS = 500;

type Checkpoint = { v: unknown } | { ref: StepRef } | { err: EncodedError };

export function dbosDurable(runId: string, store: StepStore): Durable {
  const d = {
    durable: true as const,
    replayed: false,
    async step<T>(name: string, fn: () => Promise<T>, o?: { offload?: boolean }): Promise<T> {
      // A step inside a step is part of the outer checkpoint.
      if (DBOS.isInStep()) return fn();
      let executed = false;
      const cp = await DBOS.runStep(
        async (): Promise<Checkpoint> => {
          executed = true;
          try {
            const v = await fn();
            if (o?.offload && v !== undefined && v !== null) return { ref: await store.put(runId, v) };
            return { v };
          } catch (e) {
            return { err: encodeError(e) };
          }
        },
        { name },
      );
      d.replayed = !executed;
      if ("err" in cp) throw decodeError(cp.err);
      if ("ref" in cp) return store.get<T>(runId, cp.ref);
      return cp.v as T;
    },
    // Without LISTEN/NOTIFY (PgBouncer) recv polls dbos.notifications.
    recv: <T>(topic: string, timeoutMs: number) =>
      DBOS.recv<T>(topic, {
        timeoutSeconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
        pollingIntervalMs: RECV_POLL_MS,
      }),
    send: (to: string, topic: string, message: unknown) => DBOS.send(to, message, topic),
  };
  return d;
}
