// SystemPlan (specs/modules/modules.yaml#system_plan): the only thing the planner model writes in beta v2 — goals,
// catalog modules with parameters, landing sections, design direction, what is out of scope and small custom code
// within the D76 limits. Data only; B2-11 compiles it into AppSpec and code without models.
import { z } from "zod";
import { identSchema, THEME_FONTS, THEME_PRESETS } from "../schema.js";
import { type PlanError, planErr, planErrorsFromZod } from "./errors.js";
import { type GoalId, goalIdSchema, goalLabel } from "./goals.js";
import { evalCondition, type ModuleManifest, paramsSchema, resolveParams } from "./manifest.js";
import { SECTION_CATALOG, type SectionTypeSpec } from "./sections.js";

const text = (min: number, max: number) => z.string().min(min).max(max);

/** Hard limits of custom code (product.yaml#decisions.D76_beta_v2 (2)): screens, functions, rubles, fix rounds. */
export const CUSTOM_LIMITS = { screens: 2, functions: 3, budgetRub: 20, rounds: 2 } as const;
/** At most this many goals in a plan (D76 (4)). */
export const MAX_PLAN_GOALS = 3;

export const OUT_OF_SCOPE_CATEGORIES = [
  "payments",
  "events",
  "integration",
  "mobile_app",
  "ai",
  "marketplace",
  "custom_logic",
  "other",
] as const;

export const sectionContentValueSchema = z.union([
  text(1, 600),
  z.array(z.union([text(1, 300), z.record(identSchema, text(0, 600))])).max(12),
]);

export const planSectionSchema = z.strictObject({
  type: identSchema,
  variant: identSchema,
  content: z.record(identSchema, sectionContentValueSchema),
  anchor: identSchema.optional(),
});

export const designSchema = z.strictObject({
  /** Free mood fields of the design direction (B2-37 fills them). */
  direction: z.strictObject({
    mood: z.array(text(2, 30)).min(1).max(5),
    rhythm: z.enum(["airy", "balanced", "dense"]).optional(),
    notes: text(1, 400).optional(),
  }),
  theme: identSchema,
  accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  fontPair: z.strictObject({ heading: text(1, 40), body: text(1, 40) }),
  photoStyle: text(3, 160),
});

export const systemPlanSchema = z
  .strictObject({
    version: z.literal(1),
    niche: text(2, 80),
    goals: z
      .array(z.strictObject({ id: goalIdSchema, statement: text(3, 200) }))
      .min(1)
      .max(MAX_PLAN_GOALS),
    modules: z
      .array(
        z.strictObject({
          id: identSchema,
          /** Manifest version the plan was made for (the compiler writes it; plan migration comes later). */
          version: z.number().int().min(1).optional(),
          params: z.record(z.string(), z.unknown()).optional(),
          goals: z.array(goalIdSchema).max(MAX_PLAN_GOALS).optional(),
          note: text(1, 200).optional(),
        }),
      )
      .min(1)
      .max(16),
    landing: z.strictObject({ sections: z.array(planSectionSchema).min(1).max(20) }).optional(),
    design: designSchema,
    outOfScope: z
      .array(
        z.strictObject({
          request: text(3, 300),
          replacement: text(3, 300),
          category: z.enum(OUT_OF_SCOPE_CATEGORIES),
          module: identSchema.optional(),
        }),
      )
      .max(20),
    custom: z
      .array(
        z.strictObject({
          id: identSchema,
          title: text(3, 80),
          kind: z.enum(["screen", "function"]),
          description: text(10, 600),
          budgetRub: z.number().positive().max(CUSTOM_LIMITS.budgetRub),
          module: identSchema.optional(),
          goal: goalIdSchema.optional(),
        }),
      )
      .max(CUSTOM_LIMITS.screens + CUSTOM_LIMITS.functions),
  })
  .superRefine((p, ctx) => {
    const limit = (message: string) =>
      ctx.addIssue({
        code: "custom",
        path: ["custom"],
        message,
        params: { planCode: "CUSTOM_LIMIT_EXCEEDED" },
      });
    const screens = p.custom.filter((c) => c.kind === "screen").length;
    const functions = p.custom.filter((c) => c.kind === "function").length;
    const budget = Math.round(p.custom.reduce((s, c) => s + c.budgetRub, 0) * 100) / 100;
    if (screens > CUSTOM_LIMITS.screens)
      limit(`Дописывание кодом: не больше ${CUSTOM_LIMITS.screens} экранов, в плане ${screens}`);
    if (functions > CUSTOM_LIMITS.functions)
      limit(`Дописывание кодом: не больше ${CUSTOM_LIMITS.functions} функций, в плане ${functions}`);
    if (budget > CUSTOM_LIMITS.budgetRub)
      limit(`Бюджет дописывания ${budget} ₽ больше лимита ${CUSTOM_LIMITS.budgetRub} ₽`);
    const ids = p.custom.map((c) => c.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["custom"], message: "Id доработок не должны повторяться" });
  });
export type SystemPlan = z.infer<typeof systemPlanSchema>;
export type PlanSection = z.infer<typeof planSectionSchema>;

export interface ModuleCatalog {
  modules: readonly ModuleManifest[];
  /** Theme preset ids (default: THEME_PRESETS; B2-36 extends to 8–10). */
  themes?: readonly string[];
  /** Font families (default: THEME_FONTS, D64 catalog). */
  fonts?: readonly string[];
  /** Landing section types (default: SECTION_CATALOG; B2-35 extends). */
  sections?: readonly SectionTypeSpec[];
}

export interface ValidatePlanOptions {
  /** Reject draft modules (the compiler sets it; the plan screen does not). */
  requireReady?: boolean;
}

export type ValidatePlanResult =
  | { ok: true; plan: SystemPlan; params: Record<string, Record<string, unknown>> }
  | { ok: false; errors: PlanError[] };

/**
 * Validates a SystemPlan against the module catalog: schema, known modules and their parameters, required links and
 * conflicts, goal coverage, custom limits, landing sections and design references. Errors are in Russian.
 */
export function validateSystemPlan(
  input: unknown,
  catalog: ModuleCatalog,
  opts: ValidatePlanOptions = {},
): ValidatePlanResult {
  const parsed = systemPlanSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: planErrorsFromZod(parsed.error.issues) };
  const plan = parsed.data;
  const errors: PlanError[] = [];
  const byId = new Map(catalog.modules.map((m) => [m.id, m]));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const planGoals = new Set<string>(plan.goals.map((g) => g.id));
  const present = new Set(plan.modules.map((m) => m.id));

  // goals
  const seenGoals = new Set<string>();
  plan.goals.forEach((g, i) => {
    if (seenGoals.has(g.id))
      errors.push(planErr("DUPLICATE_GOAL", ["goals", i, "id"], `Цель «${goalLabel(g.id)}» указана дважды`));
    seenGoals.add(g.id);
  });

  // modules and parameters
  const params: Record<string, Record<string, unknown>> = {};
  const seenModules = new Set<string>();
  plan.modules.forEach((pm, i) => {
    const m = byId.get(pm.id);
    if (!m) {
      errors.push(
        planErr("UNKNOWN_MODULE", ["modules", i, "id"], `Модуля «${pm.id}» нет в каталоге`, {
          allowed: [...byId.keys()],
          hint: "То, чего нет в каталоге, — в outOfScope с заменой или в custom в пределах лимита",
        }),
      );
      return;
    }
    if (seenModules.has(pm.id)) {
      errors.push(
        planErr("DUPLICATE_MODULE", ["modules", i, "id"], `Модуль «${m.name}» указан в плане дважды`),
      );
      return;
    }
    seenModules.add(pm.id);
    if (pm.version !== undefined && pm.version !== m.version)
      errors.push(
        planErr(
          "MODULE_VERSION_MISMATCH",
          ["modules", i, "version"],
          `План составлен для версии ${pm.version} модуля «${m.name}», а в каталоге версия ${m.version}; перенос планов между версиями ещё не реализован`,
          { hint: "Составьте план заново по текущему каталогу" },
        ),
      );
    if (opts.requireReady && m.status !== "ready")
      errors.push(
        planErr("MODULE_NOT_READY", ["modules", i, "id"], `Модуль «${m.name}» ещё не готов к сборке`),
      );
    const r = paramsSchema(m).safeParse(pm.params ?? {});
    if (!r.success) {
      errors.push(
        ...planErrorsFromZod(r.error.issues, ["modules", i, "params"], "PARAMS_INVALID").map((e) => ({
          ...e,
          message_ru: `Модуль «${m.name}»: ${e.message_ru}`,
        })),
      );
      return;
    }
    params[pm.id] = resolveParams(m, r.data);
    for (const [k, g] of (pm.goals ?? []).entries()) {
      if (!planGoals.has(g))
        errors.push(
          planErr(
            "GOAL_NOT_IN_PLAN",
            ["modules", i, "goals", k],
            `Цели «${goalLabel(g)}» нет среди целей плана`,
          ),
        );
      else if (!m.goals.includes(g))
        errors.push(
          planErr(
            "GOAL_NOT_COVERED",
            ["modules", i, "goals", k],
            `Модуль «${m.name}» не закрывает цель «${goalLabel(g)}»`,
            {
              allowed: m.goals.map(String),
            },
          ),
        );
    }
  });

  // required links and conflicts (only between known modules with valid parameters)
  const conflictPairs = new Set<string>();
  plan.modules.forEach((pm, i) => {
    const m = byId.get(pm.id);
    const own = params[pm.id];
    if (!m || !own) return;
    for (const req of m.requires ?? []) {
      if (!evalCondition(req.when, own, present)) continue;
      if (!present.has(req.module)) {
        errors.push(
          planErr(
            "MISSING_REQUIRED_MODULE",
            ["modules", i, "id"],
            `Модулю «${m.name}» нужен модуль «${name(req.module)}»: ${req.reason}`,
            { hint: `Добавьте в план модуль «${req.module}» или уберите «${m.id}»` },
          ),
        );
        continue;
      }
      const target = params[req.module];
      for (const [k, want] of Object.entries(req.expectParams ?? {})) {
        if (target && JSON.stringify(target[k]) !== JSON.stringify(want)) {
          const j = plan.modules.findIndex((x) => x.id === req.module);
          errors.push(
            planErr(
              "REQUIRED_PARAMS_MISMATCH",
              ["modules", j, "params", k],
              `Модулю «${m.name}» нужен параметр «${k}» = ${JSON.stringify(want)} у модуля «${name(req.module)}»: ${req.reason}`,
            ),
          );
        }
      }
    }
    for (const c of m.conflicts ?? []) {
      const pair = [m.id, c.module].sort().join("+");
      if (!present.has(c.module) || conflictPairs.has(pair)) continue;
      conflictPairs.add(pair);
      errors.push(
        planErr(
          "MODULE_CONFLICT",
          ["modules", i, "id"],
          `Модули «${m.name}» и «${name(c.module)}» несовместимы: ${c.reason}`,
        ),
      );
    }
  });

  // every plan goal is closed by at least one module
  const closed = new Set<GoalId>(plan.modules.flatMap((pm) => byId.get(pm.id)?.goals ?? []));
  plan.goals.forEach((g, i) => {
    if (!closed.has(g.id))
      errors.push(
        planErr(
          "GOAL_NOT_COVERED",
          ["goals", i, "id"],
          `Цель «${goalLabel(g.id)}» не закрыта ни одним модулем плана`,
          { hint: "Добавьте модуль, который её закрывает, или уберите цель" },
        ),
      );
  });

  errors.push(...landingErrors(plan, present, catalog));

  // design references
  const themes = catalog.themes ?? THEME_PRESETS;
  if (!themes.includes(plan.design.theme))
    errors.push(
      planErr("UNKNOWN_THEME", ["design", "theme"], `Темы «${plan.design.theme}» нет в каталоге тем`, {
        allowed: themes,
      }),
    );
  const fonts: readonly string[] = catalog.fonts ?? THEME_FONTS;
  for (const k of ["heading", "body"] as const) {
    if (!fonts.includes(plan.design.fontPair[k]))
      errors.push(
        planErr(
          "UNKNOWN_FONT",
          ["design", "fontPair", k],
          `Шрифта «${plan.design.fontPair[k]}» нет в каталоге`,
          {
            allowed: fonts,
          },
        ),
      );
  }

  // out of scope and custom references
  plan.outOfScope.forEach((o, i) => {
    if (o.module !== undefined && !byId.has(o.module))
      errors.push(
        planErr(
          "UNKNOWN_MODULE",
          ["outOfScope", i, "module"],
          `Замена ссылается на модуль «${o.module}», которого нет в каталоге`,
        ),
      );
  });
  plan.custom.forEach((c, i) => {
    if (c.module !== undefined && !present.has(c.module))
      errors.push(
        planErr(
          "UNKNOWN_MODULE",
          ["custom", i, "module"],
          `Доработка «${c.title}» ссылается на модуль «${c.module}», которого нет в плане`,
        ),
      );
    if (c.goal !== undefined && !planGoals.has(c.goal))
      errors.push(
        planErr(
          "GOAL_NOT_IN_PLAN",
          ["custom", i, "goal"],
          `Цели «${goalLabel(c.goal)}» нет среди целей плана`,
        ),
      );
  });

  return errors.length ? { ok: false, errors } : { ok: true, plan, params };
}

const LANDING_MODULE = "landing";

function landingErrors(plan: SystemPlan, present: ReadonlySet<string>, catalog: ModuleCatalog): PlanError[] {
  const errors: PlanError[] = [];
  const hasModule = present.has(LANDING_MODULE);
  if (hasModule && !plan.landing)
    errors.push(
      planErr("LANDING_MISMATCH", ["landing"], "В плане есть модуль «Секции лендинга», но нет секций"),
    );
  if (!hasModule && plan.landing)
    errors.push(
      planErr("LANDING_MISMATCH", ["landing"], "Секции лендинга заданы, но модуля «landing» нет в плане"),
    );
  if (!plan.landing) return errors;

  const types = new Map((catalog.sections ?? SECTION_CATALOG).map((s) => [s.type, s]));
  const sections = plan.landing.sections;
  const counts = new Map<string, number>();
  sections.forEach((s, i) => {
    const base = ["landing", "sections", i];
    const t = types.get(s.type);
    if (!t) {
      errors.push(
        planErr("UNKNOWN_SECTION", [...base, "type"], `Секции «${s.type}» нет в библиотеке`, {
          allowed: [...types.keys()],
        }),
      );
      return;
    }
    counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
    if (!t.variants.includes(s.variant))
      errors.push(
        planErr(
          "UNKNOWN_VARIANT",
          [...base, "variant"],
          `У секции «${t.label}» нет варианта «${s.variant}»`,
          {
            allowed: t.variants,
          },
        ),
      );
    const keys = new Set([...t.required, ...t.optional]);
    for (const k of Object.keys(s.content)) {
      if (!keys.has(k))
        errors.push(
          planErr(
            "SECTION_CONTENT_INVALID",
            [...base, "content", k],
            `В секции «${t.label}» нет поля «${k}»`,
            {
              allowed: [...keys],
            },
          ),
        );
    }
    for (const k of t.required) {
      if (!(k in s.content))
        errors.push(
          planErr(
            "SECTION_CONTENT_INVALID",
            [...base, "content", k],
            `В секции «${t.label}» не заполнено поле «${k}»`,
          ),
        );
    }
    if (t.requiresModule && !t.requiresModule.some((m) => present.has(m)))
      errors.push(
        planErr(
          "SECTION_NEEDS_MODULE",
          [...base, "type"],
          `Секции «${t.label}» нужен модуль ${t.requiresModule.map((m) => `«${m}»`).join(" или ")}`,
        ),
      );
    if (t.position === "first" && i !== 0)
      errors.push(planErr("SECTION_ORDER", base, `Секция «${t.label}» должна быть первой`));
    if (t.position === "last" && i !== sections.length - 1)
      errors.push(planErr("SECTION_ORDER", base, `Секция «${t.label}» должна быть последней`));
    if (t.unique && (counts.get(s.type) ?? 0) > 1)
      errors.push(planErr("SECTION_ORDER", base, `Секция «${t.label}» может быть на странице только одна`));
  });
  if (types.has("hero") && !counts.has("hero"))
    errors.push(
      planErr("SECTION_REQUIRED", ["landing", "sections"], "На лендинге нужен первый экран (hero)"),
    );
  return errors;
}
