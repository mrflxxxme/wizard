// In-process invalidation bus (runtime.yaml#realtime.rules: M0 — EventEmitter in the runtime process).
import type { InvalidationBus, InvalidationEvent } from "./access.js";

export function createInvalidationBus(): InvalidationBus {
  const listeners = new Set<(e: InvalidationEvent) => void>();
  return {
    publish(events) {
      for (const e of events) {
        for (const l of listeners) {
          try {
            l(e);
          } catch {
            // A failing subscriber must not break the writer or other subscribers.
          }
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
