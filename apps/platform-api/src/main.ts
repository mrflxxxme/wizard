// Dev entry (`pnpm dev`): PORT/HOST from scripts/dev.mjs (deploy.yaml#local.ports, #local.bind).
// M1: runs are enqueued as DBOS workflows; apps/worker executes them (workflows.yaml#execution.M1).
import { serve } from "@hono/node-server";
import { createLogger } from "@wizard/pii/log";
import { metricsListenFromEnv } from "@wizard/pii/metrics";
import { createPlatformApi } from "./app.js";
import { assertStartupAllowed, loadConfig } from "./config.js";
import { startMetricsServer } from "./ops/metrics.js";

const logger = createLogger({ svc: "platform-api" });
// Uncaught errors go through the allowlist too (a raw PG error carries values in detail, L3-08).
for (const ev of ["uncaughtException", "unhandledRejection"] as const)
  process.on(ev, (e: unknown) => {
    logger.error(ev, e);
    process.exit(1);
  });
const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";
try {
  assertStartupAllowed(loadConfig(), host);
} catch (e) {
  console.error(`[platform-api] ошибка: ${(e as Error).message}`);
  process.exit(1);
}

const api = await createPlatformApi({ engine: "dbos", log: (m, e) => logger.error(m, e) });
const server = serve({ fetch: api.fetch, port, hostname: host }, (info) => {
  logger.info("listening", { url: `http://${host}:${info.port}/api/v1`, port: info.port });
});

// M2-09: Prometheus /metrics on a dedicated port (WIZARD_METRICS_PORT; helm opens it to the observability namespace).
const metricsAt = metricsListenFromEnv(process.env);
const metrics = metricsAt
  ? await startMetricsServer({
      ...metricsAt,
      db: api.deps.db,
      capRub: api.deps.config.llmMonthlyCapRub,
    })
  : null;
if (metrics) logger.info("listening_metrics", { port: metrics.port });

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await metrics?.close();
  await api.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
