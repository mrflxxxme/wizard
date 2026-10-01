// Periodic founder alerts of the platform (M2-09; deploy.yaml#cloud.observability.alerts «run failed rate > 20% за
// 1 ч»): every few minutes (worker DBOS schedule wizard.ops_checks, or the in-process timer of platform-api without
// DBOS) the share of failed runs among runs finished in the last hour is checked; above the threshold the founder gets
// one alert per clock hour (db.yaml#ops_alerts key run_fail_rate:<yyyy-mm-ddThh>, ops/alert.ts alertOnce). A minimum
// sample keeps one failed build out of two from paging anyone. The LLM cap alerts live in billing/llm-cap.ts.
import type { Db } from "../db/index.js";
import { alertOnce, type OpsAlertFn } from "./alert.js";
import { runFailureWindow } from "./metrics.js";

/** deploy.yaml#cloud.observability.alerts: failed share above this over the last hour. */
export const RUN_FAIL_RATE_THRESHOLD = 0.2;
/** Fewer finished runs in the hour than this — no alert (noise). */
export const RUN_FAIL_RATE_MIN_RUNS = 5;

export interface OpsCheckResult {
  failed: number;
  finished: number;
  alerted: boolean;
}

/** One pass of the run failure-rate check. */
export async function checkRunFailureRate(
  db: Db,
  alert: OpsAlertFn,
  now: Date = new Date(),
): Promise<OpsCheckResult> {
  const w = await runFailureWindow(db, now);
  const share = w.finished > 0 ? w.failed / w.finished : 0;
  if (w.finished < RUN_FAIL_RATE_MIN_RUNS || share <= RUN_FAIL_RATE_THRESHOLD)
    return { ...w, alerted: false };
  const alerted = await alertOnce(db, `run_fail_rate:${now.toISOString().slice(0, 13)}`, alert, {
    level: "error",
    event: "run_failure_rate_high",
    text: `Wizard: за последний час упало ${w.failed} из ${w.finished} прогонов (${Math.round(100 * share)} %, порог ${Math.round(100 * RUN_FAIL_RATE_THRESHOLD)} %). Проверьте журнал прогонов и логи воркера.`,
    fields: { code: "RUN_FAILURE_RATE", count: w.failed, rows: w.finished },
  });
  return { ...w, alerted };
}
