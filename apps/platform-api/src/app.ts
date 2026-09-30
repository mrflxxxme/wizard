import type { Router, RouterOptions } from "@wizard/llm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type Config, loadConfig } from "./config.js";
import { createDb, type DbHandle, migrate } from "./db/index.js";
import { ApiError } from "./errors.js";
import { type AppEnv, devAuth } from "./http/auth.js";
import { hostGuard } from "./http/guard.js";
import { IdempotencyCache, idempotency } from "./http/idempotency.js";
import type { Deps } from "./http/util.js";
import { orgRoutes } from "./routes/orgs.js";
import { runRoutes } from "./routes/runs.js";
import { systemRoutes } from "./routes/systems.js";
import { EventBus } from "./runs/events.js";
import { RunEngine } from "./runs/queue.js";
import { stubExecutors } from "./runs/stub.js";
import type { RunExecutors } from "./runs/types.js";
import { BlobStore } from "./storage/blobs.js";

export interface PlatformApiOptions {
  config?: Partial<Config>;
  /** Existing connection; otherwise created from config.dbUrl and closed by close(). */
  db?: DbHandle;
  executors?: RunExecutors;
  createRouter?: (opts: RouterOptions) => Router;
  /** Run migrations + seed (default true). */
  migrate?: boolean;
  /** Fail runs left non-terminal by a previous process (default true). */
  recover?: boolean;
  pingMs?: number;
  log?: (msg: string, err?: unknown) => void;
}

export interface PlatformApi {
  app: Hono;
  fetch: (req: Request) => Response | Promise<Response>;
  engine: RunEngine;
  deps: Deps;
  close(): Promise<void>;
}

export async function createPlatformApi(opts: PlatformApiOptions = {}): Promise<PlatformApi> {
  const config = loadConfig(process.env, opts.config);
  const handle = opts.db ?? createDb(config.dbUrl);
  if (opts.migrate !== false) await migrate(handle.db);
  const bus = new EventBus();
  const blobs = new BlobStore(config.artifactsDir);
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(`[platform-api] ${m}`, e ?? ""));
  const engine = new RunEngine({
    db: handle.db,
    pg: handle.pg,
    bus,
    blobs,
    config,
    executors: opts.executors ?? stubExecutors,
    ...(opts.createRouter ? { createRouter: opts.createRouter } : {}),
    log,
  });
  if (opts.recover !== false) await engine.recover();
  const deps: Deps = { db: handle.db, pg: handle.pg, bus, blobs, engine, config };

  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.body(), err.status as 400);
    if (err instanceof HTTPException && err.status < 500)
      return c.json({ code: "VALIDATION_FAILED", message_ru: "Некорректный запрос" }, 400);
    log(`${c.req.method} ${c.req.path}`, err);
    return c.json({ code: "INTERNAL", message_ru: "Внутренняя ошибка сервера" }, 500);
  });
  app.notFound((c) => c.json({ code: "NOT_FOUND", message_ru: "Не найдено" }, 404));
  app.use(
    "*",
    hostGuard({
      enabled: config.authMode === "dev" || config.unsafeLocalExec,
      platformOrigin: config.platformOrigin,
    }),
  );

  const api = new Hono<AppEnv>();
  api.use("*", devAuth(handle.db));
  api.use("*", idempotency(new IdempotencyCache()));
  api.route("/", systemRoutes(deps));
  api.route("/", orgRoutes(deps));
  api.route("/", runRoutes(deps, opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}));
  app.route("/api/v1", api);

  return {
    app,
    fetch: (req) => app.fetch(req),
    engine,
    deps,
    async close() {
      await engine.close();
      if (!opts.db) await handle.close();
    },
  };
}
