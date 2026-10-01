// Entry point: `pnpm --filter @wizard/worker dev` (tsx), started by scripts/dev.mjs; no HTTP port.
// Configuration from env (platform/deploy.yaml#local.env_vars); the repo .env is loaded when present.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "@wizard/pii/log";
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
process.on("unhandledRejection", fatal("unhandled rejection"));

// platform-api migrates the platform schema; DBOS.launch migrates dbos.
const worker = await startWorker({ logger, migrate: false }).catch(fatal("start failed"));
if (!worker) process.exit(1);

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    // Running workflows stay pending in dbos.* and resume on the next start.
    void worker
      .close()
      .catch((e) => logger.error("close failed", e))
      .finally(() => process.exit(0));
  });
}
