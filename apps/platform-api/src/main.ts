// Dev entry (`pnpm dev`): PORT/HOST from scripts/dev.mjs (deploy.yaml#local.ports, #local.bind).
import { serve } from "@hono/node-server";
import { createPlatformApi } from "./app.js";
import { loadConfig } from "./config.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

const port = Number(process.env.PORT ?? 4000);
const host = process.env.HOST ?? "127.0.0.1";
const config = loadConfig();
if (
  (config.authMode === "dev" || config.unsafeLocalExec || process.env.WIZARD_DEV_LOGIN === "1") &&
  !LOOPBACK.has(host)
) {
  console.error(`[platform-api] ошибка: в режиме разработки слушать можно только 127.0.0.1 (HOST=${host})`);
  process.exit(1);
}

const api = await createPlatformApi();
const server = serve({ fetch: api.fetch, port, hostname: host }, (info) => {
  console.log(`[platform-api] http://${host}:${info.port}/api/v1`);
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await api.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
