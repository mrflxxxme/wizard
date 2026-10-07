// B2-10: module manifests and SystemPlan (specs/modules/modules.yaml). The spec's draft catalog is parsed by the same
// zod schemas, so the spec and the code cannot drift apart.
import { describe, expect, test } from "vitest";
import {
  CUSTOM_LIMITS,
  evalCondition,
  GOALS,
  isReservedName,
  type ModuleCatalog,
  type ModuleManifest,
  PLAN_ERROR_CODES,
  type PlanErrorCode,
  paramsSchema,
  SECTION_CATALOG,
  validateModuleCatalog,
  validateSystemPlan,
} from "../src/index.js";
import { repoRoot } from "./helpers.js";

interface ModulesDoc {
  goals: { items: { id: string; label: string }[] };
  sections: { types: { type: string; variants: string[] }[] };
  system_plan: { custom_limits: { screens: number; functions: number; budget_rub: number; rounds: number } };
  validation: { codes: Record<string, string> };
  catalog: unknown[];
}

// @ts-expect-error — plain ESM module without types
const { parseYamlFiles } = await import("../../../tools/specs/validate.mjs");
const specPath = `${repoRoot}specs/modules/modules.yaml`;
const loaded = (parseYamlFiles([specPath]) as Record<string, { ok?: ModulesDoc; error?: string }>)[specPath];
if (!loaded?.ok) throw new Error(`modules.yaml: ${loaded?.error}`);
const doc = loaded.ok;

const catalogResult = validateModuleCatalog(doc.catalog);
const modules: ModuleManifest[] = catalogResult.ok ? catalogResult.modules : [];
const catalog: ModuleCatalog = { modules };

const BETA_V2_MODULES = [
  "landing",
  "catalog",
  "leads",
  "booking",
  "notify",
  "client_card",
  "deals",
  "staff",
  "reports",
  "visitor_cabinet",
  "packages",
  "resources",
];

/** Dental clinic: booking + client_card + notify + reports + landing (catalog is required by booking). */
function dentalPlan() {
  return {
    version: 1,
    niche: "стоматологическая клиника",
    goals: [
      { id: "fill_schedule", statement: "Пациенты сами записываются онлайн, кресла не простаивают" },
      { id: "reduce_no_shows", statement: "Пациенты забывают о приёме" },
      { id: "client_history", statement: "Нужна история визитов каждого пациента" },
    ],
    modules: [
      { id: "landing" },
      { id: "catalog", params: { item_label: "Процедура", with_duration: true } },
      {
        id: "booking",
        params: {
          slot_minutes: 30,
          workdays: ["mon", "tue", "wed", "thu", "fri", "sat"],
          day_start: "09:00",
          day_end: "20:00",
          with_specialists: true,
          specialist_label: "Врач",
        },
        goals: ["fill_schedule", "reduce_no_shows"],
      },
      { id: "client_card", params: { client_label: "Пациент" }, goals: ["client_history"] },
      { id: "notify", params: { channels: ["email", "telegram"], reminder_hours: 24 } },
      { id: "reports" },
    ],
    landing: {
      sections: [
        { type: "header", variant: "bar", content: {} },
        {
          type: "hero",
          variant: "split",
          content: {
            title: "Лечим зубы без боли и очередей",
            subtitle: "Запись онлайн за минуту",
            cta: "Записаться",
          },
        },
        { type: "services", variant: "cards", content: { title: "Процедуры и цены" } },
        {
          type: "booking",
          variant: "split",
          content: { title: "Запись на приём", intro: "Выберите врача и время" },
        },
        {
          type: "faq",
          variant: "accordion",
          content: {
            title: "Вопросы",
            items: [{ question: "Больно ли лечить?", answer: "Работаем с анестезией." }],
          },
        },
        { type: "footer", variant: "simple", content: {} },
      ],
    },
    design: {
      direction: { mood: ["спокойствие", "чистота", "доверие"], rhythm: "airy" },
      theme: "calm",
      accent: "#2A7F9E",
      fontPair: { heading: "Manrope", body: "Inter Tight" },
      photoStyle: "светлые кабинеты, мягкий дневной свет, улыбки",
    },
    outOfScope: [
      {
        request: "Онлайн-оплата лечения",
        replacement: "Оплата в клинике, запись без предоплаты",
        category: "payments",
      },
    ],
    custom: [
      {
        id: "implant_calc",
        title: "Калькулятор стоимости имплантации",
        kind: "screen",
        description: "Экран с выбором числа имплантов и расчётом по ценам каталога",
        budgetRub: 8,
        module: "catalog",
      },
    ],
  };
}
type Plan = ReturnType<typeof dentalPlan>;

function codes(input: unknown, cat: ModuleCatalog = catalog, opts = {}): PlanErrorCode[] {
  const r = validateSystemPlan(input, cat, opts);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe("specs/modules/modules.yaml ↔ zod", () => {
  test("draft catalog of beta v2 passes validateModuleCatalog", () => {
    expect(catalogResult.ok ? [] : catalogResult.errors).toEqual([]);
    expect(modules.map((m) => m.id).sort()).toEqual([...BETA_V2_MODULES].sort());
  });

  test("goal vocabulary, section library, custom limits and error codes match the code", () => {
    expect(doc.goals.items).toEqual(GOALS.map((g) => ({ ...g })));
    expect(doc.sections.types).toEqual(
      SECTION_CATALOG.map((s) => ({ type: s.type, variants: [...s.variants] })),
    );
    const { screens, functions, budget_rub, rounds } = doc.system_plan.custom_limits;
    expect({ screens, functions, budgetRub: budget_rub, rounds }).toEqual(CUSTOM_LIMITS);
    expect(Object.keys(doc.validation.codes).sort()).toEqual([...PLAN_ERROR_CODES].sort());
  });

  test("every module has goal scenarios; owned names are not reserved", () => {
    for (const m of modules) {
      expect(m.goalScenarios.length, m.id).toBeGreaterThan(0);
      for (const n of [...(m.provides?.entities ?? []), ...(m.provides?.roles ?? [])]) {
        expect(isReservedName(n), `${m.id}: ${n}`).toBe(false);
      }
    }
    expect(SECTION_CATALOG.length).toBeGreaterThanOrEqual(15);
    for (const s of SECTION_CATALOG) {
      expect(s.variants.length, s.type).toBeGreaterThanOrEqual(3);
      expect(
        s.ready.every((v) => s.variants.includes(v)),
        s.type,
      ).toBe(true);
    }
  });
});

describe("validateSystemPlan", () => {
  test("dental clinic plan is valid; defaults are applied", () => {
    const r = validateSystemPlan(dentalPlan(), catalog);
    expect(r.ok ? [] : r.errors).toEqual([]);
    if (!r.ok) return;
    expect(r.params.booking).toMatchObject({
      slot_minutes: 30,
      capacity: 1,
      confirm: "auto",
      cancel_by_link: true,
    });
    expect(r.params.reports).toEqual({ period: "month", export_csv: true, digest: "none" });
  });

  test("draft modules are rejected when the compiler requires ready ones", () => {
    expect(codes(dentalPlan(), catalog, { requireReady: true })).toContain("MODULE_NOT_READY");
  });

  const invalid: [name: string, mutate: (p: Plan) => void, code: PlanErrorCode, path?: string][] = [
    ["unknown module", (p) => p.modules.push({ id: "payments" }), "UNKNOWN_MODULE", "/modules/6/id"],
    ["duplicate module", (p) => p.modules.push({ id: "reports" }), "DUPLICATE_MODULE", "/modules/6/id"],
    [
      "unknown parameter",
      (p) => Object.assign(p.modules[1] as object, { params: { with_duration: true, colour: "red" } }),
      "PARAMS_INVALID",
      "/modules/1/params/colour",
    ],
    [
      "parameter out of range",
      (p) => Object.assign(p.modules[2]?.params ?? {}, { slot_minutes: 5 }),
      "PARAMS_INVALID",
      "/modules/2/params/slot_minutes",
    ],
    [
      "parameter of wrong type",
      (p) => Object.assign(p.modules[2]?.params ?? {}, { day_start: "9 утра" }),
      "PARAMS_INVALID",
      "/modules/2/params/day_start",
    ],
    [
      "missing required link: booking without notify",
      (p) => p.modules.splice(4, 1),
      "MISSING_REQUIRED_MODULE",
      "/modules/2/id",
    ],
    [
      "conditional required link: weekly digest needs notify",
      (p) => {
        p.modules = p.modules.filter((m) => m.id !== "booking" && m.id !== "notify");
        Object.assign(p.modules[3] as object, { params: { digest: "weekly" } });
      },
      "MISSING_REQUIRED_MODULE",
      "/modules/3/id",
    ],
    [
      "required link with wrong parameters: catalog without duration",
      (p) => Object.assign(p.modules[1] as object, { params: { with_duration: false } }),
      "REQUIRED_PARAMS_MISMATCH",
      "/modules/1/params/with_duration",
    ],
    [
      "more than 3 goals",
      (p) => p.goals.push({ id: "visibility", statement: "Видеть, сколько записей за месяц" }),
      "TOO_MANY_GOALS",
      "/goals",
    ],
    [
      "duplicate goal",
      (p) => {
        p.goals[2] = { id: "fill_schedule", statement: "Ещё раз про расписание" };
      },
      "DUPLICATE_GOAL",
      "/goals/2/id",
    ],
    [
      "goal not covered by any module",
      (p) => {
        p.goals[2] = { id: "deal_pipeline", statement: "Порядок в сделках" };
        p.modules[3] = { id: "client_card" } as never;
      },
      "GOAL_NOT_COVERED",
      "/goals/2/id",
    ],
    [
      "module claims a goal it does not close",
      (p) => Object.assign(p.modules[3] as object, { goals: ["fill_schedule"] }),
      "GOAL_NOT_COVERED",
      "/modules/3/goals/0",
    ],
    [
      "module claims a goal outside the plan",
      (p) => Object.assign(p.modules[5] as object, { goals: ["visibility"] }),
      "GOAL_NOT_IN_PLAN",
      "/modules/5/goals/0",
    ],
    [
      "landing sections without landing module",
      (p) => p.modules.splice(0, 1),
      "LANDING_MISMATCH",
      "/landing",
    ],
    [
      "landing module without sections",
      (p) => {
        delete (p as Partial<Plan>).landing;
      },
      "LANDING_MISMATCH",
      "/landing",
    ],
    [
      "unknown section type",
      (p) => p.landing.sections.splice(2, 0, { type: "map", variant: "wide", content: {} }),
      "UNKNOWN_SECTION",
      "/landing/sections/2/type",
    ],
    [
      "unknown layout variant",
      (p) => {
        (p.landing.sections[1] as { variant: string }).variant = "diagonal";
      },
      "UNKNOWN_VARIANT",
      "/landing/sections/1/variant",
    ],
    [
      "required content key missing",
      (p) => {
        (p.landing.sections[1] as { content: Record<string, unknown> }).content = { title: "Без кнопки" };
      },
      "SECTION_CONTENT_INVALID",
      "/landing/sections/1/content/cta",
    ],
    [
      "unknown content key",
      (p) => Object.assign(p.landing.sections[2]?.content ?? {}, { price: "от 1000 ₽" }),
      "SECTION_CONTENT_INVALID",
      "/landing/sections/2/content/price",
    ],
    [
      "footer is not last",
      (p) =>
        p.landing.sections.push({
          type: "cta",
          variant: "band",
          content: { title: "Ждём вас", cta: "Записаться" } as never,
        }),
      "SECTION_ORDER",
      "/landing/sections/5",
    ],
    ["no hero", (p) => p.landing.sections.splice(1, 1), "SECTION_REQUIRED", "/landing/sections"],
    [
      "section needs a module outside the plan",
      (p) =>
        p.landing.sections.splice(2, 0, { type: "lead_form", variant: "card", content: { title: "Заявка" } }),
      "SECTION_NEEDS_MODULE",
      "/landing/sections/2/type",
    ],
    [
      "unknown theme",
      (p) => {
        p.design.theme = "neon";
      },
      "UNKNOWN_THEME",
      "/design/theme",
    ],
    [
      "unknown font",
      (p) => {
        p.design.fontPair.body = "Comic Sans";
      },
      "UNKNOWN_FONT",
      "/design/fontPair/body",
    ],
    [
      "custom references a module outside the plan",
      (p) => {
        (p.custom[0] as { module?: string }).module = "deals";
      },
      "UNKNOWN_MODULE",
      "/custom/0/module",
    ],
    [
      "extra key in the plan",
      (p) => Object.assign(p, { code: "export default () => null" }),
      "SCHEMA_INVALID",
      "/code",
    ],
  ];

  test.each(invalid)("%s", (_name, mutate, code, path) => {
    const p = dentalPlan();
    mutate(p);
    const r = validateSystemPlan(p, catalog);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const hit = r.errors.find((e) => e.code === code);
    expect(hit, JSON.stringify(r.errors)).toBeDefined();
    if (path !== undefined) expect(hit?.path).toBe(path);
    for (const e of r.errors) expect(e.message_ru).toMatch(/[а-яё]/i);
  });

  test("conflicting modules are rejected with a Russian reason", () => {
    const withConflict: ModuleCatalog = {
      modules: modules.map((m) =>
        m.id === "deals" ? { ...m, conflicts: [{ module: "resources", reason: "для проверки" }] } : m,
      ),
    };
    const p = dentalPlan() as unknown as { modules: { id: string; params?: object }[] };
    p.modules.push({ id: "deals" }, { id: "resources" });
    const r = validateSystemPlan(p, withConflict);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const conflicts = r.errors.filter((e) => e.code === "MODULE_CONFLICT");
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.message_ru).toContain("несовместимы");
  });
});

describe("custom code limits (D76: ≤ 2 screens, ≤ 3 functions, ≤ 20 ₽)", () => {
  const item = (id: string, kind: "screen" | "function", budgetRub: number) => ({
    id,
    title: `Доработка ${id}`,
    kind,
    description: "Небольшая доработка поверх модулей плана",
    budgetRub,
  });

  test("exactly at the limits is valid", () => {
    const p = dentalPlan();
    p.custom = [
      item("s1", "screen", 4),
      item("s2", "screen", 4),
      item("f1", "function", 4),
      item("f2", "function", 4),
      item("f3", "function", 4),
    ] as never;
    expect(codes(p)).toEqual([]);
  });

  test.each([
    ["three screens", [item("s1", "screen", 2), item("s2", "screen", 2), item("s3", "screen", 2)], "экранов"],
    [
      "four functions",
      [
        item("f1", "function", 2),
        item("f2", "function", 2),
        item("f3", "function", 2),
        item("f4", "function", 2),
      ],
      "функций",
    ],
    ["budget over 20 ₽", [item("s1", "screen", 12), item("f1", "function", 9)], "₽"],
  ])("%s", (_name, custom, word) => {
    const p = dentalPlan();
    p.custom = custom as never;
    const r = validateSystemPlan(p, catalog);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const hit = r.errors.find((e) => e.code === "CUSTOM_LIMIT_EXCEEDED");
    expect(hit?.path).toBe("/custom");
    expect(hit?.message_ru).toContain(word);
  });

  test("a single item above the whole budget is rejected", () => {
    const p = dentalPlan();
    p.custom = [item("big", "function", 25)] as never;
    expect(codes(p)).toContain("SCHEMA_INVALID");
  });
});

describe("module catalog checks", () => {
  // A catalog entry without its CI matrix (B2-18 gave «resources» one; the checks below build on a bare entry).
  const base = (): ModuleManifest => {
    const { tests: _tests, ...m } = structuredClone(
      modules.find((x) => x.id === "resources") as ModuleManifest,
    );
    return m;
  };

  test("duplicate entity ownership, unknown links and cycles are catalog errors", () => {
    const a = { ...base(), id: "a", provides: { entities: ["thing"] }, goalScenarios: [] };
    const b = {
      ...base(),
      id: "b",
      provides: { entities: ["thing"] },
      requires: [{ module: "c", reason: "проверка цикла" }],
      goalScenarios: [],
    };
    const c = {
      ...base(),
      id: "c",
      provides: {},
      requires: [{ module: "b", reason: "проверка цикла" }],
      goalScenarios: [],
    };
    const d = {
      ...base(),
      id: "d",
      provides: {},
      links: [{ module: "nope", effect: "неизвестный модуль" }],
      goalScenarios: [],
    };
    const r = validateModuleCatalog([a, b, c, d]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.map((e) => e.message_ru).join("\n");
    expect(text).toContain("уже принадлежит модулю «a»");
    expect(text).toContain("Цикл обязательных связей");
    expect(text).toContain("неизвестный модуль «nope»");
    expect(r.errors.every((e) => e.code === "CATALOG_INVALID")).toBe(true);
  });

  test("ready modules declare fragments, screens, scenarios and a CI matrix", () => {
    const r = validateModuleCatalog([{ ...base(), status: "ready" }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.map((e) => e.message_ru).join("\n");
    expect(text).toContain("Готовый модуль (ready) объявляет фрагменты спеки");
    expect(text).toContain("Готовый модуль (ready) объявляет матрицу параметров CI");
  });

  test("a default outside the parameter schema is reported", () => {
    const bad = {
      ...base(),
      params: [{ name: "days", label: "Дни", type: "int", min: 1, max: 5, default: 9 }],
    };
    bad.requires = [];
    bad.goalScenarios = [];
    bad.metrics = [];
    bad.links = [];
    const r = validateModuleCatalog([bad]);
    expect(r.ok ? [] : r.errors.map((e) => e.message_ru)).toEqual([
      "Значение по умолчанию параметра «days» не проходит его же схему",
    ]);
  });

  test("paramsSchema: required parameter without default must be present", () => {
    const m = { params: [{ name: "city", label: "Город", type: "string" as const, required: true }] };
    expect(paramsSchema(m).safeParse({}).success).toBe(false);
    expect(paramsSchema(m).safeParse({ city: "Казань" }).success).toBe(true);
  });

  test("evalCondition", () => {
    const present = new Set(["booking"]);
    expect(evalCondition(undefined, {}, present)).toBe(true);
    expect(evalCondition({ param: "on" }, { on: true }, present)).toBe(true);
    expect(evalCondition({ param: "n" }, { n: 0 }, present)).toBe(false);
    expect(evalCondition({ param: "list" }, { list: [] }, present)).toBe(false);
    expect(evalCondition({ param: "mode", equals: ["a", "b"] }, { mode: "b" }, present)).toBe(true);
    expect(evalCondition({ param: "ch", includes: "telegram" }, { ch: ["email"] }, present)).toBe(false);
    expect(evalCondition({ module: "booking" }, {}, present)).toBe(true);
    expect(evalCondition({ module: "deals", param: "on" }, { on: true }, present)).toBe(false);
  });
});
