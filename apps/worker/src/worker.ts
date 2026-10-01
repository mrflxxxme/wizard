// apps/worker (workflows.yaml#execution.M1): DBOS Transact over the platform database (schema dbos). Runs are the
// workflow RUN_WORKFLOW (workflowID = runs.id) on queues runs / interview; credits_cron, subscription renewals
// (billing_cron, M2-07), the dbos retention and the platform part of retention_cron (deletion journal, consent
// notices, delete_system) are DBOS scheduled workflows.
import { DBOS, type WorkflowStatus } from "@dbos-inc/dbos-sdk";
import type { Router, RouterOptions } from "@wizard/llm";
import { createLogger, type Logger } from "@wizard/pii/log";
import {
  Billing,
  BlobStore,
  type Config,
  checkRunFailureRate,
  createAgentExecutors,
  createDb,
  DBOS_APP,
  DBOS_SCHEMA,
  type DbHandle,
  dbosLogger,
  EventBus,
  ExportStore,
  ImportStore,
  loadConfig,
  type Mailer,
  migrate,
  type OpsAlertFn,
  opsAlertFromConfig,
  Payments,
  type PublishOptions,
  platformMailer,
  QUEUE_INTERVIEW,
  QUEUE_RUNS,
  queueOf,
  RUN_WORKFLOW,
  RunEngine,
  type RunExecutors,
  runRetentionCron,
  SecretStore,
  sweepExpiredExports,
  sweepExpiredImports,
} from "@wizard/platform-api";
import { dbosDurable } from "./durable.js";
import { StepStore } from "./step-store.js";

/** Recovery picks up pending workflows of the same application version (kept stable across code edits). */
export const WORKER_VERSION = "wizard-worker-1";
export const CREDITS_CRON = "wizard.credits_cron";
/** billing.yaml#recurring: renewal notices, autopayments with retries, past_due → Free (hourly). */
export const BILLING_CRON = "wizard.billing_cron";
export const DBOS_RETENTION = "wizard.dbos_retention";
/** Import files and export archives TTL (one schedule, as the in-process timer of platform-api). */
export const IMPORTS_TTL = "wizard.imports_ttl";
/** workflows.yaml#retention_cron (platform part): daily 03:30 MSK, after the runtime's retention pass. */
export const RETENTION_CRON = "wizard.retention_cron";
/** M2-09: founder alert «run failed rate > 20% за 1 ч» (deploy.yaml#cloud.observability.alerts), every 10 min. */
export const OPS_CHECKS = "wizard.ops_checks";
/** execution.M1.dbos_data: dbos.* of terminal workflows older than this are deleted daily. */
export const DBOS_RETENTION_DAYS = 30;
/** workflows.yaml#execution.M1.queues.runs default. */
export const DEFAULT_RUN_CONCURRENCY = 8;
const TERMINAL_WF = ["SUCCESS", "ERROR", "CANCELLED", "MAX_RECOVERY_ATTEMPTS_EXCEEDED"];

export interface WorkerOptions {
  config?: Partial<Config>;
  /** Existing connection; otherwise created from config.dbUrl and closed by close(). */
  db?: DbHandle;
  executors?: RunExecutors | ((d: { pg: DbHandle["pg"]; config: Config }) => RunExecutors);
  createRouter?: (opts: RouterOptions) => Router;
  publish?: PublishOptions;
  /** Platform migrations + seed before launch (default true; the dbos schema is migrated by DBOS.launch). */
  migrate?: boolean;
  /** credits_cron / dbos retention schedules (default true). */
  schedules?: boolean;
  /** Orphan sweep period: queued runs without a workflow, step outputs of ended workflows (default 30 s). */
  sweepMs?: number;
  /** Queue polling (default 250 ms). */
  pollMs?: number;
  logger?: Logger;
  now?: () => Date;
  /** Platform mail for owner notices of retention_cron and renewal notices (default: SMTP or the outbox, M2-09). */
  mailer?: Mailer;
  /** Founder alerts of the ops checks (default: log + webhook + e-mail from the config). */
  alert?: OpsAlertFn;
}

export interface Worker {
  engine: RunEngine;
  config: Config;
  steps: StepStore;
  /** One pass of the orphan sweep (tests). */
  sweep(): Promise<void>;
  /** Platform shop payments (renewals of billing_cron). */
  payments: Payments;
  /** One billing_cron pass as a DBOS workflow with this id (tests, manual catch-up); the same id never repeats. */
  runBillingCron(workflowID: string): Promise<void>;
  /** dbos retention (execution.M1.dbos_data): deletes terminal workflows completed before now − 30 days. */
  retainDbos(now?: Date): Promise<number>;
  /** One pass of the platform part of retention_cron (tests; the schedule runs it daily). */
  retention(now?: Date): ReturnType<typeof runRetentionCron>;
  /** One pass of the ops checks (run failure rate; tests). */
  opsChecks(now?: Date): ReturnType<typeof checkRunFailureRate>;
  close(): Promise<void>;
}

let started = false;

/** Starts the worker in this process (DBOS is a process singleton: one worker per process). */
export async function startWorker(o: WorkerOptions = {}): Promise<Worker> {
  if (started) throw new Error("worker already started in this process");
  started = true;
  try {
    return await launch(o);
  } catch (e) {
    started = false;
    throw e;
  }
}

async function launch(o: WorkerOptions): Promise<Worker> {
  const logger = o.logger ?? createLogger({ svc: "worker" });
  const log = (m: string, e?: unknown) => logger.error(m, e);
  const conc = process.env.WIZARD_RUN_CONCURRENCY ? undefined : DEFAULT_RUN_CONCURRENCY;
  const config = loadConfig(process.env, { ...(conc ? { runConcurrency: conc } : {}), ...o.config });
  const handle = o.db ?? createDb(config.dbUrl);
  if (o.migrate !== false) await migrate(handle.db);
  const billing = new Billing({ exemptOrgs: config.billingExemptOrgs, ...(o.now ? { now: o.now } : {}) });
  const executors =
    typeof o.executors === "function"
      ? o.executors({ pg: handle.pg, config })
      : (o.executors ?? createAgentExecutors({ pg: handle.pg, config }));
  const engine = new RunEngine({
    db: handle.db,
    pg: handle.pg,
    bus: new EventBus(),
    blobs: new BlobStore(config.artifactsDir),
    config,
    executors,
    billing,
    role: "worker",
    // Messages sent outside a workflow (sweep of abandoned runs): DBOS.send.
    dispatcher: {
      enqueue: async () => {},
      send: (to, topic, message, key) => DBOS.send(to, message, topic, key),
      close: async () => {},
    },
    secrets: new SecretStore(config.secretsFile, config.secretsKey),
    ...(o.createRouter ? { createRouter: o.createRouter } : {}),
    publish: { alert: (a) => alert(a), ...o.publish },
    log,
  });
  const steps = new StepStore(config.stepsDir, config.secretsKey);

  const runWorkflow = DBOS.registerWorkflow(
    async (runId: string): Promise<void> => {
      await engine.executeRun(runId, dbosDurable(runId, steps));
    },
    { name: RUN_WORKFLOW },
  );

  async function retainDbos(now = new Date()): Promise<number> {
    const cutoff = now.getTime() - DBOS_RETENTION_DAYS * 24 * 3600_000;
    // Payload tables have no foreign key (DBOS deleteWorkflows does the same); notifications, events and
    // streams cascade from workflow_status.
    const rows = await handle.pg`
      with old as (
        select workflow_uuid from dbos.workflow_status
        where completed_at is not null and completed_at < ${cutoff} and status in ${handle.pg(TERMINAL_WF)}
      ), i as (
        delete from dbos.workflow_input where workflow_uuid in (select workflow_uuid from old)
      ), o as (
        delete from dbos.workflow_output where workflow_uuid in (select workflow_uuid from old)
      ), s as (
        delete from dbos.operation_outputs where workflow_uuid in (select workflow_uuid from old)
      )
      delete from dbos.workflow_status where workflow_uuid in (select workflow_uuid from old)`;
    return rows.count;
  }

  const mailer = o.mailer ?? platformMailer(config);
  const alert = o.alert ?? opsAlertFromConfig(config, { logger, mailer, log });
  const payments = new Payments({
    db: handle.db,
    config,
    ledger: billing,
    mailer,
    log,
  });
  // Each phase and each org's renewal is a step: a crash resumes after the last finished one; a renewal repeated
  // inside its step is safe (payments.idempotence_key + Idempotence-Key renew:<org>:<period>).
  const billingCron = DBOS.registerWorkflow(
    async (_at: Date, _ctx: unknown): Promise<void> => {
      if (!payments.enabled) return;
      await DBOS.runStep(() => payments.remind(), { name: "billing_remind" });
      await DBOS.runStep(() => payments.endDue(), { name: "billing_end" });
      const due = await DBOS.runStep(() => payments.dueRenewals(), { name: "billing_due" });
      for (const orgId of due)
        await DBOS.runStep(
          () =>
            payments.renew(orgId).catch((e) => {
              log("billing renewal failed", e);
              return false;
            }),
          { name: `renew:${orgId}` },
        );
      await DBOS.runStep(() => payments.reconcile(), { name: "billing_reconcile" });
    },
    { name: BILLING_CRON },
  );
  const creditsCron = DBOS.registerWorkflow(
    async (_at: Date, _ctx: unknown): Promise<void> => {
      await DBOS.runStep(() => billing.sweep(handle.db), { name: "credits_sweep" });
    },
    { name: CREDITS_CRON },
  );
  // db.yaml#imports (files, 7 days) and #exports (archives, 24 h): deleted after expires_at, hourly.
  const importStore = new ImportStore(config.importsDir, config.secretsKey);
  const exportStore = new ExportStore(config.artifactsDir, config.secretsKey);
  const ttlSweep = () =>
    Promise.all([
      sweepExpiredImports(handle.db, importStore).catch((e) => log("import TTL sweep failed", e)),
      sweepExpiredExports(handle.db, exportStore).catch((e) => log("export TTL sweep failed", e)),
    ]);
  const importsTtl = DBOS.registerWorkflow(
    async (_at: Date, _ctx: unknown): Promise<void> => {
      await DBOS.runStep(async () => void (await ttlSweep()), { name: "imports_exports_ttl" });
    },
    { name: IMPORTS_TTL },
  );
  const retention = (now = new Date()) =>
    runRetentionCron(
      {
        db: handle.db,
        pg: handle.pg,
        blobs: new BlobStore(config.artifactsDir),
        config,
        mailer,
        ...(o.publish?.migratorRole ? { migratorRole: o.publish.migratorRole } : {}),
        log,
        alert: (msg, fields) => logger.error(msg, undefined, fields),
        platformOrigin: config.platformOrigin,
      },
      now,
    );
  const retentionCron = DBOS.registerWorkflow(
    async (_at: Date, _ctx: unknown): Promise<void> => {
      // One step: the pass is idempotent (journal rows move in one transaction, the purge repeats until its marker).
      await DBOS.runStep(async () => void (await retention()), { name: "retention_platform" });
    },
    { name: RETENTION_CRON },
  );
  const opsChecks = (now = new Date()) => checkRunFailureRate(handle.db, alert, now);
  const opsChecksCron = DBOS.registerWorkflow(
    async (_at: Date, _ctx: unknown): Promise<void> => {
      await DBOS.runStep(async () => void (await opsChecks()), { name: "ops_checks" });
    },
    { name: OPS_CHECKS },
  );
  const dbosRetention = DBOS.registerWorkflow(
    async (_at: Date, _ctx: unknown): Promise<void> => {
      await DBOS.runStep(() => retainDbos(), { name: "dbos_retention" });
    },
    { name: DBOS_RETENTION },
  );

  DBOS.setConfig({
    name: DBOS_APP,
    systemDatabaseUrl: config.dbUrl,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    // PgBouncer transaction mode (deploy.yaml#cloud.postgres.pooling): no LISTEN.
    useListenNotify: false,
    applicationVersion: WORKER_VERSION,
    logger: dbosLogger(log, (m) => logger.debug(m)),
    systemDatabasePoolSize: 10,
  });
  await DBOS.launch();
  const pollMs = o.pollMs ?? 250;
  await DBOS.registerQueue(QUEUE_RUNS, {
    // Waiting runs (needs_input, waiting_lock) stay dequeued; active ones are limited by the engine's slots.
    workerConcurrency: Math.max(64, config.runConcurrency * 8),
    minPollingIntervalMs: pollMs,
    onConflict: "always_update",
  });
  await DBOS.registerQueue(QUEUE_INTERVIEW, {
    workerConcurrency: 16,
    partitionConcurrency: 1,
    minPollingIntervalMs: pollMs,
    onConflict: "always_update",
  });
  if (o.schedules !== false) {
    await DBOS.applySchedules([
      { scheduleName: CREDITS_CRON, workflowFn: creditsCron, schedule: "7 * * * *" },
      { scheduleName: BILLING_CRON, workflowFn: billingCron, schedule: "13 * * * *" },
      { scheduleName: IMPORTS_TTL, workflowFn: importsTtl, schedule: "23 * * * *" },
      { scheduleName: OPS_CHECKS, workflowFn: opsChecksCron, schedule: "*/10 * * * *" },
      {
        scheduleName: RETENTION_CRON,
        workflowFn: retentionCron,
        schedule: "30 3 * * *",
        cronTimezone: "Europe/Moscow",
      },
      {
        scheduleName: DBOS_RETENTION,
        workflowFn: dbosRetention,
        schedule: "41 3 * * *",
        cronTimezone: "Europe/Moscow",
      },
    ]);
  }

  // As in-process platform-api: one TTL pass at start (then hourly by the schedule).
  await ttlSweep();

  async function status(id: string): Promise<WorkflowStatus | null> {
    return DBOS.getWorkflowStatus(id);
  }

  async function sweep(): Promise<void> {
    // A run inserted by platform-api whose enqueue was lost (crash between commit and enqueue).
    const orphans = await handle.db
      .selectFrom("platform.runs")
      .select(["id", "kind", "system_id"])
      .where("status", "=", "queued")
      .where("created_at", "<", new Date(Date.now() - 10_000))
      .limit(100)
      .execute();
    for (const r of orphans) {
      if (await status(r.id)) continue;
      const q = queueOf(r);
      await DBOS.startWorkflow(runWorkflow, {
        workflowID: r.id,
        queueName: q.queueName,
        ...(q.queuePartitionKey ? { enqueueOptions: { queuePartitionKey: q.queuePartitionKey } } : {}),
      })(r.id);
    }
    // A run whose workflow ended without its terminal transaction would hold its status and lock forever.
    const active = await handle.db
      .selectFrom("platform.runs")
      .select("id")
      .where("status", "in", ["waiting_lock", "running", "needs_input"])
      .where("created_at", "<", new Date(Date.now() - 10_000))
      .limit(200)
      .execute();
    for (const r of active) {
      const s = await status(r.id);
      if (s && TERMINAL_WF.includes(s.status)) await engine.failAbandoned(r.id);
    }
    // Step outputs are needed only while a workflow can still be replayed.
    for (const runId of steps.runs()) {
      const s = await status(runId);
      if (!s || TERMINAL_WF.includes(s.status)) steps.drop(runId);
    }
  }

  const sweepMs = o.sweepMs ?? 30_000;
  let sweeping: Promise<void> = Promise.resolve();
  const timer =
    sweepMs > 0
      ? setInterval(() => {
          sweeping = sweep().catch((e) => log("sweep failed", e));
        }, sweepMs)
      : undefined;
  timer?.unref();
  logger.info("ready", { pid: process.pid, mode: config.authMode });

  let closed = false;
  return {
    engine,
    config,
    steps,
    payments,
    async runBillingCron(workflowID: string) {
      const h = await DBOS.startWorkflow(billingCron, { workflowID })(new Date(), {});
      await h.getResult();
    },
    sweep,
    retainDbos,
    retention,
    opsChecks,
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      await sweeping;
      engine.stop();
      await DBOS.shutdown({ deregister: true });
      await engine.close();
      await executors.close?.();
      if (!o.db) await handle.close();
      started = false;
    },
  };
}
