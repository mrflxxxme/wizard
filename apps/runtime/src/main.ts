// Entry point: `pnpm --filter @wizard/runtime dev` (tsx). Configuration from env (platform/deploy.yaml#local.env_vars).
import { join } from "node:path";
import postgres from "postgres";
import { FileRegistry } from "./registry.js";
import { startRuntime } from "./server.js";

const root = process.env.WIZARD_ROOT ?? process.cwd();
const artifactsRoot = join(root, ".data", "artifacts");
const db = postgres(process.env.WIZARD_DB_URL ?? "postgres://wizard@localhost:5433/wizard", {
  onnotice: () => {},
});

const { close } = await startRuntime({
  db,
  registry: new FileRegistry(join(artifactsRoot, "registry.json")),
  artifactsRoot,
  port: Number(process.env.WIZARD_RUNTIME_PORT ?? 4100),
  hostname: process.env.WIZARD_RUNTIME_HOST ?? "127.0.0.1",
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void close().finally(() => db.end());
  });
}
