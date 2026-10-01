// Run observability (M2-09; deploy.yaml#cloud.observability.alerts, #pilot.observability): Prometheus metrics of
// platform-api and the worker on a dedicated listener (WIZARD_METRICS_PORT), scraped by the pilot VictoriaMetrics
// through pod annotations. Process counters (runs started/finished by kind, durations, gate failures by check,
// retention passes) are recorded where the event happens — the run engine runs in platform-api (inprocess) or in the
// worker (dbos), so series of both processes add up. Database gauges (queue depth, LLM ₽ of the month and the cap,
// pending founder reviews, failure share of the last hour) are read on scrape by platform-api only. Queries for vmui:
// docs/ops/observability.md. WAL archive lag comes from the pg-ops sidecar (wizard_pg_archive_lag_seconds).
import { DURATION_BUCKETS_S, Registry, serveMetrics } from "@wizard/pii/metrics";
import { sql } from "kysely";
import { llmSpentRub, moscowMonth } from "../billing/llm-cap.js";
import type { Db } from "../db/index.js";

/** Registry of this process (platform-api or worker). */
export const platformMetrics = new Registry();

export const runsStarted = platformMetrics.counter("wizard_runs_started_total", "Runs started, by kind", [
  "kind",
]);
export const runsFinished = platformMetrics.counter(
  "wizard_runs_finished_total",
  "Runs that reached a terminal status, by kind and status (succeeded, failed, cancelled)",
  ["kind", "status"],
);
export const runFailures = platformMetrics.counter(
  "wizard_run_failures_total",
  "Failed runs by kind and failure code (run_lifecycle.failure_codes)",
  ["kind", "code"],
);
export const runDuration = platformMetrics.histogram(
  "wizard_run_duration_seconds",
  "Run duration from start to the terminal status, seconds",
  ["kind", "status"],
  DURATION_BUCKETS_S,
);
export const gateCheckFailures = platformMetrics.counter(
  "wizard_gate_check_failures_total",
  "Gate checks with status fail or error, by gate level and check id",
  ["level", "check"],
);
export const gateRuns = platformMetrics.counter("wizard_gate_runs_total", "Gate runs by level and result", [
  "level",
  "passed",
]);
export const retentionPasses = platformMetrics.counter(
  "wizard_retention_passes_total",
  "Platform retention_cron passes by result (ok, failed)",
  ["result"],
);
export const opsAlertsSent = platformMetrics.counter(
  "wizard_ops_alerts_total",
  "Founder alerts claimed (one per key), by event",
  ["event"],
);

/** Records a run's terminal transition (after its transaction committed). */
export function recordRunEnd(r: {
  kind: string;
  status: string;
  code?: string | null;
  startedAt?: Date | string | null;
  finishedAt?: Date;
}): void {
  runsFinished.inc({ kind: r.kind, status: r.status });
  if (r.status === "failed") runFailures.inc({ kind: r.kind, code: r.code ?? "unknown" });
  if (r.startedAt) {
    const s = ((r.finishedAt ?? new Date()).getTime() - new Date(r.startedAt).getTime()) / 1000;
    if (s >= 0) runDuration.observe({ kind: r.kind, status: r.status }, s);
  }
}

/** Records a gate report: one run per level and every failed check (ids are tokens like G2-AF-08). */
export function recordGate(report: {
  level: string;
  passed: boolean;
  checks: { id: string; status: string }[];
}): void {
  gateRuns.inc({ level: report.level, passed: report.passed ? "true" : "false" });
  for (const c of report.checks)
    if (c.status === "fail" || c.status === "error")
      gateCheckFailures.inc({ level: report.level, check: c.id });
}

const queueDepth = platformMetrics.gauge(
  "wizard_runs_active",
  "Runs not yet terminal, by kind and status (queued, waiting_lock, running, needs_input)",
  ["kind", "status"],
);
const llmCost = platformMetrics.gauge(
  "wizard_llm_cost_rub",
  "Billable LLM spend of live calls in the current calendar month (Europe/Moscow), RUB",
  ["month"],
);
const llmCap = platformMetrics.gauge("wizard_llm_monthly_cap_rub", "WIZARD_LLM_MONTHLY_CAP_RUB");
const reviewsPending = platformMetrics.gauge(
  "wizard_founder_reviews_pending",
  "Revisions waiting for the founder's review before prod",
);
const failShare = platformMetrics.gauge(
  "wizard_runs_failed_ratio_1h",
  "Failed share of runs finished in the last hour (0 when none finished)",
);
const finishedHour = platformMetrics.gauge("wizard_runs_finished_1h", "Runs finished in the last hour");

/** Failed and finished runs of the last hour (terminal: succeeded, failed; cancellations are the user's choice). */
export async function runFailureWindow(db: Db, now: Date): Promise<{ failed: number; finished: number }> {
  const r = await db
    .selectFrom("platform.runs")
    .select([
      sql<string>`count(*) filter (where status = 'failed')`.as("failed"),
      sql<string>`count(*)`.as("finished"),
    ])
    .where("status", "in", ["succeeded", "failed"])
    .where("finished_at", ">=", new Date(now.getTime() - 3600_000))
    .where("finished_at", "<=", now)
    .executeTakeFirstOrThrow();
  return { failed: Number(r.failed), finished: Number(r.finished) };
}

/** Database gauges, refreshed on every scrape (platform-api only: one copy of each series). */
export function collectDbGauges(o: { db: Db; capRub: number; now?: () => Date }): () => Promise<void> {
  return async () => {
    const now = o.now?.() ?? new Date();
    const active = await o.db
      .selectFrom("platform.runs")
      .select(["kind", "status", sql<string>`count(*)`.as("n")])
      .where("status", "in", ["queued", "waiting_lock", "running", "needs_input"])
      .groupBy(["kind", "status"])
      .execute();
    queueDepth.reset();
    for (const k of ["build", "publish"]) queueDepth.set({ kind: k, status: "queued" }, 0);
    for (const r of active) queueDepth.set({ kind: r.kind, status: r.status }, Number(r.n));
    const m = moscowMonth(now);
    llmCost.reset();
    llmCost.set({ month: m.key }, await llmSpentRub(o.db, m.start, m.end));
    llmCap.set(undefined, o.capRub);
    const pending = await o.db
      .selectFrom("platform.founder_reviews")
      .select(sql<string>`count(*)`.as("n"))
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    reviewsPending.set(undefined, Number(pending.n));
    const w = await runFailureWindow(o.db, now);
    finishedHour.set(undefined, w.finished);
    failShare.set(undefined, w.finished > 0 ? w.failed / w.finished : 0);
  };
}

/**
 * Starts the metrics listener of this process; with `db` the database gauges are collected too. Returns a closer.
 * Bind only to a port that NetworkPolicy opens to the observability namespace (helm metrics.port).
 */
export async function startMetricsServer(o: {
  port: number;
  hostname: string;
  db?: Db;
  capRub?: number;
}): Promise<{ port: number; close(): Promise<void> }> {
  const off = o.db ? platformMetrics.collect(collectDbGauges({ db: o.db, capRub: o.capRub ?? 0 })) : () => {};
  const s = await serveMetrics({ registry: platformMetrics, port: o.port, hostname: o.hostname });
  return {
    port: s.port,
    close: async () => {
      off();
      await s.close();
    },
  };
}
