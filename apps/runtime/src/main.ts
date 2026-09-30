// Entry point: `pnpm --filter @wizard/runtime dev` (tsx), started by scripts/dev.mjs with PORT/HOST.
// Configuration from env (platform/deploy.yaml#local.env_vars); the repo .env is loaded when present.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { DbRegistry, FileRegistry } from "./registry.js";
import { startRuntime } from "./server.js";

const root = resolve(process.env.WIZARD_ROOT ?? join(import.meta.dirname, "..", "..", ".."));
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
const artifactsRoot = join(root, ".data", "artifacts");
const db = postgres(process.env.WIZARD_DB_URL ?? "postgres://wizard@localhost:5433/wizard", {
  onnotice: () => {},
});

const port = Number(process.env.PORT ?? process.env.WIZARD_RUNTIME_PORT ?? 4100);
const hostname = process.env.HOST ?? process.env.WIZARD_RUNTIME_HOST ?? "127.0.0.1";
const { close } = await startRuntime({
  db,
  // Drafts built by platform-api come from platform.deployments; registry.json still serves hand-placed artifacts.
  registry: new DbRegistry(db, new FileRegistry(join(artifactsRoot, "registry.json"))),
  artifactsRoot,
  port,
  hostname,
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});
process.stdout.write(
  `${JSON.stringify({ level: "info", msg: "listening", url: `http://${hostname}:${port}` })}\n`,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void close()
      .finally(() => db.end())
      .finally(() => process.exit(0));
  });
}
