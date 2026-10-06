// A stored plan as the plan screen and the canvas see it (B2-20): compiled again on every read — deterministic and fast —
// with its errors and sketch, plus the credits cap of its build (D76 (9): ≤ 15 ₽ a build, custom code on top).
import { type PlanError, type SystemPlan, systemPlanSchema } from "@wizard/appspec";
import { type CompileResult, compilePlan, type ModuleRegistry } from "@wizard/modules";
import { DEFAULT_REGISTRY } from "./catalog.js";
import { type PlanSketch, planSketch } from "./sketch.js";

export type { CompileResult, CompileSuccess, ModuleRegistry } from "@wizard/modules";

export interface PlanView {
  compiled: CompileResult;
  /** null — the stored JSON is not a SystemPlan at all (never written by the platform). */
  sketch: PlanSketch | null;
  errors: PlanError[];
}

/** Compiles a stored plan and builds its sketch. */
export function viewPlan(
  plan: unknown,
  registry: ModuleRegistry = DEFAULT_REGISTRY,
  opts: { appName?: string } = {},
): PlanView {
  const compiled = compilePlan(plan, registry, opts);
  const parsed = compiled.ok ? compiled.plan : systemPlanSchema.safeParse(plan).data;
  return {
    compiled,
    sketch: parsed ? planSketch(parsed, compiled, registry) : null,
    errors: compiled.ok ? [] : compiled.errors,
  };
}

/** Rubles per credit (models.yaml#credits.rub_per_credit). */
const RUB_PER_CREDIT = 5;
/** Target cost of a build without custom code (grill-6 № 9). */
export const PLAN_BUILD_TARGET_RUB = 15;

/** Credits cap of a build by an approved plan: the target plus the custom-code budget of the plan. */
export function planBuildCapCredits(plan: Pick<SystemPlan, "custom">): number {
  const custom = plan.custom.reduce((s, c) => s + c.budgetRub, 0);
  return Math.ceil((PLAN_BUILD_TARGET_RUB + custom) / RUB_PER_CREDIT);
}
