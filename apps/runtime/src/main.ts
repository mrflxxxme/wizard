// Entry point: `pnpm --filter @wizard/runtime dev` (tsx), started by scripts/dev.mjs with PORT/HOST.
// Configuration from env (platform/deploy.yaml#local.env_vars); the repo .env is loaded when present.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "@wizard/pii/log";
import postgres from "postgres";
import { DbRegistry, FileRegistry } from "./registry.js";
import { startRuntime } from "./server.js";

const root = resolve(process.env.WIZARD_ROOT ?? join(import.meta.dirname, "..", "..", ".."));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const artifactsRoot = join(root, ".data", "artifacts");
const db = postgres(process.env.WIZARD_DB_URL ?? "postgres://wizard@localhost:5433/wizard", {
  onnotice: () => {},
});

// deploy.yaml#cloud.observability.pii_in_logs (L3-08): every line passes the allowlist.
const logger = createLogger({ svc: "runtime" });
for (const ev of ["uncaughtException", "unhandledRejection"] as const)
  process.on(ev, (e: unknown) => {
    logger.error(ev, e);
    process.exit(1);
  });
const port = Number(process.env.PORT ?? process.env.WIZARD_RUNTIME_PORT ?? 4100);
const hostname = process.env.HOST ?? process.env.WIZARD_RUNTIME_HOST ?? "127.0.0.1";
// runtime.yaml#routing.rules (L3-19): internal port 4101 next to the public 4100; "off" disables it.
const internalEnv = process.env.WIZARD_RUNTIME_INTERNAL_PORT;
const internalPort = internalEnv === "off" ? null : Number(internalEnv ?? port + 1);
const { close } = await startRuntime({
  db,
  // Drafts built by platform-api come from platform.deployments; registry.json still serves hand-placed artifacts.
  registry: new DbRegistry(db, new FileRegistry(join(artifactsRoot, "registry.json"))),
  artifactsRoot,
  // Test-mode mail and Telegram messages land in .data/outbox/<system>/ (connectors/*.yaml#test_mode.draft).
  outboxDir: join(root, ".data", "outbox"),
  connectors: process.env.WIZARD_CONNECTORS === "live" ? "live" : "outbox",
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
  },
  log: (line) => logger.line(line),
});
logger.info("listening", { url: `http://${hostname}:${port}`, port });
if (internalPort !== null) logger.info("listening_internal", { port: internalPort });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void close()
      .finally(() => db.end())
      .finally(() => process.exit(0));
  });
}
