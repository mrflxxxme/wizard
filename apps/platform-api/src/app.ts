import type { Router, RouterOptions } from "@wizard/llm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createAgentExecutors } from "./agents/executors.js";
import { type Mailer, OutboxMailer } from "./auth/mailer.js";
import type { GeoRegion } from "./auth/region.js";
import { Billing } from "./billing/ledger.js";
import { assertStartupAllowed, type Config, loadConfig, StartupError } from "./config.js";
import { createDb, type DbHandle, migrate } from "./db/index.js";
import { ApiError } from "./errors.js";
import { type AppEnv, authenticate, originGuard } from "./http/auth.js";
import { hostGuard } from "./http/guard.js";
import { IdempotencyCache, idempotency } from "./http/idempotency.js";
import type { Deps } from "./http/util.js";
import { authRoutes } from "./routes/auth.js";
import { creditRoutes } from "./routes/credits.js";
import { lockRoutes } from "./routes/lock.js";
import { orgRoutes } from "./routes/orgs.js";
import { runRoutes } from "./routes/runs.js";
import { systemRoutes } from "./routes/systems.js";
import { EventBus } from "./runs/events.js";
import { RunEngine } from "./runs/queue.js";
import type { RunExecutors } from "./runs/types.js";
import { BlobStore } from "./storage/blobs.js";

export interface PlatformApiOptions {
  config?: Partial<Config>;
  /** Existing connection; otherwise created from config.dbUrl and closed by close(). */
  db?: DbHandle;
  /** Run executors, or a factory over the API's connection/config; default: the real agents (createAgentExecutors). */
  executors?: RunExecutors | ((d: { pg: DbHandle["pg"]; config: Config }) => RunExecutors);
  createRouter?: (opts: RouterOptions) => Router;
  /** Run migrations + seed (default true). */
  migrate?: boolean;
  /** Fail runs left non-terminal by a previous process (default true). */
  recover?: boolean;
  pingMs?: number;
  log?: (msg: string, err?: unknown) => void;
  /** Platform mail (OTP, invites); default: files in config.outboxDir (production requires a real mailer). */
  mailer?: Mailer;
  /** Offline GeoIP of logins for the T1 region restriction (data-boundary.yaml#region_restriction.sources). */
  geoRegion?: GeoRegion;
  /** Clock of the credits ledger (grants, expiry); tests move it forward. */
  now?: () => Date;
  /** credits_cron period (billing.yaml#credits_cron, hourly); 0 disables the in-process timer. */
  creditsCronMs?: number;
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
  assertStartupAllowed(config);
  if (!opts.mailer && config.nodeEnv === "production")
    throw new StartupError("почтовый провайдер платформы не подключён (NODE_ENV=production)");
  const mailer = opts.mailer ?? new OutboxMailer(config.outboxDir);
  const handle = opts.db ?? createDb(config.dbUrl);
  if (opts.migrate !== false) await migrate(handle.db);
  const bus = new EventBus();
  const blobs = new BlobStore(config.artifactsDir);
  const log = opts.log ?? ((m: string, e?: unknown) => console.error(`[platform-api] ${m}`, e ?? ""));
  const billing = new Billing({
    exemptOrgs: config.billingExemptOrgs,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const executors =
    typeof opts.executors === "function"
      ? opts.executors({ pg: handle.pg, config })
      : (opts.executors ?? createAgentExecutors({ pg: handle.pg, config }));
  const engine = new RunEngine({
    db: handle.db,
    pg: handle.pg,
    bus,
    blobs,
    config,
    executors,
    billing,
    ...(opts.createRouter ? { createRouter: opts.createRouter } : {}),
    log,
  });
  if (opts.recover !== false) await engine.recover();
  const deps: Deps = { db: handle.db, pg: handle.pg, bus, blobs, engine, config, billing };
  const cronMs = opts.creditsCronMs ?? 3600_000;
  const cron =
    cronMs > 0
      ? setInterval(() => {
          billing.sweep(handle.db).catch((e) => log("credits_cron failed", e));
        }, cronMs)
      : undefined;
  cron?.unref();

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
      enabled: config.authMode === "dev" || config.unsafeLocalExec || config.devLogin,
      platformOrigin: config.platformOrigin,
    }),
  );
  app.use("*", originGuard(config));

  const accounts = { mailer, geoRegion: opts.geoRegion };
  const api = new Hono<AppEnv>();
  api.use("*", authenticate({ db: handle.db, config }));
  api.use("*", idempotency(new IdempotencyCache()));
  api.route("/", authRoutes(deps, accounts));
  api.route("/", systemRoutes(deps));
  api.route("/", lockRoutes(deps));
  api.route("/", orgRoutes(deps, accounts));
  api.route("/", creditRoutes(deps));
  api.route("/", runRoutes(deps, opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}));
  app.route("/api/v1", api);

  return {
    app,
    fetch: (req) => app.fetch(req),
    engine,
    deps,
    async close() {
      if (cron) clearInterval(cron);
      await engine.close();
      await executors.close?.();
      if (!opts.db) await handle.close();
    },
  };
}
