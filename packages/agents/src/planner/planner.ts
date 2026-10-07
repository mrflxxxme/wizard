// System planner (B2-20, modules.yaml#ai_rules.tool, models.yaml routes.system_plan): one structured call submit_plan →
// validateSystemPlan(requireReady) and ready section variants, the errors go back to the model (≤ 2 repairs,
// call_policy); then compilePlan — compilation errors (MODULE_CONFLICT, SECTION_NOT_IMPLEMENTED, …) go back once more.
// The plan never carries PII: the router scrubs what goes to T1, and the plan itself is scrubbed before it is kept.
import { type PlanError, SECTION_CATALOG, type SystemPlan, validateSystemPlan } from "@wizard/appspec";
import {
  type CompileResult,
  compilePlan,
  type ModuleRegistry,
  planCatalog,
  unimplementedSections,
} from "@wizard/modules";
import { scrubJson } from "@wizard/pii";
import { type CallBase, type CallStats, callTool } from "../core/loop.js";
import { defineTool, type ToolIssue } from "../core/tool.js";
import { defaultDesign } from "./catalog.js";
import { type PlannerPromptInput, plannerMessages } from "./prompt.js";
import { type PlannerPlan, plannerPlanSchema } from "./schemas.js";
import { normalizePlanArgs } from "./tolerant.js";

/** Repairs after validation errors (models.yaml#call_policy.structured_output). */
export const PLAN_VALIDATION_REPAIRS = 2;
/** Extra planner calls after compilation errors. */
export const PLAN_COMPILE_REPAIRS = 1;

export type PlannerResult =
  | {
      ok: true;
      plan: SystemPlan;
      /** Compilation of the final plan; errors here mean the repairs ran out — the client sees them on the plan screen. */
      compiled: CompileResult;
      stats: CallStats;
    }
  | { ok: false; issues: ToolIssue[]; stats: CallStats };

/** PlanError → ToolIssue for the model: the Russian message with allowed values and the hint. */
export function planIssues(errors: readonly PlanError[]): ToolIssue[] {
  return errors.map((e) => ({
    path: e.path,
    code: e.code,
    message: [
      e.message_ru,
      e.allowed?.length ? `допустимо: ${e.allowed.slice(0, 30).join(", ")}` : "",
      e.hint ?? "",
    ]
      .filter(Boolean)
      .join(". "),
  }));
}

/**
 * The submitted plan as SystemPlan: the default design when the planner gives none (the design stage of the build sets
 * the direction, B2-37), PII scrubbed from every text. Pins are the owner's (plan edits): a model never sets them.
 */
export function finalizePlan(v: PlannerPlan, registry: ModuleRegistry): SystemPlan {
  const { pinned: _p, ...design } = v.design ?? defaultDesign(registry);
  const plan: SystemPlan = {
    ...v,
    design,
    ...(v.landing ? { landing: { sections: v.landing.sections.map(({ pinned: _s, ...s }) => s) } } : {}),
  };
  return scrubJson(plan).value;
}

/** Validation the planner must pass before compilation: requireReady and ready section variants only. */
export function planErrors(plan: SystemPlan, registry: ModuleRegistry): PlanError[] {
  const v = validateSystemPlan(plan, planCatalog(registry), { requireReady: true });
  // Both at once: the model fixes every problem in one repair.
  return [...(v.ok ? [] : v.errors), ...unimplementedSections(plan, registry.sections ?? SECTION_CATALOG)];
}

const addStats = (a: CallStats, b: CallStats): CallStats => ({
  calls: a.calls + b.calls,
  creditsCharged: Math.round((a.creditsCharged + b.creditsCharged) * 1000) / 1000,
  ruFallback: a.ruFallback || b.ruFallback,
});

export interface RunPlannerOptions {
  registry: ModuleRegistry;
  /** Name of the system for the compiled spec (default — the niche). */
  appName?: string;
}

/** Plans a system from the interview: SystemPlan valid for the catalog and, unless the repairs ran out, compiled. */
export async function runPlanner(
  base: Omit<CallBase, "callType">,
  input: PlannerPromptInput,
  o: RunPlannerOptions,
): Promise<PlannerResult> {
  const tool = defineTool({
    name: "submit_plan",
    description:
      "System plan: goals, catalog modules with params, landing sections, out of scope with replacements, small custom code.",
    input: plannerPlanSchema,
    // B2-41: a plan sent as text, wrapped in {plan: …} or with unknown top-level keys is read without a repair call.
    normalize: normalizePlanArgs,
    check: (v) => planIssues(planErrors(finalizePlan(v, o.registry), o.registry)),
  });
  const call = { ...base, callType: "system_plan" as const };
  const first = await callTool({
    ...call,
    messages: plannerMessages(o.registry, input),
    tool,
    maxRepairs: PLAN_VALIDATION_REPAIRS,
    textArgs: true,
  });
  let stats = first.stats;
  if (!first.ok) return { ok: false, issues: first.issues, stats };
  let plan = finalizePlan(first.value, o.registry);
  let compiled = compilePlan(plan, o.registry, o.appName ? { appName: o.appName } : {});
  let messages = first.messages;
  for (let n = 0; !compiled.ok && n < PLAN_COMPILE_REPAIRS; n++) {
    const issues = planIssues(compiled.errors);
    messages = [
      ...messages,
      {
        role: "user",
        content: `План не собирается:\n${issues.map((i) => `- ${i.path}: ${i.message}`).join("\n")}\nИсправь эти ошибки и вызови submit_plan снова с полным планом.`,
      },
    ];
    // Own step name: durable steps are memoized by name (workflows.yaml#execution.step_rules).
    const stepName = `${base.stepName ?? "system_plan"}:compile_fix${n + 1}`;
    const again = await callTool({ ...call, stepName, messages, tool, maxRepairs: 0, textArgs: true });
    stats = addStats(stats, again.stats);
    if (!again.ok) break;
    messages = again.messages;
    plan = finalizePlan(again.value, o.registry);
    compiled = compilePlan(plan, o.registry, o.appName ? { appName: o.appName } : {});
  }
  return { ok: true, plan: compiled.ok ? compiled.plan : plan, compiled, stats };
}
