// Deterministic plan edits (B2-20): the plan screen changes a parameter, a module, a goal, a section or the design
// without a model. The edited plan is scrubbed of PII, validated and compiled again in a fraction of a second — the
// base of the live sketch and of «ткни и скажи». Errors are PlanError in Russian, like validateSystemPlan.
import {
  DESIGN_PINS,
  evalCondition,
  goalIdSchema,
  identSchema,
  MAX_PLAN_GOALS,
  type ModuleManifest,
  type PlanError,
  type PlanErrorCode,
  type PlanSection,
  pointer,
  resolveParams,
  type SystemPlan,
  systemPlanSchema,
} from "@wizard/appspec";
import { type CompileResult, compilePlan, type ModuleRegistry } from "@wizard/modules";
import { scrubJson } from "@wizard/pii";
import { z } from "zod";
import { readySections } from "./catalog.js";

const content = systemPlanSchema.shape.landing.unwrap().shape.sections.element.shape.content;
const design = systemPlanSchema.shape.design;

export const planEditSchema = z.discriminatedUnion("op", [
  /** value null — back to the manifest default. */
  z.strictObject({ op: z.literal("set_param"), module: identSchema, param: identSchema, value: z.unknown() }),
  z.strictObject({
    op: z.literal("add_module"),
    module: identSchema,
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({ op: z.literal("remove_module"), module: identSchema }),
  z.strictObject({
    op: z.literal("set_goals"),
    goals: z
      .array(z.strictObject({ id: goalIdSchema, statement: z.string().trim().min(3).max(200) }))
      .min(1)
      .max(MAX_PLAN_GOALS),
  }),
  z.strictObject({
    op: z.literal("add_section"),
    type: identSchema,
    variant: identSchema.optional(),
    content: content.optional(),
    at: z.number().int().min(0).optional(),
  }),
  /** content keys with null are removed; others replace the value. */
  z.strictObject({
    op: z.literal("update_section"),
    index: z.number().int().min(0),
    variant: identSchema.optional(),
    content: z.record(identSchema, z.union([content.valueType, z.null()])).optional(),
  }),
  z.strictObject({ op: z.literal("remove_section"), index: z.number().int().min(0) }),
  z.strictObject({
    op: z.literal("move_section"),
    from: z.number().int().min(0),
    to: z.number().int().min(0),
  }),
  z.strictObject({
    op: z.literal("set_design"),
    theme: design.shape.theme.optional(),
    accent: design.shape.accent.optional(),
    fontPair: design.shape.fontPair.optional(),
  }),
  z.strictObject({ op: z.literal("remove_out_of_scope"), index: z.number().int().min(0) }),
]);
export type PlanEdit = z.infer<typeof planEditSchema>;
export const planEditsSchema = z.array(planEditSchema).min(1).max(50);

export type EditResult =
  | { ok: true; plan: SystemPlan; compiled: CompileResult & { ok: true } }
  | { ok: false; errors: PlanError[] };

const err = (code: PlanErrorCode, path: PropertyKey[], message: string, allowed?: readonly string[]) => ({
  code,
  path: pointer(path),
  message_ru: message,
  ...(allowed ? { allowed: [...allowed] } : {}),
});

class EditError extends Error {
  constructor(readonly error: PlanError) {
    super(error.message_ru);
  }
}

/** Placeholder content of a ready section: required keys from the plan's niche (the client rewrites them). */
type SectionContent = PlanSection["content"];

function sectionContent(type: string, plan: SystemPlan, registry: ModuleRegistry): SectionContent {
  const spec = readySections(registry).find((s) => s.type === type);
  const out: SectionContent = {};
  for (const k of spec?.required ?? []) {
    if (k === "items") out[k] = ["Пример: первый пункт", "Пример: второй пункт"];
    else if (k === "cta") out[k] = "Связаться";
    else if (k === "title") out[k] = plan.niche.charAt(0).toUpperCase() + plan.niche.slice(1);
    else out[k] = "Пример текста";
  }
  return out;
}

function addModule(
  plan: SystemPlan,
  byId: ReadonlyMap<string, ModuleManifest>,
  id: string,
  params: Record<string, unknown> | undefined,
  registry: ModuleRegistry,
  at: PropertyKey[],
): void {
  const m = byId.get(id);
  if (!m) throw new EditError(err("UNKNOWN_MODULE", at, `Модуля «${id}» нет в каталоге`, [...byId.keys()]));
  if (plan.modules.some((x) => x.id === id))
    throw new EditError(err("DUPLICATE_MODULE", at, `Модуль «${m.name}» уже есть в плане`));
  const planGoals = new Set<string>(plan.goals.map((g) => g.id));
  const goals = m.goals.filter((g) => planGoals.has(g));
  plan.modules.push({ id, ...(params ? { params } : {}), ...(goals.length ? { goals } : {}) });
  if (id === "landing" && !plan.landing) {
    const hero = readySections(registry).find((s) => s.type === "hero");
    if (hero)
      plan.landing = {
        sections: [
          { type: "hero", variant: hero.ready[0] as string, content: sectionContent("hero", plan, registry) },
        ],
      };
  }
  // Required links come with the module (with the parameters they expect), like the planner adds them itself.
  const present = new Set(plan.modules.map((x) => x.id));
  for (const r of m.requires ?? []) {
    if (present.has(r.module) || !evalCondition(r.when, resolveParams(m, params ?? {}), present)) continue;
    addModule(plan, byId, r.module, r.expectParams, registry, at);
    present.add(r.module);
  }
}

function sectionAt(plan: SystemPlan, index: number, at: PropertyKey[]) {
  const s = plan.landing?.sections[index];
  if (!s) throw new EditError(err("SCHEMA_INVALID", at, `Секции №${index + 1} нет на странице`));
  return s;
}

function apply(plan: SystemPlan, e: PlanEdit, i: number, registry: ModuleRegistry): void {
  const byId = new Map(registry.modules.map((d) => [d.manifest.id, d.manifest]));
  const at: PropertyKey[] = ["edits", i];
  switch (e.op) {
    case "set_param": {
      const pm = plan.modules.find((m) => m.id === e.module);
      if (!pm) throw new EditError(err("UNKNOWN_MODULE", at, `Модуля «${e.module}» нет в плане`));
      const m = byId.get(e.module);
      if (m && !m.params.some((p) => p.name === e.param))
        throw new EditError(
          err(
            "PARAMS_INVALID",
            at,
            `У модуля «${m.name}» нет параметра «${e.param}»`,
            m.params.map((p) => p.name),
          ),
        );
      const params = { ...(pm.params ?? {}) };
      if (e.value === null || e.value === undefined) delete params[e.param];
      else params[e.param] = e.value;
      if (Object.keys(params).length) pm.params = params;
      else delete pm.params;
      return;
    }
    case "add_module":
      addModule(plan, byId, e.module, e.params, registry, at);
      return;
    case "remove_module": {
      const idx = plan.modules.findIndex((m) => m.id === e.module);
      if (idx < 0) throw new EditError(err("UNKNOWN_MODULE", at, `Модуля «${e.module}» нет в плане`));
      plan.modules.splice(idx, 1);
      const present = new Set(plan.modules.map((m) => m.id));
      if (e.module === "landing") delete plan.landing;
      else if (plan.landing) {
        // Sections that need the removed module go with it (services → catalog, booking → booking, …).
        const types = new Map(readySections(registry).map((s) => [s.type, s]));
        const sections = plan.landing.sections.filter((s) => {
          const need = types.get(s.type)?.requiresModule;
          return !need || need.some((x) => present.has(x));
        });
        if (sections.length) plan.landing = { sections };
        else delete plan.landing;
      }
      for (const c of plan.custom) if (c.module === e.module) delete c.module;
      for (const o of plan.outOfScope) if (o.module === e.module) delete o.module;
      return;
    }
    case "set_goals": {
      plan.goals = e.goals.map((g) => ({ ...g }));
      const ids = new Set<string>(e.goals.map((g) => g.id));
      for (const pm of plan.modules) {
        if (!pm.goals) continue;
        const kept = pm.goals.filter((g) => ids.has(g));
        if (kept.length) pm.goals = kept;
        else delete pm.goals;
      }
      for (const c of plan.custom) if (c.goal && !ids.has(c.goal)) delete c.goal;
      return;
    }
    case "add_section": {
      const spec = readySections(registry).find((s) => s.type === e.type);
      const variant = e.variant ?? spec?.ready[0] ?? "";
      const section = {
        type: e.type,
        variant,
        content: e.content ?? sectionContent(e.type, plan, registry),
        // A layout the owner chose by hand: the design stage keeps it (B2-37).
        ...(e.variant ? { pinned: true } : {}),
      };
      const sections = [...(plan.landing?.sections ?? [])];
      const footerLast = sections.at(-1)?.type === "footer" ? sections.length - 1 : sections.length;
      sections.splice(Math.min(e.at ?? footerLast, sections.length), 0, section);
      plan.landing = { sections };
      return;
    }
    case "update_section": {
      const s = sectionAt(plan, e.index, at);
      if (e.variant) {
        s.variant = e.variant;
        s.pinned = true;
      }
      for (const [k, v] of Object.entries(e.content ?? {})) {
        if (v === null) delete s.content[k];
        else s.content[k] = v;
      }
      return;
    }
    case "remove_section": {
      sectionAt(plan, e.index, at);
      const sections = (plan.landing?.sections ?? []).filter((_, k) => k !== e.index);
      if (sections.length) plan.landing = { sections };
      else delete plan.landing;
      return;
    }
    case "move_section": {
      const s = sectionAt(plan, e.from, at);
      const sections = (plan.landing?.sections ?? []).filter((_, k) => k !== e.from);
      sections.splice(Math.min(e.to, sections.length), 0, s);
      plan.landing = { sections };
      return;
    }
    case "set_design": {
      if (e.theme) plan.design.theme = e.theme;
      if (e.accent) plan.design.accent = e.accent;
      if (e.fontPair) plan.design.fontPair = { ...e.fontPair };
      // What the owner set by hand stays through the design stage (B2-37).
      const pins = new Set(plan.design.pinned ?? []);
      for (const k of ["theme", "accent", "fontPair"] as const) if (e[k]) pins.add(k);
      if (pins.size) plan.design.pinned = DESIGN_PINS.filter((k) => pins.has(k));
      return;
    }
    case "remove_out_of_scope": {
      if (!plan.outOfScope[e.index])
        throw new EditError(err("SCHEMA_INVALID", at, `Пункта №${e.index + 1} нет в списке «не входит»`));
      plan.outOfScope.splice(e.index, 1);
      return;
    }
  }
}

/**
 * Applies edits in order to a copy of the plan without compiling it (an intermediate plan may not compile yet: the
 * fallback plan of B2-41 is put together from such steps). Any error rejects the whole batch.
 */
export function editPlan(
  plan: SystemPlan,
  edits: readonly PlanEdit[],
  registry: ModuleRegistry,
): { ok: true; plan: SystemPlan } | { ok: false; errors: PlanError[] } {
  const next = structuredClone(plan);
  try {
    edits.forEach((e, i) => {
      apply(next, e, i, registry);
    });
  } catch (e) {
    if (e instanceof EditError) return { ok: false, errors: [e.error] };
    throw e;
  }
  return { ok: true, plan: next };
}

/**
 * Applies edits in order to a copy of the plan, scrubs PII from the texts the client typed, then compiles it
 * (compilePlan validates with requireReady and checks ready section variants). Any error rejects the whole batch.
 */
export function applyPlanEdits(
  plan: SystemPlan,
  edits: readonly PlanEdit[],
  registry: ModuleRegistry,
  opts: { appName?: string } = {},
): EditResult {
  const edited = editPlan(plan, edits, registry);
  if (!edited.ok) return edited;
  // Plan texts reach the model (T1) and the client's screen: no PII (modules.yaml#system_plan.privacy).
  const clean = scrubJson(edited.plan).value;
  const compiled = compilePlan(clean, registry, opts);
  if (!compiled.ok) return { ok: false, errors: compiled.errors };
  // compiled.plan carries the manifest versions it was compiled with (MODULE_VERSION_MISMATCH after a catalog bump).
  return { ok: true, plan: compiled.plan, compiled };
}
