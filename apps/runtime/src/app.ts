// createRuntimeApp (architecture.yaml#interfaces.runtime_handle): host routing → guards → system routes.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PlatformConnectorConfig } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import type postgres from "postgres";
import { createAuthDeps, type RuntimeAuthOptions } from "./auth/deps.js";
import type { InvalidationBus } from "./data/access.js";
import { createInvalidationBus } from "./data/events.js";
import { assertStartupAllowed, isLocalMode, type RuntimeEnv, readEnv } from "./env.js";
import type { OutboxMessage, RuntimeHonoEnv, RuntimeServices } from "./http/context.js";
import {
  errorResponse,
  misdirectedPage,
  notFoundPage,
  suspendedPage,
  unavailablePage,
} from "./http/errors.js";
import {
  csrfOk,
  hasForwardingHeaders,
  hostname,
  isAllowedLocalHost,
  isBareHost,
  isHookPath,
  parseSystemHost,
  securityHeaders,
} from "./http/guards.js";
import { type RunJobsOptions, type RunJobsReport, runJobs } from "./jobs/runner.js";
import { createConnectorHost, type SecretsFactory } from "./preview/connectors.js";
import { payRoutes, previewRoutes } from "./preview/routes.js";
import type { SystemEnv, SystemRegistry } from "./registry.js";
import { dataRoutes } from "./routes/data.js";
import { eventsRoutes } from "./routes/events.js";
import { fnRoutes } from "./routes/fn.js";
import { inviteRoutes } from "./routes/invite.js";
import { loginApiRoutes, privacyRoutes } from "./routes/login.js";
import { qrRoutes } from "./routes/qr.js";
import { staticRoutes } from "./routes/static.js";
import { notImplemented } from "./routes/stub.js";
import { platformTelegramHook, telegramApiRoutes, telegramHookRoutes } from "./routes/telegram.js";
import { authRoutes, wizardRoutes } from "./routes/wizard.js";
import { type LoadedSystem, type LoadSystemInput, SystemCache, SystemLoadError } from "./system.js";

export interface RuntimeAppOptions {
  /** Connection of the runtime (M0: any login; every transaction switches to `dbRole`). */
  db: postgres.Sql;
  registry: SystemRegistry;
  clock?: () => Date;
  connectors?: "outbox" | "live";
  /** Process configuration; default readEnv(process.env). */
  env?: Partial<RuntimeEnv>;
  /** Default .data/artifacts under the current directory. */
  artifactsRoot?: string;
  /** DB role for data access (default wizard_runtime; null — use the connecting role as is). */
  dbRole?: string | null;
  statementTimeout?: string;
  /** Connector secrets (M0 default: .env WIZARD_SECRET_<SYSTEMID>_<NAME>; local drafts get a dev QR key). */
  secrets?: SecretsFactory;
  /** JSON log sink (runtime.yaml#logging); default: none. */
  log?: (line: Record<string, unknown>) => void;
  /** Shared Telegram bot, platform SMTP, dev receiver (M1-06); default: from WIZARD_* env. */
  platform?: PlatformConnectorConfig;
  /** Also write test-mode connector effects to <outboxDir>/<system>/… (main: .data/outbox); default: memory only. */
  outboxDir?: string | null;
  /** End-user login (M1-05): OTP key, SMS provider, org lookup, Telegram OIDC base. */
  auth?: RuntimeAuthOptions;
}

export interface RuntimeApp {
  fetch(req: Request): Promise<Response>;
  /** Registers a system directly, bypassing the registry (previews, G1). Its schema must already exist. */
  loadSystem(input: LoadSystemInput): Promise<LoadedSystem>;
  /** Removes a system registered by loadSystem (after a G1 run); true when it was loaded. */
  unloadSystem(input: { slug: string; env: SystemEnv }): boolean;
  /** Messages connectors would have sent (connectors: 'outbox'). */
  outbox(): OutboxMessage[];
  /** One pass of the job runner (jobs/runner.ts) for a loaded system at `now` (G1 runWorkflows/advanceTime). */
  runJobs(input: { slug: string; env: SystemEnv } & RunJobsOptions): Promise<RunJobsReport>;
  readonly env: RuntimeEnv;
  readonly systems: SystemCache;
}

type Pre = { system: LoadedSystem; host: string; requestId: string };

function forbidden(requestId: string): Response {
  return errorResponse(new WizardError("FORBIDDEN"), requestId);
}

export function createRuntimeApp(o: RuntimeAppOptions): RuntimeApp {
  const env: RuntimeEnv = { ...readEnv(), ...o.env };
  assertStartupAllowed(env);
  const outbox: OutboxMessage[] = [];
  const services: RuntimeServices = {
    env,
    clock: o.clock ?? (() => new Date()),
    connectors: o.connectors ?? "outbox",
    outbox,
    log: o.log,
  };
  const buses = new Map<string, InvalidationBus>();
  const artifactsRoot = o.artifactsRoot ?? join(process.cwd(), ".data", "artifacts");
  const connectors = createConnectorHost({
    env,
    clock: services.clock,
    outbox,
    secrets: o.secrets,
    devSecretsDir: join(dirname(artifactsRoot), "secrets"),
    log: o.log,
    platform: o.platform,
    outboxDir: o.outboxDir ?? null,
  });
  services.connectorHost = connectors;
  const systems = new SystemCache({
    sql: o.db,
    registry: o.registry,
    artifactsRoot,
    qrToken: (entry, spec) => connectors.qrTokenIssuer(entry, spec),
    dbRole: o.dbRole,
    statementTimeout: o.statementTimeout,
    bus: (id, e) => {
      const k = `${id}:${e}`;
      let b = buses.get(k);
      if (!b) {
        b = createInvalidationBus();
        buses.set(k, b);
      }
      return b;
    },
  });
  const auth = createAuthDeps({
    sql: o.db,
    env,
    clock: services.clock,
    connectors,
    outbox,
    outboxDir: o.outboxDir ?? null,
    log: o.log,
    options: o.auth,
  });
  const pre = new WeakMap<Request, Pre>();
  const platformHook = platformTelegramHook({
    host: connectors,
    systems,
    sql: o.db,
    dbRole: o.dbRole === undefined ? "wizard_runtime" : o.dbRole,
    log: o.log,
  });

  const app = new Hono<RuntimeHonoEnv>();
  app.use("*", async (c, next) => {
    const p = pre.get(c.req.raw);
    if (!p) throw new WizardError("INTERNAL");
    c.set("requestId", p.requestId);
    c.set("services", services);
    c.set("host", p.host);
    c.set("system", p.system);
    await next();
  });
  app.onError((err, c) => {
    if (!(err instanceof WizardError)) {
      o.log?.({
        ts: new Date().toISOString(),
        level: "error",
        requestId: c.get("requestId"),
        msg: "unhandled",
        sqlstate: (err as { code?: unknown }).code ?? null,
      });
    }
    return errorResponse(err, c.get("requestId") ?? "");
  });
  app.route("/_wizard/qr", qrRoutes(connectors));
  app.route("/_wizard/hooks/telegram", telegramHookRoutes(connectors));
  app.route("/_wizard/hooks", notImplemented());
  app.route("/_wizard", previewRoutes(connectors));
  app.route("/_wizard", wizardRoutes());
  app.route("/_wizard", privacyRoutes());
  app.all("/_wizard/*", () => notFoundPage());
  app.route("/api/data", dataRoutes());
  app.route("/api/auth", loginApiRoutes(auth));
  app.route("/api/auth", authRoutes());
  app.route("/api/fn", fnRoutes());
  app.route("/api/events", eventsRoutes());
  app.route("/api/pay", payRoutes(connectors));
  app.route("/api/telegram", telegramApiRoutes(connectors));
  app.route("/api/admin", inviteRoutes(connectors));
  app.all("/api/*", () => {
    throw new WizardError("NOT_FOUND", { message: "Адрес не найден" });
  });
  app.route("/", staticRoutes());

  async function route(
    req: Request,
    requestId: string,
  ): Promise<{ res: Response; sys: LoadedSystem | null }> {
    const url = new URL(req.url);
    const host = req.headers.get("host");
    const name = host ? hostname(host) : null;
    if (!host || !name) return { res: misdirectedPage(), sys: null };
    if (isLocalMode(env)) {
      if (!isAllowedLocalHost(name)) return { res: misdirectedPage(), sys: null };
      if (hasForwardingHeaders(req.headers)) return { res: forbidden(requestId), sys: null };
    }
    if (isBareHost(name)) {
      if (url.pathname === "/_wizard/health") return { res: Response.json({ status: "ok" }), sys: null };
      const hook = await platformHook(req);
      if (hook) return { res: hook, sys: null };
      return { res: notFoundPage(), sys: null };
    }
    const target = parseSystemHost(name, env);
    if (target.kind === "foreign") return { res: misdirectedPage(), sys: null };
    if (target.kind === "unknown") return { res: notFoundPage(), sys: null };
    if (target.kind === "prod-redirect") {
      const port = host.slice(name.length);
      const location = `${env.publicScheme}://${target.slug}.${env.systemsDomain}${port}${url.pathname}${url.search}`;
      return { res: new Response(null, { status: 301, headers: { Location: location } }), sys: null };
    }
    let sys: LoadedSystem | null;
    try {
      sys = await systems.resolve(target.slug, target.env);
    } catch (e) {
      if (!(e instanceof SystemLoadError)) throw e;
      o.log?.({
        ts: new Date().toISOString(),
        level: "error",
        requestId,
        msg: "system_load_failed",
        system: target.slug,
        env: target.env,
      });
      return { res: unavailablePage(), sys: null };
    }
    if (!sys) return { res: notFoundPage(), sys: null };
    if (sys.entry.suspended && url.pathname !== "/_wizard/health") return { res: suspendedPage(), sys };
    if (!isHookPath(url.pathname) && !csrfOk(req, host, env)) return { res: forbidden(requestId), sys };
    pre.set(req, { system: sys, host, requestId });
    return { res: await app.fetch(req), sys };
  }

  async function fetch(req: Request): Promise<Response> {
    const requestId = randomUUID();
    const started = Date.now();
    let res: Response;
    let sys: LoadedSystem | null = null;
    try {
      ({ res, sys } = await route(req, requestId));
    } catch (e) {
      res = errorResponse(e, requestId);
    }
    res = new Response(res.body, res);
    const sysEnv: SystemEnv | null = sys?.entry.env ?? null;
    securityHeaders(res.headers, sysEnv, env);
    o.log?.({
      ts: new Date().toISOString(),
      level: res.status >= 500 ? "error" : "info",
      requestId,
      system: sys?.entry.slug ?? null,
      env: sysEnv,
      revision: sys?.entry.revision ?? null,
      // runtime.yaml#logging.rules: no query string; the hookToken segment is masked.
      route: new URL(req.url).pathname.replace(/^(\/_wizard\/hooks\/[^/]+\/[^/]+\/)[^/]+/, "$1***"),
      method: req.method,
      status: res.status,
      durationMs: Date.now() - started,
    });
    return res;
  }

  return {
    fetch,
    env,
    systems,
    loadSystem: async (input) => systems.pin(input),
    unloadSystem: (input) => systems.unpin(input.slug, input.env),
    outbox: () => [...outbox],
    runJobs: async ({ slug, env: sysEnv, ...opts }) => {
      const sys = await systems.resolve(slug, sysEnv);
      if (!sys) throw new WizardError("NOT_FOUND", { message: "Система не найдена" });
      return runJobs(sys, services, opts);
    },
  };
}
