// @wizard/gates — specs/architecture.yaml#interfaces.gates / gate_context, specs/quality/gates.yaml.
import { runG0 } from "./g0/run.js";
import type { GateContext, GateLevel, GateReport } from "./types.js";

export const PACKAGE = "@wizard/gates";

/** G0 check catalog (= gates.yaml#G0.checks: id, severity, since), budget 60 s, target 20 s, milestone order. */
export {
  CHECK_BY_ID,
  type CheckDef,
  compareMilestones,
  G0_CHECKS,
  G0_TARGET_MS,
  G0_TIME_BUDGET_MS,
} from "./catalog.js";
/** G0-IMP-01 allowlist of package specifiers per area (ui / functions). */
export { ALLOWED_PACKAGES } from "./g0/imports.js";
/** Name of the rolled-back shadow schema used by G0-MIG-02: app_<systemKey>_shadow. */
export { shadowSchema } from "./g0/migrations.js";
/** runG0(ctx, {only?, timeBudgetMs?, deps?}); checkFile(path, source, spec?) → G0-IMP-01 + G0-SEC-01 for write_file. */
export { checkFile, type G0Options, runG0, UI_BUNDLE_WARN } from "./g0/run.js";
/** forbidden_api.limits: function source ≤ 200 KB. */
export { FUNCTION_SOURCE_LIMIT } from "./g0/security.js";
/** passed = no blocker with fail/error; summary counts by status. */
export { isPassed, summarize } from "./report.js";
/** GateContext, GateReport, Check, GateLevel, Milestone (gates.yaml#report, architecture.yaml#interfaces.gate_context). */
export type * from "./types.js";

/** runGates(level, ctx) → GateReport. G1 (M0-11) and G2 (M2) are not implemented yet: the report fails with error. */
export async function runGates(level: GateLevel, ctx: GateContext): Promise<GateReport> {
  if (level === "G0") return runG0(ctx);
  const startedAt = (ctx.now ?? new Date()).toISOString();
  return {
    level,
    passed: false,
    specVersion: ctx.specVersion,
    startedAt,
    durationMs: 0,
    checks: [
      {
        id: level,
        status: "error",
        severity: "blocker",
        message_ru: `Не удалось проверить: гейт ${level} ещё не подключён`,
      },
    ],
    summary: { pass: 0, fail: 0, warn: 0, skip: 0, error: 1 },
  };
}
