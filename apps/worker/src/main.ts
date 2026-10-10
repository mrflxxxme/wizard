// Entry point: `pnpm --filter @wizard/worker dev` (tsx), started by scripts/dev.mjs; no HTTP port except the optional
// Prometheus /metrics listener (WIZARD_METRICS_PORT, M2-09).
// Configuration from env (platform/deploy.yaml#local.env_vars); the repo .env is loaded when present.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "@wizard/pii/log";
import { metricsListenFromEnv } from "@wizard/pii/metrics";
import { platformMetrics, startMetricsServer } from "@wizard/platform-api";
import { startWorker } from "./worker.js";

const root = resolve(join(import.meta.dirname, "..", "..", ".."));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const logger = createLogger({ svc: "worker" });
// Uncaught errors go through the allowlist too (a raw PG error carries values in detail, L3-08).
const fatal = (msg: string) => (e: unknown) => {
  logger.error(msg, e);
  process.exit(1);
};
process.on("uncaughtException", fatal("uncaught"));
// V3-18: a rejected promise nobody handled is logged and counted, not fatal — exiting would kill every build in flight
// (they resume from dbos.* only after a restart and lose their sandbox pods to the next reconcile).
const unhandled = platformMetrics.counter(
  "wizard_worker_unhandled_rejections_total",
  "Promise rejections of the worker process that nothing handled (logged; the process keeps running)",
);
process.on("unhandledRejection", (e: unknown) => {
  unhandled.inc();
  logger.error("unhandled rejection", e);
});

// platform-api migrates the platform schema; DBOS.launch migrates dbos.
const worker = await startWorker({ logger, migrate: false }).catch(fatal("start failed"));
if (!worker) process.exit(1);
// Process counters only (runs, gates, retention); the database gauges come from platform-api.
const metricsAt = metricsListenFromEnv(process.env);
const metrics = metricsAt
  ? await startMetricsServer(metricsAt).catch(fatal("metrics listener failed"))
  : null;
if (metrics) logger.info("listening_metrics", { port: metrics.port });

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    // Running workflows stay pending in dbos.* and resume on the next start.
    void Promise.resolve(metrics?.close())
      .then(() => worker.close())
      .catch((e) => logger.error("close failed", e))
      .finally(() => process.exit(0));
  });
}
