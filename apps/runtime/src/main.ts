// Entry point: `pnpm --filter @wizard/runtime dev` (tsx), started by scripts/dev.mjs with PORT/HOST.
// Configuration from env (platform/deploy.yaml#local.env_vars); the repo .env is loaded when present.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { mailApiFromEnv } from "@wizard/connectors";
import { createLogger } from "@wizard/pii/log";
import { metricsListenFromEnv } from "@wizard/pii/metrics";
import postgres from "postgres";
import { unhandledRejections } from "./metrics.js";
import { DbRegistry, FileRegistry } from "./registry.js";
import { sandboxFromEnv, sandboxIdleFromEnv } from "./sandbox/from-env.js";
import { dbSystemUuid, storeSecrets } from "./secrets-store.js";
import { startRuntime } from "./server.js";

const root = resolve(process.env.WIZARD_ROOT ?? join(import.meta.dirname, "..", "..", ".."));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const artifactsRoot = join(root, ".data", "artifacts");
const db = postgres(process.env.WIZARD_DB_URL ?? "postgres://wizard@localhost:5433/wizard", {
  onnotice: () => {},
});

// deploy.yaml#cloud.observability.pii_in_logs (L3-08): every line passes the allowlist.
const logger = createLogger({ svc: "runtime" });
// An uncaught exception leaves the process in an unknown state: it exits (and is restarted). A rejected promise nobody
// handled does not (V3-18): this single replica (Recreate) would drop every request in flight and, on start, reconcile
// deletes all sandbox pods — one forgotten .catch would take every system's functions down. Logged and counted.
process.on("uncaughtException", (e: unknown) => {
  logger.error("uncaughtException", e);
  process.exit(1);
});
process.on("unhandledRejection", (e: unknown) => {
  unhandledRejections.inc();
  logger.error("unhandledRejection", e);
});
const port = Number(process.env.PORT ?? process.env.WIZARD_RUNTIME_PORT ?? 4100);
const hostname = process.env.HOST ?? process.env.WIZARD_RUNTIME_HOST ?? "127.0.0.1";
// runtime.yaml#routing.rules (L3-19): internal port 4101 next to the public 4100; "off" disables it.
const internalEnv = process.env.WIZARD_RUNTIME_INTERNAL_PORT;
const internalPort = internalEnv === "off" ? null : Number(internalEnv ?? port + 1);
// M2-09: Prometheus /metrics on WIZARD_METRICS_PORT (off by default locally).
const metricsAt = metricsListenFromEnv(process.env);
// M2-18: WIZARD_SANDBOX=k8s — functions run in workerd pods under gVisor, placed by this process; the pods reach
// ctx.* through the RPC listener on the internal port. Pods of a previous process are removed first.
const sandbox = sandboxFromEnv(process.env, { log: (line) => logger.line({ svc: "runtime", ...line }) });
if (sandbox) {
  if (internalPort === null) throw new Error("WIZARD_SANDBOX=k8s needs the internal port (sandbox RPC)");
  // Not fatal: published systems without functions keep working; calls report FUNCTIONS_DISABLED and the log says why.
  await sandbox.orchestrator.reconcile().catch((e: unknown) => logger.error("sandbox_reconcile_failed", e));
  sandbox.orchestrator.startWatchdog();
  // V3-18: slots of systems without calls come back (unpublished/deleted ones are freed when the cache drops them).
  sandbox.orchestrator.startIdleCollector(sandboxIdleFromEnv(process.env));
}
// Platform mail over the Unisender Go HTTP API (email.yaml#transport): its host replaces the SMTP host in the policy.
const mailApi = mailApiFromEnv(process.env);
const { close, metricsPort } = await startRuntime({
  db,
  // Drafts built by platform-api come from platform.deployments; registry.json still serves hand-placed artifacts.
  registry: new DbRegistry(db, new FileRegistry(join(artifactsRoot, "registry.json"))),
  artifactsRoot,
  // Test-mode mail and Telegram messages land in .data/outbox/<system>/ (connectors/*.yaml#test_mode.draft).
  outboxDir: join(root, ".data", "outbox"),
  connectors: process.env.WIZARD_CONNECTORS === "live" ? "live" : "outbox",
  // V3-23: the key window's keys (platform-api's encrypted secret file on the shared data volume, WIZARD_SECRETS_KEY)
  // reach the system's connectors; without the key the M0 env variables (and the local drafts' dev QR key) stay.
  ...(process.env.WIZARD_SECRETS_KEY
    ? {
        secrets: storeSecrets({
          file: process.env.WIZARD_SECRETS_FILE ?? join(root, ".data", "secrets.enc"),
          keyMaterial: process.env.WIZARD_SECRETS_KEY,
          systemUuid: dbSystemUuid(db),
        }),
      }
    : {}),
  port,
  hostname,
  internalPort,
  ...(process.env.WIZARD_RUNTIME_INTERNAL_HOST
    ? { internalHostname: process.env.WIZARD_RUNTIME_INTERNAL_HOST }
    : {}),
  ...(process.env.WIZARD_VERSION ? { version: process.env.WIZARD_VERSION } : {}),
  egress: {
    globalAllow: (process.env.WIZARD_EGRESS_ALLOW ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    ...(process.env.WIZARD_SMTP_HOST ? { platformSmtpHost: process.env.WIZARD_SMTP_HOST } : {}),
    ...(mailApi ? { platformMailApiHost: new URL(mailApi.base).hostname } : {}),
  },
  log: (line) => logger.line(line),
  // M2-50: workflow poller over published systems (0 — off; tests and G1 drive runJobs themselves).
  ...(process.env.WIZARD_JOBS_TICK_MS ? { jobsTickMs: Number(process.env.WIZARD_JOBS_TICK_MS) } : {}),
  ...(sandbox ? { sandbox: sandbox.orchestrator, rpc: sandbox.rpc } : {}),
  ...(metricsAt ? { metricsPort: metricsAt.port, metricsHostname: metricsAt.hostname } : {}),
});
logger.info("listening", { url: `http://${hostname}:${port}`, port });
if (internalPort !== null) logger.info("listening_internal", { port: internalPort });
if (metricsPort !== null) logger.info("listening_metrics", { port: metricsPort });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void close()
      .finally(() => sandbox?.orchestrator.close())
      .finally(() => db.end())
      .finally(() => process.exit(0));
  });
}
