import { useCallback, useMemo, useRef, useState } from "react";
import { ru } from "../i18n/ru.js";
import type { Mutation, WzError } from "./types.js";

/** Converts anything thrown by a DataSource into WzError (message stays Russian). */
export function toWzError(e: unknown): WzError {
  if (e && typeof e === "object" && "code" in e && "message" in e) {
    const x = e as {
      code: string;
      message: string;
      status?: number;
      fields?: WzError["fields"];
      details?: { fields?: WzError["fields"]; requestId?: string };
      requestId?: string;
    };
    const fields = x.fields ?? x.details?.fields;
    const requestId = x.requestId ?? x.details?.requestId;
    return {
      code: String(x.code),
      message: String(x.message),
      status: typeof x.status === "number" ? x.status : 0,
      ...(fields ? { fields } : {}),
      ...(requestId ? { requestId } : {}),
    };
  }
  return { code: "INTERNAL", message: ru.server.INTERNAL, status: 0 };
}

/** Pending/error bookkeeping around an async function; errors are rethrown as WzError. */
export function useMutationState<A extends unknown[], R>(fn: (...args: A) => Promise<R>): Mutation<A, R> {
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<WzError | undefined>(undefined);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const mutate = useCallback(async (...args: A): Promise<R> => {
    setPending((n) => n + 1);
    setError(undefined);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      const err = toWzError(e);
      setError(err);
      throw err;
    } finally {
      setPending((n) => n - 1);
    }
  }, []);
  const reset = useCallback(() => setError(undefined), []);
  return useMemo(() => ({ mutate, pending: pending > 0, error, reset }), [mutate, pending, error, reset]);
}
