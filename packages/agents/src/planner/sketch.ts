// Sketch of a system for the canvas (B2-20): a light, deterministic description of what the plan compiles to —
// goals → modules → screens, data, roles, landing sections, goal-panel metrics and goal scenarios — so the screen can
// show the system growing with every answer and every edit. Built without models; the full spec and files are
// available separately (compilePlan output).
import { createHash } from "node:crypto";
import { type GoalId, goalLabel, type PlanError, SECTION_CATALOG, type SystemPlan } from "@wizard/appspec";
import { type CompileResult, compiledFingerprint, type ModuleRegistry } from "@wizard/modules";
import { availableModules } from "./catalog.js";
import type { GoalsAnalysis } from "./schemas.js";

export interface PlanSketch {
  /** interview — goals and candidate modules while questions are open; plan — the compiled plan. */
  stage: "interview" | "plan";
  niche: string;
  goals: { id: string; label: string; statement: string; modules: string[] }[];
  modules: {
    id: string;
    name: string;
    summary: string;
    goals: string[];
    /** available — compiles today; soon — draft or needs a draft module. */
    status: "available" | "soon";
    params: { name: string; label: string; value: unknown }[];
  }[];
  roles: { name: string; label: string; access: string }[];
  entities: { name: string; label: string; fields: { name: string; label: string; type: string }[] }[];
  screens: { route: string; title: string; audience: "public" | "cabinet"; roles: string[] }[];
  sections: { index: number; type: string; label: string; variant: string; title?: string }[];
  metrics: { id: string; label: string; goal: string; module: string; unit: string }[];
  scenarios: { id: string; title: string; goal: string; module: string }[];
  outOfScope: { request: string; replacement: string; category: string; module?: string }[];
  custom: { id: string; title: string; kind: string; budgetRub: number }[];
  warnings: string[];
  errors: PlanError[];
  /** sha256 of the compiled spec and files (null until it compiles): the canvas reloads only when it changes. */
  fingerprint: string | null;
}

const sectionLabel = (type: string) => SECTION_CATALOG.find((s) => s.type === type)?.label ?? type;

function moduleRows(
  registry: ModuleRegistry,
  ids: readonly { id: string; params?: Record<string, unknown>; goals?: readonly string[] }[],
): PlanSketch["modules"] {
  const ok = availableModules(registry);
  const byId = new Map(registry.modules.map((d) => [d.manifest.id, d.manifest]));
  return ids.flatMap((pm) => {
    const m = byId.get(pm.id);
    if (!m) return [];
    return [
      {
        id: m.id,
        name: m.name,
        summary: m.summary,
        goals: [...(pm.goals ?? m.goals)],
        status: ok.has(m.id) ? ("available" as const) : ("soon" as const),
        params: m.params.map((p) => ({
          name: p.name,
          label: p.label,
          value: pm.params?.[p.name] ?? ("default" in p ? (p.default ?? null) : null),
        })),
      },
    ];
  });
}

const empty = {
  roles: [],
  entities: [],
  screens: [],
  sections: [],
  metrics: [],
  scenarios: [],
  custom: [],
  warnings: [],
  errors: [],
  fingerprint: null,
} satisfies Partial<PlanSketch>;

/** Sketch while the interview is open: the goals and the modules that would close them. */
export function interviewSketch(analysis: GoalsAnalysis, registry: ModuleRegistry): PlanSketch {
  const modules = moduleRows(
    registry,
    analysis.modules.map((m) => ({ id: m.id })),
  );
  return {
    stage: "interview",
    niche: analysis.niche,
    goals: analysis.goals.map((g) => ({
      id: g.id,
      label: goalLabel(g.id),
      statement: g.statement,
      modules: modules.filter((m) => m.goals.includes(g.id)).map((m) => m.id),
    })),
    modules,
    outOfScope: analysis.outOfScope.map((o) => ({ ...o, replacement: "" })),
    ...empty,
  };
}

/** Sketch of a plan and its compilation (a failed compilation keeps the plan part and lists the errors). */
export function planSketch(plan: SystemPlan, compiled: CompileResult, registry: ModuleRegistry): PlanSketch {
  const modules = moduleRows(registry, plan.modules);
  const planGoals = new Set<string>(plan.goals.map((g) => g.id));
  const covers = (m: PlanSketch["modules"][number], goal: GoalId) =>
    m.goals.includes(goal) && planGoals.has(goal);
  const base: PlanSketch = {
    stage: "plan",
    niche: plan.niche,
    goals: plan.goals.map((g) => ({
      id: g.id,
      label: goalLabel(g.id),
      statement: g.statement,
      modules: modules.filter((m) => covers(m, g.id)).map((m) => m.id),
    })),
    modules,
    ...empty,
    sections: (plan.landing?.sections ?? []).map((s, index) => {
      const title = s.content.title;
      return {
        index,
        type: s.type,
        label: sectionLabel(s.type),
        variant: s.variant,
        ...(typeof title === "string" ? { title } : {}),
      };
    }),
    outOfScope: plan.outOfScope.map((o) => ({ ...o })),
    custom: plan.custom.map((c) => ({ id: c.id, title: c.title, kind: c.kind, budgetRub: c.budgetRub })),
  };
  if (!compiled.ok) return { ...base, errors: compiled.errors };
  const spec = compiled.spec;
  const publicRoles = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  return {
    ...base,
    roles: spec.roles.map((r) => ({ name: r.name, label: r.label, access: r.access })),
    entities: spec.entities.map((e) => ({
      name: e.name,
      label: e.label,
      fields: e.fields.map((f) => ({ name: f.name, label: f.label, type: f.type })),
    })),
    screens: (spec.pages ?? []).map((p) => ({
      route: p.route,
      title: p.title,
      audience: p.roles.some((r) => publicRoles.has(r)) ? ("public" as const) : ("cabinet" as const),
      roles: [...p.roles],
    })),
    metrics: compiled.metrics
      .filter((m) => m.planGoal)
      .map((m) => ({ id: m.id, label: m.label, goal: m.goal, module: m.module, unit: m.unit })),
    scenarios: compiled.scenarios.map((s) => ({ id: s.id, title: s.title, goal: s.goal, module: s.module })),
    warnings: [...compiled.warnings],
    fingerprint: createHash("sha256").update(compiledFingerprint(compiled)).digest("hex"),
  };
}
