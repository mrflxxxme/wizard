// Runtime metrics (M2-09; deploy.yaml#pilot.observability): requests of the public port by status class and latency,
// retention passes of prod systems (runtime.yaml#workflows.retention; the platform's retention_overdue watchdog reads
// the journal, these counters show the passes themselves). Served on WIZARD_METRICS_PORT next to the public and
// internal ports. No system slug or path in labels: series stay bounded and carry no tenant data.
import { Registry } from "@wizard/pii/metrics";

export const runtimeMetrics = new Registry();

export const httpRequests = runtimeMetrics.counter(
  "wizard_runtime_http_requests_total",
  "Requests of the public runtime port by status class (2xx, 3xx, 4xx, 5xx)",
  ["class"],
);
export const httpDuration = runtimeMetrics.histogram(
  "wizard_runtime_http_request_duration_seconds",
  "Latency of the public runtime port, seconds",
  [],
  [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
);
export const retentionSystems = runtimeMetrics.counter(
  "wizard_runtime_retention_passes_total",
  "Retention passes of systems by result (ran, failed)",
  ["result"],
);
export const retentionTicks = runtimeMetrics.counter(
  "wizard_runtime_retention_ticks_total",
  "Retention checks of the runtime by result (ok, failed)",
  ["result"],
);

/** Wraps a fetch handler: status class and latency of every response (errors count as 5xx). */
export function instrumentFetch<A extends unknown[]>(
  fetch: (req: Request, ...rest: A) => Response | Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    const t0 = performance.now();
    try {
      const res = await fetch(req, ...rest);
      httpRequests.inc({ class: `${Math.floor(res.status / 100)}xx` });
      return res;
    } catch (e) {
      httpRequests.inc({ class: "5xx" });
      throw e;
    } finally {
      httpDuration.observe(undefined, (performance.now() - t0) / 1000);
    }
  };
}

/** V3-18: promise rejections nobody handled; logged and counted, the process keeps serving (main.ts). */
export const unhandledRejections = runtimeMetrics.counter(
  "wizard_runtime_unhandled_rejections_total",
  "Promise rejections of the runtime process that nothing handled (logged; the process keeps running)",
);
