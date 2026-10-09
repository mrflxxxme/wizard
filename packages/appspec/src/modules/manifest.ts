// Module manifest (specs/modules/modules.yaml#manifest): what a front+back module of beta v2 declares — goals it
// closes, parameter schema, links to other modules, parameterised AppSpec fragments, runtime functions, screens,
// goal-panel metrics, goal scenarios for browser e2e and the CI parameter matrix. Data only: the module code lives in
// the repo and is compiled deterministically (B2-11); the planner model never writes manifests.
import { z } from "zod";
import { enumOptionSchema, identSchema, labelSchema } from "../schema.js";
import { type PlanError, planErr, planErrorsFromZod } from "./errors.js";
import { type GoalId, goalIdSchema, goalLabel } from "./goals.js";

const text = (min: number, max: number) => z.string().min(min).max(max);
const anyObject = z.record(z.string(), z.unknown());
const intSchema = z.number().int();
export const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);

function unique<T>(arr: readonly T[], key: (v: T) => string): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const v of arr) {
    const k = key(v);
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
  return dup;
}

// ---------------------------------------------------------------- parameters

/** Field types the plan may add to a module entity through a `fields` parameter (no refs, files, json or tokens). */
export const EXTRA_FIELD_TYPES = [
  "string",
  "text",
  "int",
  "decimal",
  "money",
  "bool",
  "date",
  "datetime",
  "enum",
  "email",
  "phone",
  "url",
  "image",
] as const;

export const extraFieldSchema = z
  .strictObject({
    name: identSchema,
    label: labelSchema,
    type: z.enum(EXTRA_FIELD_TYPES),
    required: z.boolean().optional(),
    options: z.array(enumOptionSchema).min(1).max(12).optional(),
  })
  .refine((f) => (f.type === "enum") === (f.options !== undefined), {
    message: "Варианты (options) задаются только у поля типа enum, и у него обязательны",
  });

export const PARAM_TYPES = [
  "bool",
  "int",
  "enum",
  "enum_list",
  "string",
  "string_list",
  "time",
  "fields",
] as const;
export const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const paramBase = {
  name: identSchema,
  label: labelSchema,
  description: text(1, 300).optional(),
  /** No default and required: the plan must set it. */
  required: z.boolean().optional(),
};

export const paramSpecSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...paramBase, type: z.literal("bool"), default: z.boolean().optional() }),
  z.strictObject({
    ...paramBase,
    type: z.literal("int"),
    min: intSchema.optional(),
    max: intSchema.optional(),
    default: intSchema.optional(),
  }),
  z.strictObject({
    ...paramBase,
    type: z.literal("enum"),
    options: z.array(enumOptionSchema).min(1).max(20),
    default: identSchema.optional(),
  }),
  z.strictObject({
    ...paramBase,
    type: z.literal("enum_list"),
    options: z.array(enumOptionSchema).min(1).max(20),
    minItems: intSchema.min(0).optional(),
    maxItems: intSchema.min(1).optional(),
    default: z.array(identSchema).optional(),
  }),
  z.strictObject({
    ...paramBase,
    type: z.literal("string"),
    maxLength: intSchema.min(1).max(600).optional(),
    default: z.string().optional(),
  }),
  z.strictObject({
    ...paramBase,
    type: z.literal("string_list"),
    maxItems: intSchema.min(1).max(20).optional(),
    maxLength: intSchema.min(1).max(200).optional(),
    default: z.array(z.string()).optional(),
  }),
  z.strictObject({ ...paramBase, type: z.literal("time"), default: z.string().regex(TIME_RE).optional() }),
  z.strictObject({ ...paramBase, type: z.literal("fields"), maxItems: intSchema.min(1).max(8).optional() }),
]);
export type ParamSpec = z.infer<typeof paramSpecSchema>;

/** zod schema of one parameter value. */
export function paramValueSchema(p: ParamSpec): z.ZodType {
  switch (p.type) {
    case "bool":
      return z.boolean();
    case "int": {
      let s = z.number().int();
      if (p.min !== undefined) s = s.min(p.min, `Не меньше ${p.min}`);
      if (p.max !== undefined) s = s.max(p.max, `Не больше ${p.max}`);
      return s;
    }
    case "enum":
      return z.enum(p.options.map((o) => o.value) as [string, ...string[]]);
    case "enum_list":
      return z
        .array(z.enum(p.options.map((o) => o.value) as [string, ...string[]]))
        .min(p.minItems ?? 0)
        .max(p.maxItems ?? p.options.length)
        .refine((a) => new Set(a).size === a.length, { message: "Значения в списке не должны повторяться" });
    case "string":
      return z
        .string()
        .min(1)
        .max(p.maxLength ?? 120);
    case "string_list":
      return z
        .array(
          z
            .string()
            .min(1)
            .max(p.maxLength ?? 120),
        )
        .max(p.maxItems ?? 10)
        .refine((a) => new Set(a).size === a.length, { message: "Значения в списке не должны повторяться" });
    case "time":
      return z.string().regex(TIME_RE, "Время в формате ЧЧ:ММ");
    case "fields":
      return z
        .array(extraFieldSchema)
        .max(p.maxItems ?? 8)
        .refine((a) => new Set(a.map((f) => f.name)).size === a.length, {
          message: "Имена дополнительных полей не должны повторяться",
        });
  }
}

/** Strict zod object of a module's parameters: required ones without default must be present. */
export function paramsSchema(m: Pick<ModuleManifest, "params">): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const p of m.params) {
    const v = paramValueSchema(p);
    shape[p.name] = p.required && !("default" in p && p.default !== undefined) ? v : v.optional();
  }
  return z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
}

/** Parameters with manifest defaults applied (input is assumed valid against paramsSchema). */
export function resolveParams(
  m: Pick<ModuleManifest, "params">,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of m.params) {
    const v = input[p.name] ?? ("default" in p ? p.default : undefined);
    if (v !== undefined) out[p.name] = structuredClone(v);
  }
  return out;
}

// ---------------------------------------------------------------- conditions and fragments

/** Condition on the module's own parameters and/or the presence of another module in the plan. */
export const conditionSchema = z
  .strictObject({
    param: identSchema.optional(),
    equals: z.union([scalarSchema, z.array(scalarSchema).min(1)]).optional(),
    includes: scalarSchema.optional(),
    module: identSchema.optional(),
  })
  .refine((c) => c.param !== undefined || c.module !== undefined, {
    message: "Условие должно ссылаться на параметр (param) или модуль (module)",
  })
  .refine((c) => c.param !== undefined || (c.equals === undefined && c.includes === undefined), {
    message: "equals и includes допустимы только вместе с param",
  });
export type Condition = z.infer<typeof conditionSchema>;

/** Evaluates a condition: param truthy (non-empty list) / equals one of / list includes; module present in the plan. */
export function evalCondition(
  c: Condition | undefined,
  params: Record<string, unknown>,
  present: ReadonlySet<string>,
): boolean {
  if (!c) return true;
  if (c.module !== undefined && !present.has(c.module)) return false;
  if (c.param === undefined) return true;
  const v = params[c.param];
  if (c.equals !== undefined) {
    return Array.isArray(c.equals) ? c.equals.some((e) => e === v) : c.equals === v;
  }
  if (c.includes !== undefined) return Array.isArray(v) && v.includes(c.includes);
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
}

const fragmentItem = z.strictObject({ when: conditionSchema.optional(), value: anyObject });
const entityFragmentItem = z.strictObject({
  when: conditionSchema.optional(),
  entity: identSchema,
  value: anyObject,
});

/**
 * AppSpec fragments with substitutions: a string exactly "{{param}}" becomes the typed parameter value, "…{{param}}…"
 * interpolates it; roles may be symbolic ($public, $owner, $staff, $visitor). Validated as AppSpec after compilation.
 */
export const fragmentsSchema = z.strictObject({
  entities: z.array(fragmentItem).optional(),
  fields: z.array(entityFragmentItem).optional(),
  indexes: z.array(entityFragmentItem).optional(),
  roles: z.array(fragmentItem).optional(),
  permissions: z.array(fragmentItem).optional(),
  workflows: z.array(fragmentItem).optional(),
  integrations: z.array(fragmentItem).optional(),
  acceptance: z.array(fragmentItem).optional(),
});
export type ModuleFragments = z.infer<typeof fragmentsSchema>;

/** Role reference in manifests: symbolic role or a concrete role name. */
export const ROLE_REF_RE = /^(\$(public|owner|staff|visitor)|[a-z][a-z0-9_]{0,39})$/;
const roleRef = z.string().regex(ROLE_REF_RE);

export const moduleFunctionSchema = z.strictObject({
  name: z.string().regex(/^[a-z][A-Za-z0-9]{0,59}$/),
  kind: z.enum(["query", "mutation", "action"]),
  file: z.string().regex(/^functions\/[A-Za-z0-9_/-]+\.ts$/),
  public: z.boolean().optional(),
  roles: z.array(roleRef).optional(),
  when: conditionSchema.optional(),
  purpose: text(3, 200),
  /** AppSpec functions[].systemDbReason: why a public function reads through ctx.systemDb (G2-PERM-05). */
  systemDbReason: z.string().min(10).max(300).optional(),
  /** AppSpec functions[].collectsPii: the arguments carry personal data, a non-admin call needs `_consent` (V3-23). */
  collectsPii: z.boolean().optional(),
});

export const SCREEN_AUDIENCES = ["public", "cabinet", "visitor"] as const;

export const moduleScreenSchema = z.strictObject({
  id: identSchema,
  audience: z.enum(SCREEN_AUDIENCES),
  route: z.string().regex(/^\/[a-z0-9/:_{}-]*$/),
  title: labelSchema,
  roles: z.array(roleRef).min(1),
  /** ui-kit components the screen is built from (names of @wizard/ui-kit exports). */
  components: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]{1,40}$/)).min(1),
  when: conditionSchema.optional(),
  nav: z.boolean().optional(),
});

// ---------------------------------------------------------------- metrics, goal scenarios, tests

const whereSchema = z.record(identSchema, z.union([scalarSchema, z.array(scalarSchema).min(1)]));

/** How a goal-panel metric is computed from the system's data over the period (by dateField). */
export const metricComputeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("count"),
    entity: identSchema,
    dateField: identSchema,
    where: whereSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("ratio"),
    entity: identSchema,
    dateField: identSchema,
    numerator: whereSchema,
    denominator: whereSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("sum"),
    entity: identSchema,
    field: identSchema,
    dateField: identSchema,
    where: whereSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("avg"),
    entity: identSchema,
    field: identSchema,
    dateField: identSchema,
    where: whereSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("repeat_share"),
    entity: identSchema,
    by: identSchema,
    dateField: identSchema,
  }),
  z.strictObject({ kind: z.literal("function"), name: z.string().regex(/^[a-z][A-Za-z0-9]{0,59}$/) }),
]);

export const METRIC_UNITS = ["count", "percent", "rub", "minutes", "days"] as const;

export const metricSchema = z.strictObject({
  id: identSchema,
  label: labelSchema,
  goal: goalIdSchema,
  unit: z.enum(METRIC_UNITS),
  better: z.enum(["up", "down"]),
  period: z.enum(["day", "week", "month"]).optional(),
  compute: metricComputeSchema,
  when: conditionSchema.optional(),
  description: text(1, 300).optional(),
});
export type ModuleMetric = z.infer<typeof metricSchema>;

export const SCENARIO_ACTORS = ["visitor", "client", "owner", "staff", "system"] as const;
export const SCENARIO_EXPECT_KINDS = [
  "page_text",
  "record",
  "status",
  "outbox_email",
  "outbox_telegram",
  "denied",
  "metric",
] as const;

/** Goal scenario: Russian steps for the browser e2e (B2-24 binds them to Playwright) and checkable expectations. */
export const goalScenarioSchema = z.strictObject({
  id: z.string().regex(/^GS-[a-z][a-z0-9_]*-[0-9]{1,2}$/),
  goal: goalIdSchema,
  title: text(3, 140),
  when: conditionSchema.optional(),
  withModules: z.array(identSchema).optional(),
  steps: z
    .array(z.strictObject({ actor: z.enum(SCENARIO_ACTORS), text: text(3, 200) }))
    .min(1)
    .max(15),
  expect: z
    .array(z.strictObject({ kind: z.enum(SCENARIO_EXPECT_KINDS), text: text(3, 200) }))
    .min(1)
    .max(8),
});
export type GoalScenario = z.infer<typeof goalScenarioSchema>;

export const moduleTestsSchema = z.strictObject({
  matrix: z
    .array(
      z.strictObject({
        name: text(1, 80),
        params: anyObject,
        withModules: z.array(identSchema).optional(),
        /**
         * Landing sections of the row's plan instead of the minimal ones (B2-35: every layout variant in CI); checked
         * by validateSystemPlan when the row compiles.
         */
        sections: z.array(anyObject).min(1).max(20).optional(),
        /** Theme preset of the row's plan (default: the first of the catalog). */
        theme: identSchema.optional(),
        /** Stock photos of the row's plan (B2-38 design.photos; checked by validateSystemPlan when the row compiles). */
        photos: z.array(anyObject).min(1).max(12).optional(),
      }),
    )
    .max(32),
  gates: z.array(z.enum(["G0", "G1", "G2"])).min(1),
});

// ---------------------------------------------------------------- manifest

export const MODULE_STATUSES = ["draft", "ready"] as const;
export const MODULE_ORIGINS = ["d75_template", "v1_code", "new"] as const;

export const moduleManifestSchema = z
  .strictObject({
    id: identSchema,
    version: intSchema.min(1),
    name: labelSchema,
    summary: text(1, 300),
    /** draft — only in the catalog spec; ready — code, screens, scenarios and CI matrix exist (B2-13…B2-18). */
    status: z.enum(MODULE_STATUSES),
    /** Tie-breaker of the application order (specs/modules/modules.yaml#compile.order). */
    order: intSchema.min(0).max(999),
    origin: z.strictObject({ kind: z.enum(MODULE_ORIGINS), ref: text(1, 200).optional() }),
    goals: z.array(goalIdSchema).min(1),
    params: z.array(paramSpecSchema).max(24),
    requires: z
      .array(
        z.strictObject({
          module: identSchema,
          reason: text(3, 200),
          when: conditionSchema.optional(),
          expectParams: z.record(identSchema, z.union([scalarSchema, z.array(scalarSchema)])).optional(),
        }),
      )
      .optional(),
    links: z
      .array(
        z.strictObject({ module: identSchema, effect: text(3, 300), fragments: fragmentsSchema.optional() }),
      )
      .optional(),
    conflicts: z.array(z.strictObject({ module: identSchema, reason: text(3, 200) })).optional(),
    /** Names the module owns in the compiled AppSpec (unique across the catalog). */
    provides: z
      .strictObject({
        entities: z.array(identSchema).optional(),
        roles: z.array(identSchema).optional(),
        routes: z.array(z.string().regex(/^\/[a-z0-9/:_{}-]*$/)).optional(),
      })
      .optional(),
    /** The module has compile.ts (pure params → fragments) for what data substitution cannot express. */
    hook: z.boolean().optional(),
    fragments: fragmentsSchema.optional(),
    functions: z.array(moduleFunctionSchema).optional(),
    screens: z.array(moduleScreenSchema).optional(),
    metrics: z.array(metricSchema),
    goalScenarios: z.array(goalScenarioSchema),
    tests: moduleTestsSchema.optional(),
  })
  .superRefine((m, ctx) => {
    const issue = (path: PropertyKey[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const goals = new Set<string>(m.goals);
    for (const d of unique(m.goals, (g) => g)) issue(["goals"], `Цель «${d}» указана дважды`);
    for (const d of unique(m.params, (p) => p.name)) issue(["params"], `Параметр «${d}» объявлен дважды`);
    for (const d of unique(m.metrics, (x) => x.id)) issue(["metrics"], `Метрика «${d}» объявлена дважды`);
    for (const d of unique(m.goalScenarios, (x) => x.id))
      issue(["goalScenarios"], `Сценарий «${d}» объявлен дважды`);
    for (const d of unique(m.screens ?? [], (x) => x.id)) issue(["screens"], `Экран «${d}» объявлен дважды`);
    m.metrics.forEach((x, i) => {
      if (!goals.has(x.goal))
        issue(["metrics", i, "goal"], `Метрика для цели «${goalLabel(x.goal)}», которую модуль не закрывает`);
    });
    m.goalScenarios.forEach((s, i) => {
      if (!goals.has(s.goal))
        issue(
          ["goalScenarios", i, "goal"],
          `Сценарий для цели «${goalLabel(s.goal)}», которую модуль не закрывает`,
        );
      if (!s.id.startsWith(`GS-${m.id}-`))
        issue(["goalScenarios", i, "id"], `Id сценария должен начинаться с GS-${m.id}-`);
    });
    const params = new Set(m.params.map((p) => p.name));
    const condParams = (c: Condition | undefined, path: PropertyKey[]) => {
      if (c?.param !== undefined && !params.has(c.param))
        issue(path, `Условие ссылается на неизвестный параметр «${c.param}»`);
    };
    (m.requires ?? []).forEach((r, i) => {
      condParams(r.when, ["requires", i, "when"]);
    });
    (m.functions ?? []).forEach((f, i) => {
      condParams(f.when, ["functions", i, "when"]);
    });
    (m.screens ?? []).forEach((s, i) => {
      condParams(s.when, ["screens", i, "when"]);
    });
    m.metrics.forEach((x, i) => {
      condParams(x.when, ["metrics", i, "when"]);
    });
    m.goalScenarios.forEach((s, i) => {
      condParams(s.when, ["goalScenarios", i, "when"]);
    });
    if (m.status === "ready") {
      if (!m.fragments) issue(["fragments"], "Готовый модуль (ready) объявляет фрагменты спеки");
      if (!m.screens?.length) issue(["screens"], "Готовый модуль (ready) объявляет экраны");
      if (!m.goalScenarios.length)
        issue(["goalScenarios"], "Готовый модуль (ready) объявляет сценарии целей");
      if (!m.tests?.matrix.length) issue(["tests"], "Готовый модуль (ready) объявляет матрицу параметров CI");
    }
  });
export type ModuleManifest = z.infer<typeof moduleManifestSchema>;

// ---------------------------------------------------------------- catalog

export type CatalogResult = { ok: true; modules: ModuleManifest[] } | { ok: false; errors: PlanError[] };

/**
 * Checks a module catalog: every manifest by schema, unique ids, links to known modules, acyclic `requires`,
 * unique ownership of entities, roles and routes, valid defaults, CI matrix and expectParams against parameter schemas.
 */
export function validateModuleCatalog(input: readonly unknown[]): CatalogResult {
  const errors: PlanError[] = [];
  const modules: ModuleManifest[] = [];
  input.forEach((raw, i) => {
    const r = moduleManifestSchema.safeParse(raw);
    if (r.success) modules.push(r.data);
    else errors.push(...planErrorsFromZod(r.error.issues, [i], "CATALOG_INVALID"));
  });
  if (errors.length) return { ok: false, errors };

  const E = (path: PropertyKey[], msg: string) => errors.push(planErr("CATALOG_INVALID", path, msg));
  const byId = new Map<string, ModuleManifest>();
  modules.forEach((m, i) => {
    if (byId.has(m.id)) E([i, "id"], `Модуль «${m.id}» объявлен дважды`);
    byId.set(m.id, m);
  });
  const owners = new Map<string, string>();
  modules.forEach((m, i) => {
    for (const p of m.params) {
      const def = "default" in p ? p.default : undefined;
      if (def === undefined) continue;
      if (!paramValueSchema(p).safeParse(def).success)
        E([i, "params", p.name], `Значение по умолчанию параметра «${p.name}» не проходит его же схему`);
    }
    const known = (id: string, path: PropertyKey[]) => {
      if (!byId.has(id)) E(path, `Ссылка на неизвестный модуль «${id}»`);
      else if (id === m.id) E(path, "Модуль ссылается сам на себя");
    };
    (m.requires ?? []).forEach((r, k) => {
      known(r.module, [i, "requires", k, "module"]);
      const target = byId.get(r.module);
      if (target && r.expectParams) {
        const shape = paramsSchema(target);
        const probe = shape.safeParse(r.expectParams);
        if (!probe.success)
          E([i, "requires", k, "expectParams"], `expectParams не подходят к параметрам модуля «${r.module}»`);
      }
    });
    (m.links ?? []).forEach((l, k) => {
      known(l.module, [i, "links", k, "module"]);
    });
    (m.conflicts ?? []).forEach((c, k) => {
      known(c.module, [i, "conflicts", k, "module"]);
    });
    m.goalScenarios.forEach((s, k) => {
      for (const [j, w] of (s.withModules ?? []).entries())
        known(w, [i, "goalScenarios", k, "withModules", j]);
    });
    const shape = paramsSchema(m);
    (m.tests?.matrix ?? []).forEach((row, k) => {
      if (!shape.safeParse(row.params).success)
        E([i, "tests", "matrix", k, "params"], `Строка матрицы «${row.name}» не проходит схему параметров`);
      (row.withModules ?? []).forEach((w, j) => {
        known(w, [i, "tests", "matrix", k, "withModules", j]);
      });
    });
    const own = (kind: string, names: readonly string[] | undefined) => {
      for (const n of names ?? []) {
        const key = `${kind}:${n}`;
        const prev = owners.get(key);
        if (prev && prev !== m.id) E([i, "provides", kind], `«${n}» уже принадлежит модулю «${prev}»`);
        owners.set(key, m.id);
      }
    };
    own("entities", m.provides?.entities);
    own("roles", m.provides?.roles);
    own("routes", m.provides?.routes);
  });

  // requires must be acyclic (the application order is a topological sort).
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    state.set(id, 1);
    for (const r of byId.get(id)?.requires ?? []) {
      if (!byId.has(r.module)) continue;
      if (state.get(r.module) === 1) E([], `Цикл обязательных связей: ${[...path, r.module].join(" → ")}`);
      else if (!state.get(r.module)) visit(r.module, [...path, r.module]);
    }
    state.set(id, 2);
  };
  for (const id of byId.keys()) if (!state.get(id)) visit(id, [id]);

  return errors.length ? { ok: false, errors } : { ok: true, modules };
}

/** Goals closed by a set of modules. */
export function goalsOf(modules: readonly Pick<ModuleManifest, "goals">[]): Set<GoalId> {
  return new Set(modules.flatMap((m) => m.goals));
}
