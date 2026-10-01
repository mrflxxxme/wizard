// Prometheus registry of this process (platform-api or worker; M2-09) and the founder-alert counter. Kept apart from
// metrics.ts so ops/alert.ts can count alerts without importing the DB gauges (metrics.ts → billing/llm-cap.ts).
import { Registry } from "@wizard/pii/metrics";

/** Registry of this process (platform-api or worker). */
export const platformMetrics = new Registry();

export const opsAlertsSent = platformMetrics.counter(
  "wizard_ops_alerts_total",
  "Founder alerts claimed (one per key), by event",
  ["event"],
);
