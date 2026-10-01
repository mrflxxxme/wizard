// Gate step persistence: full GateReport → platform.gate_reports and gate_result in the same transaction
// (workflows.yaml#execution.step_rules, db.yaml#gate_reports, L1-11).
import { type Db, json } from "../db/index.js";
import { recordGate } from "../ops/metrics.js";
import { appendEvent, type TxCtx } from "./events.js";
import type { GateReport } from "./types.js";

const MAX_FAILED = 20;

export function gateResultPayload(report: GateReport, revision: number): Record<string, unknown> {
  const failed = report.checks
    .filter((c) => c.status === "fail" || c.status === "error")
    .slice(0, MAX_FAILED)
    .map((c) => ({
      id: c.id,
      message_ru: c.message_ru,
      ...(c.file !== undefined ? { file: c.file } : {}),
      ...(c.line !== undefined ? { line: c.line } : {}),
    }));
  return {
    level: report.level,
    passed: report.passed,
    revision,
    ...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
    failedChecks: failed,
    totalChecks: report.checks.length,
  };
}

export async function recordGateReport(
  t: TxCtx,
  a: { runId: string; systemId: string; revision: number; report: GateReport },
): Promise<void> {
  await t.trx
    .insertInto("platform.gate_reports")
    .values({
      run_id: a.runId,
      system_id: a.systemId,
      revision: a.revision,
      level: a.report.level,
      passed: a.report.passed,
      report: json(a.report),
    })
    .onConflict((oc) =>
      oc.columns(["run_id", "level", "revision"]).doUpdateSet({
        passed: a.report.passed,
        report: json(a.report),
      }),
    )
    .execute();
  if (a.report.level === "G0") {
    await t.trx
      .updateTable("platform.revisions")
      .set({ g0_passed: a.report.passed })
      .where("system_id", "=", a.systemId)
      .where("version", "=", a.revision)
      .execute();
  }
  await appendEvent(t, a.runId, "gate_result", gateResultPayload(a.report, a.revision));
  t.after?.push(() => recordGate(a.report));
}

/** GET /systems/:id/gates/latest: per level the row with max(revision). */
export async function latestGateReports(db: Db, systemId: string) {
  return db
    .selectFrom("platform.gate_reports")
    .selectAll()
    .distinctOn("level")
    .where("system_id", "=", systemId)
    .orderBy("level")
    .orderBy("revision", "desc")
    .orderBy("created_at", "desc")
    .execute();
}
