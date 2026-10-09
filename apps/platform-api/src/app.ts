import type { ModuleRegistry } from "@wizard/agents/planner";
import type { Router, RouterOptions } from "@wizard/llm";
import { createLogger } from "@wizard/pii/log";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { checkAbuseSla } from "./abuse/reports.js";
import { createAgentExecutors } from "./agents/executors.js";
import type { RuntimeAiBackfill } from "./ai/backfill.js";
import { AiGateway } from "./ai/gateway.js";
import type { Mailer } from "./auth/mailer.js";
import type { GeoRegion } from "./auth/region.js";
import { platformMailer } from "./auth/smtp-mailer.js";
import { Billing } from "./billing/ledger.js";
import { llmCapOf } from "./billing/llm-cap.js";
import { Payments } from "./billing/payments.js";
import { briefRoutes } from "./briefs/routes.js";
import { sessionRoutes } from "./briefs/sessions.js";
import { briefUploadRoutes } from "./briefs/upload.js";
import { buildV3Routes } from "./builds-v3/routes.js";
import { type ByokService, byokRoutes, byokServiceOf, type TransitKms } from "./byok/index.js";
import { assertStartupAllowed, type Config, loadConfig, StartupError } from "./config.js";
import { createDb, type DbHandle, migrate } from "./db/index.js";
import { directionPreviewRoutes, directionRoutes } from "./directions/routes.js";
import { type DirectionsDeps, DirectionsService } from "./directions/service.js";
import { ApiError } from "./errors.js";
import { ExportStore, sweepExpiredExports } from "./exports/storage.js";
import { runModuleFactoryCron } from "./gaps/factory.js";
import { repoRoutes } from "./git/routes.js";
import { GitSync, type GitSyncOptions, repoSyncRoutes, repoWebhookRoutes } from "./git-sync/index.js";
import { type AppEnv, authenticate, originGuard } from "./http/auth.js";
import { hostGuard } from "./http/guard.js";
import { IdempotencyCache, idempotency } from "./http/idempotency.js";
import type { Deps } from "./http/util.js";
import { ImportStore, sweepExpiredImports } from "./imports/storage.js";
import { integrationRoutes } from "./integrations-v3/routes.js";
import type { IntegrationsDeps } from "./integrations-v3/service.js";
import type { OpsAlertFn } from "./ops/alert.js";
import { opsAlertFromConfig } from "./ops/alert-config.js";
import { checkRunFailureRate } from "./ops/checks.js";
import { runRetentionCron } from "./privacy/cron.js";
import type { PublishOptions } from "./publish/prod.js";
import { agentRedirects, RepoAgent, type RepoAgentOptions, repoAgentRoutes } from "./repo-agent/index.js";
import { abuseRoutes } from "./routes/abuse.js";
import { adminRoutes } from "./routes/admin.js";
import { capabilityRoutes } from "./routes/admin-capability.js";
import { adminPilotRoutes } from "./routes/admin-pilot.js";
import { adminSystemsRoutes } from "./routes/admin-systems.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes, yookassaWebhook } from "./routes/billing.js";
import { creditRoutes } from "./routes/credits.js";
import { destructiveRoutes } from "./routes/destructive.js";
import { exportRoutes } from "./routes/exports.js";
import { factoryRoutes } from "./routes/factory.js";
import { gapsRoutes } from "./routes/gaps.js";
import { importRoutes } from "./routes/imports.js";
import { internalRoutes } from "./routes/internal.js";
import { lockRoutes } from "./routes/lock.js";
import { orgRoutes } from "./routes/orgs.js";
import { planRoutes } from "./routes/plans.js";
import { privacyRoutes } from "./routes/privacy.js";
import { publishRoutes } from "./routes/publish.js";
import { runRoutes } from "./routes/runs.js";
import { supportRoutes } from "./routes/support.js";
import { systemRoutes } from "./routes/systems.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { createDbosDispatcher } from "./runs/dispatch.js";
import { EventBus } from "./runs/events.js";
import { type RunDispatcher, RunEngine } from "./runs/queue.js";
import type { RunExecutors } from "./runs/types.js";
import { SecretStore } from "./secrets/store.js";
import { secretWindowRoutes, windowKmsOf } from "./secrets-v3/index.js";
import { BlobStore } from "./storage/blobs.js";

export interface PlatformApiOptions {
  config?: Partial<Config>;
  /** Existing connection; otherwise created from config.dbUrl and closed by close(). */
  db?: DbHandle;
  /** Run executors, or a factory over the API's connection/config; default: the real agents (createAgentExecutors). */
  executors?: RunExecutors | ((d: { pg: DbHandle["pg"]; config: Config }) => RunExecutors);
  createRouter?: (opts: RouterOptions) => Router;
  /** B2-20: module registry of the beta v2 path — goal interview, plan screen (default — @wizard/modules CATALOG). */
  modules?: ModuleRegistry;
  /** Run migrations + seed (default true). */
  migrate?: boolean;
  /** Fail runs left non-terminal by a previous process (default true). */
  recover?: boolean;
  pingMs?: number;
  /** publish/rollback (M1-04): smoke check of the prod host, DB roles, lock retry pauses. */
  publish?: PublishOptions;
  log?: (msg: string, err?: unknown) => void;
  /**
   * Platform mail (OTP, invites, notices, alerts); default: SMTP from WIZARD_SMTP_* (M2-09), else files in
   * config.outboxDir (production requires SMTP or an injected mailer).
   */
  mailer?: Mailer;
  /** Offline GeoIP of logins for the T1 region restriction (data-boundary.yaml#region_restriction.sources). */
  geoRegion?: GeoRegion;
  /**
   * Founder alerts (LLM cap of the month, run failure rate, founder review requests); default: structured log +
   * WIZARD_OPS_ALERT_URL webhook + WIZARD_OPS_ALERT_EMAIL letter.
   */
  alert?: OpsAlertFn;
  /**
   * Run failure-rate check period (deploy.yaml#cloud.observability.alerts, M2-09); 0 disables the in-process timer
   * (default 10 min; 0 with dbos — the worker's wizard.ops_checks schedule).
   */
  opsCheckMs?: number;
  /** Clock of the credits ledger (grants, expiry) and of the LLM cap month; tests move it forward. */
  now?: () => Date;
  /**
   * credits_cron period (billing.yaml#credits_cron, hourly), also renewals of subscriptions (M2-07); 0 disables the
   * in-process timer (default 0 with dbos: DBOS scheduled workflows of apps/worker).
   */
  creditsCronMs?: number;
  /** SLA watch of abuse reports (< 2 h left → founder alert once per report; M2-08); 0 disables. Default 10 min. */
  abuseSlaMs?: number;
  /**
   * Test hook of the automatic takedown (abuse.yaml#takedown.auto_suspend): failed G2 antifraud blockers of the live
   * revision; default — runG2 with G2-AF-01…07 on the stored revision (abuse/escalation.ts antifraudRecheck).
   */
  antifraudRecheck?: (s: { systemId: string; revision: number }) => Promise<string[]>;
  /** retention_cron platform pass period (hourly in-process; 0 disables, default 0 with dbos — worker schedule). */
  retentionCronMs?: number;
  /**
   * B2-26 module_factory_cron check period in-process (default 6 h: recomputes when the rating is a week old; 0
   * disables, default 0 with dbos — the worker's weekly wizard.module_factory schedule).
   */
  moduleFactoryMs?: number;
  /**
   * inprocess (default; M0 and unit tests): runs execute in this process. dbos (M1, `pnpm dev`): runs are enqueued
   * as DBOS workflows that apps/worker executes (workflows.yaml#execution.M1).
   */
  engine?: "inprocess" | "dbos";
  /** engine dbos: hand-over to DBOS (default: DBOSClient on config.dbUrl). */
  dispatcher?: RunDispatcher;
  /**
   * M3-02: AI backfill on the runtime (default: HTTP to WIZARD_RUNTIME_INTERNAL_URL with WIZARD_INTERNAL_TOKEN; null —
   * off). The AI gateway of the runtime (POST /internal/v1/ai/run) uses `createRouter` and the platform mailer.
   */
  aiBackfill?: RuntimeAiBackfill | null;
  /** V3-09 «Три направления»: research of reference links (tests: recorded pages) and the model deadline. */
  directions?: Pick<DirectionsDeps, "researchFetch" | "researchMode" | "deadlineMs">;
  /** V3-33 BYOK service (tests: flag, KMS, gateway fetch); default from env (byok/index.ts byokServiceOf). */
  byok?: (d: { pg: DbHandle["pg"]; secrets: SecretStore }) => ByokService;
  /** V3-20 integrations harness: research of documentation links and the network of key checks (tests: local TLS). */
  integrations?: Pick<IntegrationsDeps, "research" | "keyCheck">;
  /** V3-21 key window: its KMS (default windowKmsOf(env): OpenBao Transit or the local KEK) and platform domains. */
  secretWindow?: { kms?: TransitKms | null; platformDomains?: readonly string[] };
  /** V3-31 repository sync (tests: env and config of the providers, their HTTP, the clock; the queue timer). */
  gitSync?: Pick<GitSyncOptions, "env" | "cfg" | "fetch" | "now">;
  /** V3-32 agent for compatible repositories (tests: the sandbox, the router, the env; the queue timer). */
  repoAgent?: Pick<RepoAgentOptions, "sandbox" | "createRouter" | "tickMs" | "env" | "executes">;
}

export interface PlatformApi {
  app: Hono;
  /**
   * Hono fetch for @hono/node-server: `env` ({incoming, outgoing}) MUST be passed on — clientIp() reads the peer
   * address from it (webhook IP allowlist, OTP and card-binding limits; M2-11 fix).
   */
  fetch: (req: Request, env?: unknown) => Response | Promise<Response>;
  engine: RunEngine;
  deps: Deps;
  /** V3-31: sync of system repositories with GitHub and GitLab (tests drive its queue with tick()). */
  gitSync: GitSync;
  /** V3-32: the agent for compatible repositories (tests drive its queue with tick()). */
  repoAgent: RepoAgent;
  close(): Promise<void>;
}

export async function createPlatformApi(opts: PlatformApiOptions = {}): Promise<PlatformApi> {
  const config = loadConfig(process.env, opts.config);
  assertStartupAllowed(config);
  if (!opts.mailer && !config.smtp && config.nodeEnv === "production")
    throw new StartupError(
      "почтовый провайдер платформы не подключён (NODE_ENV=production): задайте WIZARD_SMTP_HOST и WIZARD_SMTP_FROM",
    );
  const mailer = opts.mailer ?? platformMailer(config);
  const handle = opts.db ?? createDb(config.dbUrl);
  const dbos = opts.engine === "dbos";
  // The dbos schema is migrated by apps/worker (DBOS.launch): two concurrent DBOS migrators deadlock.
  if (opts.migrate !== false) await migrate(handle.db);
  const bus = new EventBus();
  const blobs = new BlobStore(config.artifactsDir);
  const logger = createLogger({ svc: "platform-api" });
  const log = opts.log ?? ((m: string, e?: unknown) => logger.error(m, e));
  const alert = opts.alert ?? opsAlertFromConfig(config, { logger, mailer, log });
  const llmCap = llmCapOf(config, { db: handle.db, alert, ...(opts.now ? { now: opts.now } : {}) });
  const billing = new Billing({
    exemptOrgs: config.billingExemptOrgs,
    llmCap,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const secrets = new SecretStore(config.secretsFile, config.secretsKey);
  const byok = opts.byok?.({ pg: handle.pg, secrets }) ?? byokServiceOf(handle.pg, secrets);
  const executors =
    typeof opts.executors === "function"
      ? opts.executors({ pg: handle.pg, config })
      : (opts.executors ??
        createAgentExecutors({
          pg: handle.pg,
          config,
          // B2-38: platform keys of the stocks (secret://platform/stock/*).
          secrets,
          ...(opts.modules ? { modules: opts.modules } : {}),
        }));
  const dispatcher = dbos
    ? (opts.dispatcher ?? (await createDbosDispatcher({ dbUrl: config.dbUrl, log })))
    : undefined;
  const engine = new RunEngine({
    db: handle.db,
    pg: handle.pg,
    bus,
    blobs,
    config,
    executors,
    billing,
    role: dbos ? "client" : "inprocess",
    ...(dispatcher ? { dispatcher } : {}),
    secrets,
    byok: byok.off ? null : byok.resolver(),
    ...(opts.createRouter ? { createRouter: opts.createRouter } : {}),
    publish: { alert, ...opts.publish },
    ...(opts.aiBackfill !== undefined ? { aiBackfill: opts.aiBackfill } : {}),
    log,
  });
  if (opts.recover !== false) await engine.recover();
  // Import files (7 days) and export archives (24 h) TTL: at start and hourly; with dbos — a scheduled workflow of
  // apps/worker.
  const importStore = new ImportStore(config.importsDir, config.secretsKey);
  const exportStore = new ExportStore(config.artifactsDir, config.secretsKey);
  const sweep = () =>
    Promise.all([
      sweepExpiredImports(handle.db, importStore).catch((e) => log("import TTL sweep failed", e)),
      // Export archives (db.yaml#exports.expires_at, 24 h).
      sweepExpiredExports(handle.db, exportStore).catch((e) => log("export TTL sweep failed", e)),
    ]);
  let sweepTimer: NodeJS.Timeout | undefined;
  if (!dbos) {
    await sweep();
    sweepTimer = setInterval(sweep, 3600_000);
    sweepTimer.unref();
  }
  const payments = new Payments({ db: handle.db, config, ledger: billing, mailer, log });
  // V3-31: the repository sync — imports are gated by the same executor as runs, their preview built by its G0 step.
  const gitSync = new GitSync({
    db: handle.db,
    pg: handle.pg,
    blobs,
    config,
    secrets,
    ...(executors.gates ? { gates: executors.gates } : {}),
    ...(executors.onG0Passed ? { onG0Passed: executors.onG0Passed } : {}),
    log,
    ...opts.gitSync,
  });
  gitSync.start();
  // V3-32: the agent for compatible repositories — the sync's providers and KMS, its own queue of tasks. With the DBOS
  // engine the tasks run in apps/worker (startRepoAgentRunner): this internet-facing process only enqueues them and
  // never holds the Kubernetes token of the sandbox pods.
  const repoAgent = new RepoAgent({
    db: handle.db,
    config,
    sync: gitSync,
    billing,
    log,
    executes: !dbos,
    ...(opts.createRouter ? { createRouter: opts.createRouter } : {}),
    ...opts.repoAgent,
  });
  repoAgent.start();
  const deps: Deps = {
    db: handle.db,
    pg: handle.pg,
    bus,
    blobs,
    engine,
    config,
    billing,
    payments,
    ...(dbos ? { eventPollMs: 250 } : {}),
    ...(opts.modules ? { modules: opts.modules } : {}),
  };
  // credits_cron: a DBOS scheduled workflow of apps/worker in M1; the in-process timer only without it.
  const cronMs = opts.creditsCronMs ?? (dbos ? 0 : 3600_000);
  const cron =
    cronMs > 0
      ? setInterval(() => {
          billing.sweep(handle.db).catch((e) => log("credits_cron failed", e));
          payments.sweep().catch((e) => log("billing renewals failed", e));
        }, cronMs)
      : undefined;
  cron?.unref();
  // retention_cron, platform part (deletion journal, consent notices, delete_system): DBOS scheduled in apps/worker;
  // the in-process timer only without it.
  const retentionMs = opts.retentionCronMs ?? (dbos ? 0 : 3600_000);
  const retention =
    retentionMs > 0
      ? setInterval(() => {
          runRetentionCron({
            db: handle.db,
            pg: handle.pg,
            blobs,
            config,
            mailer,
            ...(opts.publish?.migratorRole ? { migratorRole: opts.publish.migratorRole } : {}),
            log,
            alert: (msg, fields) => logger.error(msg, undefined, fields),
            platformOrigin: config.platformOrigin,
          }).catch((e) => log("retention_cron failed", e));
        }, retentionMs)
      : undefined;
  retention?.unref();
  // Founder alert «run failed rate > 20% за 1 ч» (M2-09): DBOS scheduled in apps/worker; in-process without it.
  const opsMs = opts.opsCheckMs ?? (dbos ? 0 : 600_000);
  const opsTimer =
    opsMs > 0
      ? setInterval(() => {
          checkRunFailureRate(handle.db, alert, opts.now?.() ?? new Date()).catch((e) =>
            log("ops checks failed", e),
          );
        }, opsMs)
      : undefined;
  opsTimer?.unref();
  // B2-26 module factory: the weekly rating of «Запросы на развитие»; DBOS scheduled in apps/worker, in-process without.
  const factoryMs = opts.moduleFactoryMs ?? (dbos ? 0 : 6 * 3600_000);
  const factoryTimer =
    factoryMs > 0
      ? setInterval(() => {
          runModuleFactoryCron(
            {
              db: handle.db,
              mailer,
              platformOrigin: config.platformOrigin,
              ...(opts.modules ? { registry: opts.modules } : {}),
              log,
            },
            opts.now?.() ?? new Date(),
            { ifStale: true },
          ).catch((e) => log("module factory failed", e));
        }, factoryMs)
      : undefined;
  factoryTimer?.unref();
  // abuse.yaml#takedown.sla: every API process watches (one alert per report through db.yaml#ops_alerts).
  const abuseSlaMs = opts.abuseSlaMs ?? 600_000;
  const abuseSla =
    abuseSlaMs > 0
      ? setInterval(() => {
          checkAbuseSla({ db: handle.db, alert }).catch((e) => log("abuse SLA watch failed", e));
        }, abuseSlaMs)
      : undefined;
  abuseSla?.unref();

  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.body(), err.status as 400);
    if (err instanceof HTTPException && err.status < 500)
      return c.json({ code: "VALIDATION_FAILED", message_ru: "Некорректный запрос" }, 400);
    log(`http ${c.req.method} ${c.req.routePath}`, err);
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
  // Runtime AI gateway (runtime.yaml#ai_actions.call, M3-02): internal token, no Origin and no session.
  const aiGateway = new AiGateway({
    db: handle.db,
    config,
    billing,
    mailer,
    alert,
    ...(opts.createRouter ? { createRouter: opts.createRouter } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    log,
  });
  app.route("/internal/v1", internalRoutes({ config, gateway: aiGateway, log }));
  // Notifications of the platform shop come without Origin and session (api.yaml yookassaWebhook, security: []).
  app.post("/api/v1/webhooks/yookassa", yookassaWebhook(deps));
  // V3-31: GitHub App and GitLab project hooks (signature / hook token instead of a session).
  app.route("/api/v1", repoWebhookRoutes(gitSync));
  // V3-09: files of the direction previews for the sandboxed srcdoc frames (no session; the proposal id is the key).
  const directions = new DirectionsService({
    db: handle.db,
    blobs,
    config,
    billing,
    ...(opts.createRouter ? { createRouter: opts.createRouter } : {}),
    ...opts.directions,
    log,
  });
  app.route("/api/v1", directionPreviewRoutes(directions));
  app.use("*", originGuard(config));

  const accounts = { mailer, geoRegion: opts.geoRegion };
  const api = new Hono<AppEnv>();
  api.use("*", authenticate({ db: handle.db, config }));
  api.use("*", idempotency(new IdempotencyCache()));
  api.route("/", authRoutes(deps, accounts));
  api.route("/", systemRoutes(deps));
  api.route("/", planRoutes(deps));
  // V3-02: the system brief — latest version with its diagrams, history with diffs, the owner's edit.
  api.route("/", briefRoutes(deps));
  // V3-04: ТЗ from a file → a brief draft (T0 brief_extract, the file only in the request's memory).
  api.route(
    "/",
    briefUploadRoutes({
      ...deps,
      alert,
      log,
      ...(opts.createRouter ? { createRouter: opts.createRouter } : {}),
    }),
  );
  // V3-06: the session feed of a system (interview, builds, brief edits) from runs and brief versions.
  api.route("/", sessionRoutes(deps));
  // V3-06: «Собрать» of a v3 system — the build by the approved brief version (startV3Build of V3-11).
  api.route("/", buildV3Routes(deps));
  // V3-30: the internal git of the system — commits, revision ↔ commit, diff, zip of the tree.
  api.route("/", repoRoutes(deps));
  // V3-31: sync of the repository with GitHub / GitLab through PRs (connect, state, auto-merge, PR preview).
  api.route("/", repoSyncRoutes(deps, gitSync, agentRedirects(deps, repoAgent)));
  // V3-32: the agent for compatible repositories of an org (connect, compatibility report, tasks → draft PRs).
  api.route("/", repoAgentRoutes(repoAgent));
  // V3-09: three directions of the first screen, refinement by words, the pick and the references.
  api.route("/", directionRoutes(directions));
  // V3-20: integrations of the brief (contracts, mock → key check → live) and keys of the system's own API.
  api.route("/", integrationRoutes({ ...deps, secrets, ...opts.integrations }));
  // V3-21: the key window — browser-encrypted keys as secret://name, checked by the contract, rotated and removed.
  api.route(
    "/",
    secretWindowRoutes({
      ...deps,
      secrets,
      kms: opts.secretWindow?.kms !== undefined ? opts.secretWindow.kms : windowKmsOf(process.env, secrets),
      ...opts.integrations,
      ...(opts.secretWindow?.platformDomains ? { platformDomains: opts.secretWindow.platformDomains } : {}),
      notice: { mailer, log },
    }),
  );
  api.route("/", webhookRoutes(deps));
  api.route("/", publishRoutes(deps));
  api.route("/", destructiveRoutes(deps));
  api.route("/", importRoutes(deps));
  api.route("/", exportRoutes(deps));
  api.route("/", privacyRoutes(deps));
  api.route("/", lockRoutes(deps));
  api.route("/", orgRoutes(deps, accounts));
  // V3-33: own model keys of an org (behind the flag until V3-35).
  api.route("/", byokRoutes(byok));
  api.route("/", creditRoutes(deps));
  api.route("/", billingRoutes(deps));
  const abuse = {
    db: handle.db,
    pg: handle.pg,
    config,
    mailer,
    alert,
    log,
    secrets,
    blobs,
    antifraudRecheck: opts.antifraudRecheck,
  };
  api.route("/", abuseRoutes(abuse));
  api.route("/", adminRoutes(abuse));
  api.route("/", adminPilotRoutes({ ...abuse, billing, pilotNow: opts.now }));
  // M2P MVP cut: «Написать команде» (D68) and «Запросы на развитие» (D73).
  api.route("/", supportRoutes({ ...abuse, supportNow: opts.now }));
  api.route("/", gapsRoutes({ ...abuse, gapsNow: opts.now }));
  // V3-06: /admin — the monthly share of «пока не умею» in the capability maps of briefs.
  api.route("/", capabilityRoutes({ ...abuse, ...(opts.now ? { now: opts.now } : {}) }));
  // V3-18: /admin «Системы и сбои» — every system with its last build and spend, failed runs with the error.
  api.route("/", adminSystemsRoutes(abuse));
  // B2-26: module factory — «Кандидаты в модули» and the consent to «Теперь умеем» letters.
  api.route("/", factoryRoutes({ ...abuse, factoryNow: opts.now, modules: opts.modules }));
  api.route("/", runRoutes(deps, opts.pingMs !== undefined ? { pingMs: opts.pingMs } : {}));
  app.route("/api/v1", api);

  return {
    app,
    fetch: (req, env) => app.fetch(req, env),
    engine,
    deps,
    gitSync,
    repoAgent,
    async close() {
      gitSync.stop();
      await repoAgent.stop();
      if (cron) clearInterval(cron);
      if (retention) clearInterval(retention);
      if (opsTimer) clearInterval(opsTimer);
      if (factoryTimer) clearInterval(factoryTimer);
      if (abuseSla) clearInterval(abuseSla);
      if (sweepTimer) clearInterval(sweepTimer);
      await engine.close();
      await executors.close?.();
      if (!opts.db) await handle.close();
    },
  };
}
