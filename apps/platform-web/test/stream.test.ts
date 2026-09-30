// subscribeRun: dedup by seq, close after the terminal event, reopen from the last seq (platform-screens.yaml#sse).
import { afterEach, expect, test, vi } from "vitest";
import type { RunEvent } from "../src/api/types.js";
import { subscribeRun } from "../src/run/stream.js";

class FakeES {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static all: FakeES[] = [];
  readyState = FakeES.OPEN;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (m: MessageEvent) => void>();
  constructor(readonly url: string) {
    FakeES.all.push(this);
  }
  addEventListener(type: string, fn: (m: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.readyState = FakeES.CLOSED;
  }
  frame(e: Partial<RunEvent> & { seq: number; type: string }) {
    const data = JSON.stringify({ runId: "r", ts: "", payload: {}, ...e });
    this.listeners.get(e.type)?.({ data } as MessageEvent);
  }
}

afterEach(() => {
  FakeES.all = [];
  vi.useRealTimers();
});

test("dedup, reconnect with ?after=<last seq>, closed after run_finished", () => {
  vi.useFakeTimers();
  const got: number[] = [];
  let terminal = 0;
  const close = subscribeRun({
    url: (after) => `/runs/r/events?after=${after}`,
    onEvent: (e) => got.push(e.seq),
    onTerminal: () => terminal++,
    EventSourceImpl: FakeES as unknown as typeof EventSource,
  });
  const a = FakeES.all[0] as FakeES;
  expect(a.url).toBe("/runs/r/events?after=0");
  a.frame({ seq: 1, type: "run_started" });
  a.frame({ seq: 2, type: "step_started" });
  a.frame({ seq: 2, type: "step_started" });
  // Browser-level retry (CONNECTING) is left to EventSource itself.
  a.readyState = FakeES.CONNECTING;
  a.onerror?.();
  vi.advanceTimersByTime(5000);
  expect(FakeES.all).toHaveLength(1);
  // Fatal failure (CLOSED) → reopen from the last seq after 1 s.
  a.readyState = FakeES.CLOSED;
  a.onerror?.();
  vi.advanceTimersByTime(999);
  expect(FakeES.all).toHaveLength(1);
  vi.advanceTimersByTime(1);
  const b = FakeES.all[1] as FakeES;
  expect(b.url).toBe("/runs/r/events?after=2");
  b.frame({ seq: 1, type: "run_started" });
  b.frame({ seq: 3, type: "step_finished" });
  b.frame({ seq: 4, type: "run_finished" });
  expect(got).toEqual([1, 2, 3, 4]);
  expect(terminal).toBe(1);
  expect(b.readyState).toBe(FakeES.CLOSED);
  b.onerror?.();
  vi.advanceTimersByTime(5000);
  expect(FakeES.all).toHaveLength(2);
  close();
});
