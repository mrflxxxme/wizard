// B2-11 module engine: deterministic compilation of a SystemPlan, application order by requires, links, conflicts and
// incompatibilities rejected before the build with Russian reasons, merged permissions, metric checks (MODULE_BUG).
import type { ModuleManifest, PlanErrorCode, SystemPlan } from "@wizard/appspec";
import { SECTION_CATALOG } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  type CompileResult,
  type CompileSuccess,
  checkRegistry,
  compilePlan,
  leadFormFields,
  leadsModule,
  SECTION_RENDERERS,
} from "../src/index.js";
import { FIXTURES, fx, fxPlan, landingLeadsPlan, testRegistry } from "./fixtures.js";

const registry = testRegistry();

function ok(r: CompileResult): CompileSuccess {
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}
const codes = (r: CompileResult): PlanErrorCode[] => (r.ok ? [] : r.errors.map((e) => e.code));
const messages = (r: CompileResult): string => (r.ok ? "" : r.errors.map((e) => e.message_ru).join("\n"));

describe("determinism", () => {
  test("the same plan compiles to byte-identical spec and files", () => {
    const a = ok(compilePlan(landingLeadsPlan(), registry, { appName: "Улыбка" }));
    const b = ok(compilePlan(structuredClone(landingLeadsPlan()), registry, { appName: "Улыбка" }));
    expect(JSON.stringify(b.spec)).toBe(JSON.stringify(a.spec));
    expect(JSON.stringify(b.files)).toBe(JSON.stringify(a.files));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test("the order of modules and parameter keys in the plan does not change the output", () => {
    const plan = landingLeadsPlan();
    const shuffled: SystemPlan = {
      ...plan,
      modules: [...plan.modules]
        .reverse()
        .map((m) =>
          m.params ? { ...m, params: Object.fromEntries(Object.entries(m.params).reverse()) } : m,
        ),
    };
    const a = ok(compilePlan(plan, registry));
    const b = ok(compilePlan(shuffled, registry));
    expect(JSON.stringify(b.spec)).toBe(JSON.stringify(a.spec));
    expect(JSON.stringify(b.files)).toBe(JSON.stringify(a.files));
  });
});

describe("landing + leads", () => {
  const r = ok(compilePlan(landingLeadsPlan(), registry, { appName: "Улыбка" }));

  test("base, application order and links", () => {
    expect(r.spec.app).toEqual({ name: "Улыбка", locale: "ru" });
    expect(r.order).toEqual(["notify", "landing", "leads"]);
    expect(r.links).toEqual([
      { from: "notify", to: "leads", effect: "уведомление владельца о новой заявке" },
    ]);
    expect(r.spec.theme).toEqual({
      accent: "#2A7F9E",
      preset: "calm",
      font: "Inter Tight",
      headingFont: "Manrope",
    });
    expect(r.spec.compliance).toEqual({ consentTemplateId: "default", policyPage: "/privacy" });
    expect(r.plan.modules.map((m) => [m.id, m.version])).toEqual([
      ["landing", 1],
      ["leads", 1],
      ["notify", 1],
    ]);
  });

  test("lead entity: required contact, canonical status, extra field, retention from the parameter", () => {
    const lead = r.spec.entities.find((e) => e.name === "lead");
    expect(lead?.fields.map((f) => [f.name, f.required ?? false])).toEqual([
      ["name", true],
      ["phone", true],
      ["comment", false],
      ["status", true],
      ["visit_reason", false],
    ]);
    expect(lead?.fields.find((f) => f.name === "status")?.enum?.map((o) => o.value)).toEqual([
      "new",
      "in_work",
      "done",
    ]);
    expect(lead?.retention).toEqual({ deleteAfterDays: 365 });
  });

  test("symbolic roles: $staff without the staff module is the owner, permissions merge", () => {
    expect(r.spec.roles.map((x) => x.name)).toEqual(["guest", "owner"]);
    expect(r.spec.permissions).toEqual([
      { role: "guest", entity: "lead", ops: ["create"], readonlyFields: ["status"] },
      { role: "owner", entity: "lead", ops: ["read", "update", "delete"] },
    ]);
    expect(r.spec.acceptance?.map((a) => [a.id, a.check.role, a.check.op, a.check.expect])).toEqual([
      ["AC1", "guest", "create", "allow"],
      ["AC2", "guest", "read", "deny"],
      ["AC3", "owner", "update", "allow"],
    ]);
  });

  test("links merge integrations by config and add the notification workflow", () => {
    expect(r.spec.integrations).toEqual([
      {
        name: "mail",
        connector: "email",
        config: {
          templates: {
            welcome: { subject: "Добро пожаловать", body: "Здравствуйте! {{link}}" },
            new_lead: { subject: "Новая заявка", body: "Новая заявка. Открыть: {{link}}" },
          },
        },
      },
      { name: "tg", connector: "telegram", config: {} },
    ]);
    expect(r.spec.workflows?.map((w) => w.name)).toEqual(["lead_notify"]);
  });

  test("pages: landing «/» for everyone, the owner's cabinet with leads", () => {
    expect(r.spec.pages).toEqual([
      { route: "/", title: "Главная", file: "ui/pages/Home.tsx", roles: ["guest", "owner"], nav: true },
      { route: "/cabinet", title: "Кабинет: Владелец", file: "ui/pages/Cabinet.tsx", roles: ["owner"] },
    ]);
    expect(Object.keys(r.files)).toEqual(["ui/pages/Cabinet.tsx", "ui/pages/Home.tsx"]);
    const home = r.files["ui/pages/Home.tsx"] ?? "";
    expect(home).toContain(
      'import { Cta, Faq, Features, Footer, Header, Hero, LeadForm, Steps } from "@wizard/ui-kit";',
    );
    expect(home).toContain('<Hero title={"Лечим зубы без боли и очередей"}');
    expect(home).toContain(
      'primary={{"label":"Оставить заявку","href":"#lead"}} variant="split" anchor="top"',
    );
    expect(home).toContain('<LeadForm entity={"lead"} title={"Оставьте заявку"}');
    expect(home).toContain('submitLabel={"Отправить"} variant="split" anchor="lead"');
    expect(home).toContain('<Header brand={"Улыбка"} links={[{"label":"Почему мы","href":"#features"}');
    expect(home).toContain("sticky />");
    expect(home).toContain(
      'items={[{"title":"Современное оборудование"},{"title":"Анестезия","text":"Лечим без боли"}]}',
    );
    const cab = r.files["ui/pages/Cabinet.tsx"] ?? "";
    expect(cab).toContain('patch: { status: "in_work" }');
    expect(cab).toContain('kind: "delete"');
  });

  test("metrics and goal scenarios of the plan; custom slots", () => {
    expect(r.metrics.map((m) => [m.module, m.id, m.planGoal])).toEqual([
      ["leads", "leads_count", true],
      ["leads", "leads_handled", true],
    ]);
    expect(r.scenarios.map((s) => s.id)).toEqual(["GS-notify-1", "GS-landing-1", "GS-leads-1", "GS-leads-2"]);
    expect(r.customSlots).toEqual([
      {
        id: "price_calc",
        kind: "screen",
        title: "Калькулятор стоимости",
        budgetRub: 8,
        module: "leads",
        name: "custom_price_calc",
        file: "ui/custom/CustomPriceCalc.tsx",
        route: "/custom-price-calc",
      },
    ]);
    expect(r.warnings).toEqual([]);
  });

  test("leads without a lead form on the landing: a warning", () => {
    const plan = landingLeadsPlan();
    plan.landing = { sections: (plan.landing?.sections ?? []).filter((s) => s.type !== "lead_form") };
    expect(ok(compilePlan(plan, registry)).warnings).toEqual([
      "Форма заявки не стоит на лендинге: посетителю негде оставить заявку — добавьте секцию «Форма заявки»",
    ]);
  });

  test("the required contact joins the form even when the plan left it out", () => {
    expect(leadFormFields(["name", "comment"], "phone")).toEqual(["name", "phone", "comment"]);
    expect(leadFormFields(["comment"], "email")).toEqual(["email", "comment"]);
    expect(leadFormFields(["name"], "any")).toEqual(["name"]);
  });
});

describe("order, links and incompatibilities", () => {
  test("requires before order: fx_beta (order 50) goes before fx_alpha (order 1)", () => {
    const r = ok(compilePlan(fxPlan([{ id: "fx_alpha" }, { id: "fx_beta" }, { id: "fx_gamma" }]), registry));
    expect(r.order).toEqual(["fx_gamma", "fx_beta", "fx_alpha"]);
    expect(r.spec.entities.map((e) => e.name)).toEqual(["fx_gamma_item", "fx_beta_item", "fx_alpha_item"]);
  });

  test("a link applies only when both modules are in the plan", () => {
    const withGamma = ok(compilePlan(fxPlan([{ id: "fx_beta" }, { id: "fx_gamma" }]), registry));
    const beta = (r: CompileSuccess) => r.spec.entities.find((e) => e.name === "fx_beta_item");
    expect(beta(withGamma)?.fields.map((f) => f.name)).toContain("gamma_note");
    expect(withGamma.links).toEqual([
      { from: "fx_beta", to: "fx_gamma", effect: "у беты появляется заметка гаммы" },
    ]);
    const alone = ok(compilePlan(fxPlan([{ id: "fx_beta" }]), registry));
    expect(beta(alone)?.fields.map((f) => f.name)).not.toContain("gamma_note");
    expect(alone.links).toEqual([]);
  });

  test("parameters are substituted into fragments", () => {
    const r = ok(compilePlan(fxPlan([{ id: "fx_beta", params: { label: "Позиция" } }]), registry));
    expect(r.spec.entities[0]?.label).toBe("Позиция");
  });

  test("a conflicting pair is rejected before the build with the reason", () => {
    const r = compilePlan(fxPlan([{ id: "fx_gamma" }, { id: "fx_delta" }]), registry);
    expect(codes(r)).toEqual(["MODULE_CONFLICT"]);
    expect(messages(r)).toContain("гамма и дельта ведут одно и то же");
  });

  test("a missing required module is rejected", () => {
    const r = compilePlan(fxPlan([{ id: "fx_alpha" }]), registry);
    expect(codes(r)).toEqual(["MISSING_REQUIRED_MODULE"]);
    expect(messages(r)).toContain("альфе нужна бета");
  });

  test("leads without notify are rejected; a draft module is not compiled", () => {
    const plan = landingLeadsPlan();
    plan.modules = plan.modules.filter((m) => m.id !== "notify");
    expect(codes(compilePlan(plan, registry))).toEqual(["MISSING_REQUIRED_MODULE"]);
    const draft = landingLeadsPlan();
    draft.modules.push({ id: "reports" });
    const r = compilePlan(draft, registry);
    expect(codes(r)).toEqual(["MODULE_NOT_READY"]);
    expect(messages(r)).toContain("ещё не готов к сборке");
  });

  test("extra fields that clash with module, link, system or reserved names", () => {
    const plan = landingLeadsPlan();
    const leads = plan.modules.find((m) => m.id === "leads");
    if (leads?.params) leads.params.extra_fields = [{ name: "phone", label: "Ещё телефон", type: "phone" }];
    const r1 = compilePlan(plan, registry);
    expect(codes(r1)).toEqual(["FIELD_NAME_CONFLICT"]);
    expect(r1.ok ? "" : r1.errors[0]?.path).toBe("/modules/1/params/extra_fields/0/name");
    if (leads?.params) leads.params.extra_fields = [{ name: "created_at", label: "Дата", type: "date" }];
    expect(codes(compilePlan(plan, registry))).toEqual(["FIELD_NAME_CONFLICT"]);
    const link = compilePlan(
      fxPlan([
        { id: "fx_beta", params: { extra: [{ name: "gamma_note", label: "Своя заметка", type: "text" }] } },
        { id: "fx_gamma" },
      ]),
      registry,
    );
    expect(codes(link)).toEqual(["FIELD_NAME_CONFLICT"]);
    expect(messages(link)).toContain(
      "совпадает с полем, которое добавляет модуль «Фикстура fx_beta» (связь с «fx_gamma»)",
    );
    expect(link.ok ? "" : link.errors[0]?.path).toBe("/modules/0/params/extra/0/name");
  });

  test("a section variant not yet in ui-kit: a clear compile error", () => {
    const plan = landingLeadsPlan();
    const sections = plan.landing?.sections ?? [];
    sections[1] = { ...(sections[1] as (typeof sections)[number]), variant: "collage" };
    sections.splice(2, 0, { type: "gallery", variant: "grid", content: {} });
    const r = compilePlan(plan, registry);
    expect(codes(r)).toEqual(["SECTION_NOT_IMPLEMENTED", "SECTION_NOT_IMPLEMENTED"]);
    expect(messages(r)).toContain("Вариант «collage» секции «Первый экран» ещё не реализован");
    expect(r.ok ? [] : r.errors[0]?.allowed).toEqual(["split", "centered", "cover"]);
  });

  test("a plan for another manifest version is rejected; plan errors pass through", () => {
    const plan = landingLeadsPlan();
    plan.modules[0] = { ...plan.modules[0], id: "landing", version: 2 };
    expect(codes(compilePlan(plan, registry))).toEqual(["MODULE_VERSION_MISMATCH"]);
    expect(codes(compilePlan({ ...landingLeadsPlan(), niche: "" }, registry))).toEqual(["SCHEMA_INVALID"]);
  });
});

describe("module bugs", () => {
  const broken = (over: Partial<ModuleManifest>) =>
    testRegistry([], [...FIXTURES.filter((m) => m.id !== "fx_delta"), fx({ id: "fx_delta", ...over })]);

  test("a metric on a missing entity or a non-canonical status is MODULE_BUG", () => {
    const metric = (compute: NonNullable<ModuleManifest["metrics"]>[number]["compute"]) =>
      broken({
        metrics: [
          { id: "bad", label: "Сломанная", goal: "visibility", unit: "count", better: "up", compute },
        ],
      });
    const missing = compilePlan(
      fxPlan([{ id: "fx_delta" }]),
      metric({ kind: "count", entity: "fx_missing", dateField: "created_at" }),
    );
    expect(codes(missing)).toEqual(["MODULE_BUG"]);
    expect(messages(missing)).toContain("метрика «bad»: нет сущности «fx_missing»");
    const status = compilePlan(
      fxPlan([{ id: "fx_delta" }]),
      metric({
        kind: "ratio",
        entity: "fx_delta_item",
        dateField: "starts_at",
        numerator: { status: "won" },
      }),
    );
    expect(messages(status)).toContain("нет поля «fx_delta_item.starts_at»");
    expect(messages(status)).toContain("значения «won» нет в «fx_delta_item.status»");
  });

  test("a compiled spec that fails validateSpec is MODULE_BUG", () => {
    const reg = broken({
      fragments: {
        entities: [
          {
            value: {
              name: "fx_delta_item",
              label: "Дельта",
              fields: [{ name: "kind", label: "Вид", type: "enum" }],
            },
          },
        ],
      },
    });
    const r = compilePlan(fxPlan([{ id: "fx_delta" }]), reg);
    expect(codes(r)).toEqual(["MODULE_BUG"]);
    expect(messages(r)).toContain("скомпилированная спека не проходит проверку");
  });

  test("an entity outside provides is MODULE_BUG", () => {
    const reg = broken({
      fragments: {
        entities: [
          { value: { name: "other", label: "Чужая", fields: [{ name: "a", label: "А", type: "string" }] } },
        ],
      },
    });
    expect(messages(compilePlan(fxPlan([{ id: "fx_delta" }]), reg))).toContain(
      "сущность «other» не объявлена в provides.entities",
    );
  });

  test("registry: hook without compile, a screen without a generator", () => {
    expect(checkRegistry(testRegistry())).toEqual([]);
    const noHook = testRegistry([{ ...leadsModule, compile: undefined } as never]);
    expect(checkRegistry(noHook).map((e) => e.message_ru)).toEqual([
      "Модуль «Заявки»: в манифесте hook, но нет compile",
    ]);
    const screen = broken({
      screens: [
        { id: "x", audience: "public", route: "/x", title: "Икс", roles: ["$public"], components: ["Hero"] },
      ],
    });
    expect(checkRegistry(screen).map((e) => e.code)).toEqual(["MODULE_BUG"]);
  });
});

test("every ready section variant has a renderer", () => {
  for (const t of SECTION_CATALOG)
    if (t.ready.length) expect(SECTION_RENDERERS[t.type], t.type).toBeDefined();
});
