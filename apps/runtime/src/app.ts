// createRuntimeApp (architecture.yaml#interfaces.runtime_handle): host routing → guards → system routes.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PlatformConnectorConfig } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import type postgres from "postgres";
import { type AiGatewayClient, httpAiGateway } from "./ai/gateway.js";
import { clientIpOf } from "./auth/client-ip.js";
import { createAuthDeps, type RuntimeAuthOptions } from "./auth/deps.js";
import { readSessionToken, sessionUser } from "./auth/session.js";
import type { InvalidationBus } from "./data/access.js";
import { createInvalidationBus } from "./data/events.js";
import { assertStartupAllowed, draftPreviewOnly, isLocalMode, type RuntimeEnv, readEnv } from "./env.js";
import { createFileStorage, type FileStorage } from "./files/storage.js";
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
import { createInternalHandler, type InternalOptions } from "./internal.js";
import {
  type RetentionPassReport,
  type RunJobsOptions,
  type RunJobsReport,
  retentionDue,
  runJobs,
  runRetention,
} from "./jobs/runner.js";
import { createConnectorHost, type SecretsFactory } from "./preview/connectors.js";
import { previewRoutes } from "./preview/routes.js";
import { MAX_WITHDRAWAL_DAYS } from "./privacy/erasure.js";
import { defaultLegalTemplates, type LegalTemplates } from "./privacy/templates.js";
import type { SystemEnv, SystemRegistry } from "./registry.js";
import { aiRoutes } from "./routes/ai.js";
import { dataRoutes } from "./routes/data.js";
import { eventsRoutes } from "./routes/events.js";
import { filesRoutes } from "./routes/files.js";
import { fnRoutes } from "./routes/fn.js";
import { fontsRoutes } from "./routes/fonts.js";
import { inviteRoutes } from "./routes/invite.js";
import { loginApiRoutes } from "./routes/login.js";
import { payRoutes } from "./routes/pay.js";
import { pdRequestsApiRoutes, privacyRoutes } from "./routes/privacy.js";
import { qrRoutes } from "./routes/qr.js";
import { staticRoutes } from "./routes/static.js";
import { notImplemented } from "./routes/stub.js";
import { platformTelegramHook, telegramApiRoutes, telegramHookRoutes } from "./routes/telegram.js";
import { authRoutes, wizardRoutes } from "./routes/wizard.js";
import { yookassaHookRoutes } from "./routes/yookassa.js";
import type { SandboxRpc } from "./sandbox/rpc.js";
import type { SandboxExecutors } from "./sandbox/workerd-executor.js";
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
  /** 152-ФЗ package: withdrawal → anonymization delay (days, 0…30; default 0 — at once) and legal templates. */
  privacy?: { withdrawalDays?: number; legalTemplates?: LegalTemplates };
  /** M2: function calls go to sandbox pods (createWorkerdSandbox); WIZARD_UNSAFE_LOCAL_EXEC is then not needed. */
  sandbox?: SandboxExecutors;
  /**
   * Storage of file fields (runtime.yaml#files, M2-14). Default: createFileStorage(process.env) — WIZARD_FILES_STORAGE
   * (fs in <artifactsRoot>/../files, memory or s3); null — no files (uploads 404, file values unchecked).
   */
  files?: FileStorage | null;
  /** Sandbox RPC listener served on the internal port (/rpc/*) and egress-proxy authorization (L3-23, L3-24). */
  rpc?: SandboxRpc;
  /** Version reported by the internal health (image tag, WIZARD_VERSION). */
  version?: string;
  /** Egress allowlist inputs of the internal egress-authorize endpoint. */
  egress?: InternalOptions["egress"];
  /**
   * M3-02: AI gateway of the platform (runtime.yaml#ai_actions.call). Default: HTTP to WIZARD_PLATFORM_INTERNAL_URL with
   * WIZARD_INTERNAL_TOKEN when both are set; null — AI actions answer 503 AI_UNAVAILABLE.
   */
  ai?: AiGatewayClient | null;
}

export interface RuntimeApp {
  fetch(req: Request): Promise<Response>;
  /** Handler of the internal port (health with details, /_wizard/internal/*, /rpc/*; runtime.yaml#routing, L3-19). */
  internalFetch(req: Request): Promise<Response>;
  /** Registers a system directly, bypassing the registry (previews, G1). Its schema must already exist. */
  loadSystem(input: LoadSystemInput): Promise<LoadedSystem>;
  /** Removes a system registered by loadSystem (after a G1 run); true when it was loaded. */
  unloadSystem(input: { slug: string; env: SystemEnv }): boolean;
  /** Messages connectors would have sent (connectors: 'outbox'). */
  outbox(): OutboxMessage[];
  /** One pass of the job runner (jobs/runner.ts) for a loaded system at `now` (G1 runWorkflows/advanceTime). */
  runJobs(input: { slug: string; env: SystemEnv } & RunJobsOptions): Promise<RunJobsReport>;
  /**
   * Daily retention (runtime.yaml#workflows.retention, 03:00 MSK): one pass for every registry deployment whose pass
   * is due (no marker since today's slot, or a platform request); the server calls it on a timer.
   */
  retentionTick(input?: { now?: Date }): Promise<RetentionTickReport>;
  readonly env: RuntimeEnv;
  readonly systems: SystemCache;
}

export interface RetentionTickReport {
  /** Systems whose pass ran, with its report. */
  ran: ({ slug: string; env: SystemEnv } & RetentionPassReport)[];
  /** Systems that could not be loaded or checked (logged as retention_failed). */
  failed: { slug: string; env: SystemEnv }[];
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
    privacy: {
      withdrawalDays: Math.min(MAX_WITHDRAWAL_DAYS, Math.max(0, Math.floor(o.privacy?.withdrawalDays ?? 0))),
    },
    legalTemplates: o.privacy?.legalTemplates ?? defaultLegalTemplates(),
    ...(o.sandbox ? { sandbox: o.sandbox } : {}),
    ai:
      o.ai !== undefined
        ? o.ai
        : env.platformInternalUrl && env.internalToken
          ? httpAiGateway({ url: env.platformInternalUrl, token: env.internalToken })
          : null,
  };
  const buses = new Map<string, InvalidationBus>();
  const artifactsRoot = o.artifactsRoot ?? join(process.cwd(), ".data", "artifacts");
  const files =
    o.files === undefined
      ? createFileStorage(process.env, { defaultDir: join(dirname(artifactsRoot), "files") })
      : o.files;
  const connectors = createConnectorHost({
    env,
    clock: services.clock,
    outbox,
    secrets: o.secrets,
    devSecretsDir: join(dirname(artifactsRoot), "secrets"),
    log: o.log,
    platform: o.platform,
    outboxDir: o.outboxDir ?? null,
    connectors: services.connectors,
  });
  services.connectorHost = connectors;
  const systems = new SystemCache({
    sql: o.db,
    registry: o.registry,
    artifactsRoot,
    qrToken: (entry, spec) => connectors.qrTokenIssuer(entry, spec),
    dbRole: o.dbRole,
    statementTimeout: o.statementTimeout,
    legalTemplates: services.legalTemplates,
    ...(files ? { files } : {}),
    ...(o.log ? { log: o.log } : {}),
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
  services.ipHmac = (req) => auth.keys.ip(clientIpOf(req));
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
  app.route("/_wizard/hooks/yookassa", yookassaHookRoutes(connectors));
  app.route("/_wizard/hooks", notImplemented());
  app.route("/_wizard/fonts", fontsRoutes());
  app.route("/_wizard", previewRoutes(connectors));
  app.route("/_wizard", wizardRoutes());
  app.route("/_wizard", privacyRoutes());
  app.all("/_wizard/*", () => notFoundPage());
  app.route("/api/data", dataRoutes());
  app.route("/api/auth", loginApiRoutes(auth));
  app.route("/api/auth", authRoutes());
  app.route("/api/fn", fnRoutes());
  app.route("/api/ai", aiRoutes());
  app.route("/api/events", eventsRoutes());
  app.route("/api/files", filesRoutes(auth.keys));
  app.route("/api/pay", payRoutes(connectors));
  app.route("/api/telegram", telegramApiRoutes(connectors));
  app.route("/api/admin/pd-requests", pdRequestsApiRoutes());
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
    if (sys.entry.env === "draft" && draftPreviewOnly(env) && !(await draftAdmitted(sys, req, url.pathname)))
      return { res: notFoundPage(), sys };
    if (!isHookPath(url.pathname) && !csrfOk(req, host, env)) return { res: forbidden(requestId), sys };
    pre.set(req, { system: sys, host, requestId });
    return { res: await app.fetch(req), sys };
  }

  /**
   * Cloud drafts are closed (abuse.yaml#identification.draft): only preview-login, health and connector hooks pass
   * without a live session that preview-login created; everything else is 404 (api.yaml#getPreviewUrl).
   */
  async function draftAdmitted(sys: LoadedSystem, req: Request, path: string): Promise<boolean> {
    if (path === "/_wizard/preview-login" || path === "/_wizard/health" || isHookPath(path)) return true;
    const t = readSessionToken(req.headers.get("cookie"), env, { draft: true });
    if (t.kind !== "token") return false;
    const user = await sessionUser(sys, t.token);
    return user !== null && !user.blocked_at;
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

  const internalFetch = createInternalHandler({
    env,
    systems,
    db: o.db,
    ...(o.rpc ? { rpc: o.rpc } : {}),
    ...(o.version ? { version: o.version } : {}),
    ...(o.egress ? { egress: o.egress } : {}),
    ai: () => services.ai,
  });

  return {
    fetch,
    internalFetch,
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
    retentionTick: async (input = {}) => {
      const now = input.now ?? services.clock();
      const report: RetentionTickReport = { ran: [], failed: [] };
      for (const entry of (await o.registry.entries?.()) ?? []) {
        const at = { slug: entry.slug, env: entry.env };
        try {
          const sys = await systems.resolve(entry.slug, entry.env);
          if (!sys || !(await retentionDue(sys, now))) continue;
          report.ran.push({ ...at, ...(await runRetention(sys, services, now)) });
        } catch (err) {
          o.log?.({
            ts: new Date().toISOString(),
            level: "error",
            msg: "retention_failed",
            system: entry.slug,
            env: entry.env,
            sqlstate: (err as { code?: unknown }).code ?? null,
            reason: err instanceof Error ? err.name : "unknown",
          });
          report.failed.push(at);
        }
      }
      return report;
    },
  };
}
