// @wizard/gates — specs/architecture.yaml#interfaces.gates / gate_context, specs/quality/gates.yaml.
import { runG0 } from "./g0/run.js";
import { runG1 } from "./g1/run.js";
import { runG2 } from "./g2/run.js";
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
  G1_CHECKS,
  G1_TIME_BUDGET_MS,
  G2_CHECKS,
  G2_TIME_BUDGET_MS,
} from "./catalog.js";
/** G0-IMP-01 allowlist of package specifiers per area (ui / functions). */
export { ALLOWED_PACKAGES } from "./g0/imports.js";
/** Name of the rolled-back shadow schema used by G0-MIG-02: app_<systemKey>_shadow. */
export { shadowSchema } from "./g0/migrations.js";
/** runG0(ctx, {only?, timeBudgetMs?, deps?}); checkFile(path, source, spec?) → G0-IMP-01 + G0-SEC-01 for write_file. */
export { checkFile, type G0Options, runG0, UI_BUNDLE_WARN } from "./g0/run.js";
/** forbidden_api.limits: function source ≤ 200 KB. */
export { FUNCTION_SOURCE_LIMIT } from "./g0/security.js";
/** G0-SPEC-05: reservedRoute(route, policyPage?) → "login" | "policy" | "system" | null; default policy page /privacy. */
export { DEFAULT_POLICY_PAGE, reservedRoute } from "./g0/spec.js";
/** G1 check sources: PC matrix, G1 selection, consent probes, SC-<AC> (qa.yaml#checks). */
export {
  acceptanceChecks,
  generateConsentChecks,
  generatePermissionChecks,
  selectG1,
} from "./g1/checks.js";
/** M2-19: G1-RENDER-01 in the sandbox — render Worker modules, page-fetch bridge by token, one render over HTTP. */
export { type RenderAnswer, RenderBridge, renderRemote, renderWorkerModules } from "./g1/render/remote.js";
/** runG1(ctx, {timeBudgetMs?, renderTimeoutMs?, onRender?}) incl. G1-RENDER-01 (M1+); g1Checks(spec, qaChecks?) — the checks a G1 run executes. */
export { type G1Options, g1Checks, g1SeedKey, runG1 } from "./g1/run.js";
/** Scenario DSL static validation (qa.yaml#checks.from_acceptance.scenario.validate). */
export { validateScenario } from "./g1/scenario.js";
/** generateSeed(spec, key, {now?, hints?}), the seed DLP and QA seed hints: validateSeedHint, mergeSeedHints (qa.yaml#seed). */
export {
  generateSeed,
  isSyntheticValue,
  mergeSeedHints,
  SEED_HINT_MAX_VALUES,
  type SeedOptions,
  SYNTHETIC_NAMES,
  seedDlp,
  validateSeedHint,
} from "./g1/seed.js";
export type {
  Expect,
  PermissionProbe,
  QaCheck,
  Scenario,
  Seed,
  SeedHint,
  SeedUser,
  Step,
} from "./g1/types.js";
/** G2 test hooks of the runtime part (tampered RLS, runtime/spec drift). */
export type { DynamicOptions } from "./g2/dynamic.js";
/** Antifraud dictionaries (data/*.json from abuse.yaml) and matching: normalize, rx (Unicode \b), findBrands. */
export { ABUSE, BRANDS, type Brand, type BrandHit, findBrands, normalize, rx } from "./g2/patterns.js";
/** ИНН-10/12 checksum (G2-PII-06, INN_INVALID). */
export { innValid, isSubject } from "./g2/pii.js";
/** runG2(ctx, {only?, timeBudgetMs?, dynamic?}): static G2 (secrets, ПДн, Telegram, antifraud, public role) + permission matrix against ctx.runtime. */
export { type G2Options, runG2 } from "./g2/run.js";
/** passed = no blocker with fail/error; summary counts by status. */
export { isPassed, summarize } from "./report.js";
/** GateContext, GateReport, Check, GateLevel, Milestone (gates.yaml#report, architecture.yaml#interfaces.gate_context). */
export type * from "./types.js";

/** runGates(level, ctx) → GateReport (G0, G1 with ctx.runtime, G2 with ctx.runtime for the permission matrix). */
export async function runGates(level: GateLevel, ctx: GateContext): Promise<GateReport> {
  if (level === "G0") return runG0(ctx);
  if (level === "G1") return runG1(ctx);
  return runG2(ctx);
}
