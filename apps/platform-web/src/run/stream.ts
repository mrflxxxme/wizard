// SSE of a run (platform-screens.yaml#sse.client_rules): EventSource + Last-Event-ID, dedup by seq,
// closed after the terminal event; a failed connection is reopened with ?after=<last seq>.
import type { RunEvent } from "../api/types.js";
import { EVENT_TYPES, TERMINAL_EVENTS } from "./reducer.js";

export interface RunStreamOptions {
  url(after: number): string;
  after?: number;
  onEvent(e: RunEvent): void;
  onTerminal?(): void;
  reconnectMs?: number;
  EventSourceImpl?: typeof EventSource;
}

export function subscribeRun(o: RunStreamOptions): () => void {
  const ES = o.EventSourceImpl ?? EventSource;
  let lastSeq = o.after ?? 0;
  let es: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const close = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    es?.close();
    es = null;
  };

  const onFrame = (m: MessageEvent) => {
    let e: RunEvent;
    try {
      e = JSON.parse(String(m.data)) as RunEvent;
    } catch {
      return;
    }
    if (typeof e?.seq !== "number" || typeof e.type !== "string") return;
    if (e.seq <= lastSeq) return;
    lastSeq = e.seq;
    o.onEvent(e);
    if (TERMINAL_EVENTS.has(e.type)) {
      close();
      o.onTerminal?.();
    }
  };

  const open = () => {
    if (closed) return;
    const source = new ES(o.url(lastSeq));
    es = source;
    // Named frames (event: <type>) reach only listeners of that type; unnamed ones reach onmessage.
    for (const t of EVENT_TYPES) source.addEventListener(t, onFrame as EventListener);
    source.onmessage = onFrame;
    source.onerror = () => {
      if (closed || es !== source) return;
      // CONNECTING: the browser retries itself with Last-Event-ID. CLOSED: reopen from the last seq.
      if (source.readyState === ES.CLOSED) {
        es = null;
        timer = setTimeout(open, o.reconnectMs ?? 1000);
      }
    };
  };

  open();
  return close;
}
