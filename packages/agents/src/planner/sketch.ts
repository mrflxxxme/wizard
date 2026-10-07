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
  /** module — the plan module whose manifest declares the route (absent for shared screens). */
  screens: {
    route: string;
    title: string;
    audience: "public" | "cabinet";
    roles: string[];
    module?: string;
  }[];
  sections: { index: number; type: string; label: string; variant: string; title?: string }[];
  metrics: { id: string; label: string; goal: string; module: string; unit: string }[];
  scenarios: { id: string; title: string; goal: string; module: string }[];
  outOfScope: { request: string; replacement: string; category: string; module?: string }[];
  custom: { id: string; title: string; kind: string; budgetRub: number }[];
  /** Business colour of the plan design (#RRGGBB): the canvas takes it over (grill-7 #7); null in the interview. */
  accent: string | null;
  /** Automation chains of the compiled spec for the x-ray layer «Как это работает» (B2-25): trigger → steps. */
  automations: SketchAutomation[];
  /**
   * Who reads which data: one row per role and entity with read access; scope all — every row, own — only the rows
   * of the user ($user in the row filter), some — the rows a filter lets through (e.g. only shown services).
   */
  access: {
    role: string;
    roleLabel: string;
    entity: string;
    entityLabel: string;
    scope: "all" | "own" | "some";
  }[];
  /** How long data is kept: entities with a retention rule. */
  retention: { entity: string; entityLabel: string; days: number; mode: "delete" | "anonymize" }[];
  warnings: string[];
  errors: PlanError[];
  /** sha256 of the compiled spec and files (null until it compiles): the canvas reloads only when it changes. */
  fingerprint: string | null;
}

/** One automation of the sketch: structural, the canvas words it (a workflow of AppSpec without its params). */
export interface SketchAutomation {
  name: string;
  label: string | null;
  module?: string;
  trigger: { type: string; entity?: string; entityLabel?: string; offsetMinutes?: number; cron?: string };
  /** channel — email | telegram of a notify step; to — owner | staff | client. */
  steps: { type: string; entity?: string; entityLabel?: string; channel?: string; to?: string }[];
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
  accent: null,
  automations: [],
  access: [],
  retention: [],
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
    accent: plan.design.accent,
    custom: plan.custom.map((c) => ({ id: c.id, title: c.title, kind: c.kind, budgetRub: c.budgetRub })),
  };
  if (!compiled.ok) return { ...base, errors: compiled.errors };
  const spec = compiled.spec;
  const screenModule = new Map<string, string>();
  for (const pm of plan.modules)
    for (const sc of registry.modules.find((d) => d.manifest.id === pm.id)?.manifest.screens ?? [])
      if (!screenModule.has(sc.route)) screenModule.set(sc.route, pm.id);
  const publicRoles = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  return {
    ...base,
    roles: spec.roles.map((r) => ({ name: r.name, label: r.label, access: r.access })),
    entities: spec.entities.map((e) => ({
      name: e.name,
      label: e.label,
      fields: e.fields.map((f) => ({ name: f.name, label: f.label, type: f.type })),
    })),
    screens: (spec.pages ?? []).map((p) => {
      const module = screenModule.get(p.route);
      return {
        route: p.route,
        title: p.title,
        audience: p.roles.some((r) => publicRoles.has(r)) ? ("public" as const) : ("cabinet" as const),
        roles: [...p.roles],
        ...(module ? { module } : {}),
      };
    }),
    automations: sketchAutomations(spec, workflowModule(plan, registry)),
    access: sketchAccess(spec),
    retention: (spec.entities ?? []).flatMap((e) =>
      e.retention
        ? [
            {
              entity: e.name,
              entityLabel: e.label,
              days: e.retention.deleteAfterDays,
              mode: e.retention.mode ?? ("delete" as const),
            },
          ]
        : [],
    ),
    metrics: compiled.metrics
      .filter((m) => m.planGoal)
      .map((m) => ({ id: m.id, label: m.label, goal: m.goal, module: m.module, unit: m.unit })),
    scenarios: compiled.scenarios.map((s) => ({ id: s.id, title: s.title, goal: s.goal, module: s.module })),
    warnings: [...compiled.warnings],
    fingerprint: createHash("sha256").update(compiledFingerprint(compiled)).digest("hex"),
  };
}

type Spec = Extract<CompileResult, { ok: true }>["spec"];

/**
 * The plan module of a workflow, for anchoring the x-ray chain: the module whose fragments declare it, else the module
 * that provides its trigger entity (workflows of compile hooks, e.g. notify, follow the record they react to).
 */
function workflowModule(
  plan: SystemPlan,
  registry: ModuleRegistry,
): (w: { name: string; entity?: string }) => string | undefined {
  const byName = new Map<string, string>();
  const byEntity = new Map<string, string>();
  for (const pm of plan.modules) {
    const m = registry.modules.find((d) => d.manifest.id === pm.id)?.manifest;
    for (const f of m?.fragments?.workflows ?? []) {
      const name = (f as { value?: { name?: unknown } }).value?.name;
      if (typeof name === "string" && !byName.has(name)) byName.set(name, pm.id);
    }
    for (const e of m?.provides?.entities ?? []) if (!byEntity.has(e)) byEntity.set(e, pm.id);
  }
  return (w) => byName.get(w.name) ?? (w.entity ? byEntity.get(w.entity) : undefined);
}

const recipient = (to: unknown): string | undefined => {
  if (typeof to !== "string") return undefined;
  if (to === "$owner") return "owner";
  if (to.startsWith("$role:")) return "staff";
  if (to.startsWith("$record")) return "client";
  return undefined;
};

function sketchAutomations(
  spec: Spec,
  moduleOf: (w: { name: string; entity?: string }) => string | undefined,
): SketchAutomation[] {
  const label = new Map((spec.entities ?? []).map((e) => [e.name, e.label]));
  const channel = new Map((spec.integrations ?? []).map((i) => [i.name, i.connector]));
  return (spec.workflows ?? []).map((w) => {
    const t = w.trigger;
    const offset = t.relative?.offsetMinutes;
    const module = moduleOf({ name: w.name, ...(t.entity ? { entity: t.entity } : {}) });
    return {
      name: w.name,
      label: w.label ?? null,
      ...(module ? { module } : {}),
      trigger: {
        type: t.type,
        ...(t.entity ? { entity: t.entity, entityLabel: label.get(t.entity) ?? t.entity } : {}),
        ...(typeof offset === "number" ? { offsetMinutes: offset } : {}),
        ...(t.cron ? { cron: t.cron } : {}),
      },
      steps: w.steps.map((st) => {
        const p = (st.params ?? {}) as Record<string, unknown>;
        const entity = typeof p.entity === "string" ? p.entity : undefined;
        const ch = typeof p.integration === "string" ? channel.get(p.integration) : undefined;
        const to = recipient(p.to);
        return {
          type: st.type,
          ...(entity ? { entity, entityLabel: label.get(entity) ?? entity } : {}),
          ...(ch ? { channel: ch } : {}),
          ...(to ? { to } : {}),
        };
      }),
    };
  });
}

function sketchAccess(spec: Spec): PlanSketch["access"] {
  const roles = new Map(spec.roles.map((r) => [r.name, r.label]));
  const entities = new Map((spec.entities ?? []).map((e) => [e.name, e.label]));
  const rows = new Map<string, PlanSketch["access"][number]>();
  for (const p of spec.permissions ?? []) {
    if (!p.ops.includes("read") || !roles.has(p.role) || !entities.has(p.entity)) continue;
    const filtered = p.rowFilter !== undefined && (p.rowFilterOps ?? p.ops).includes("read");
    const scope = !filtered
      ? ("all" as const)
      : Object.values(p.rowFilter ?? {}).some((v) => typeof v === "string" && v.startsWith("$user"))
        ? ("own" as const)
        : ("some" as const);
    const key = `${p.role}/${p.entity}`;
    // Several rules for one pair: the widest one wins (every row over a filtered part).
    if (rows.get(key)?.scope === "all") continue;
    rows.set(key, {
      role: p.role,
      roleLabel: roles.get(p.role) as string,
      entity: p.entity,
      entityLabel: entities.get(p.entity) as string,
      scope,
    });
  }
  return [...rows.values()];
}
