// B2-13 module «Каталог и прайс»: the service entity per parameters, public read of visible items only, the showcase
// page and the landing section «Услуги из каталога», where «Выбрать» leads, metrics and goal scenarios. G0/G1 of the
// CI matrix rows run in gates.test.ts.
import type { AppSpec, PlanSection, SystemPlan } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  CATALOG_NAMES,
  type CompileResult,
  type CompileSuccess,
  catalogManifest,
  catalogShowcasePage,
  compilePlan,
  DRAFT_MANIFESTS,
  matrixPlan,
  type ScreenContext,
  showcaseTarget,
} from "../src/index.js";
import { testRegistry } from "./fixtures.js";

const registry = testRegistry();

function ok(r: CompileResult): CompileSuccess {
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
}
const row = (params: Record<string, unknown>, withModules: string[] = []) =>
  ok(compilePlan(matrixPlan(registry, "catalog", { name: "t", params, withModules }), registry));
const entity = (spec: AppSpec, name: string) => spec.entities.find((e) => e.name === name);
const perm = (spec: AppSpec, role: string, name: string) =>
  spec.permissions.find((p) => p.role === role && p.entity === name);

/** Landing + catalog + leads + notify with the given services sections (dental clinic texts). */
function clinicPlan(services: PlanSection[], catalogParams: Record<string, unknown> = {}): SystemPlan {
  const plan = matrixPlan(registry, "catalog", {
    name: "clinic",
    params: catalogParams,
    withModules: ["landing", "leads", "notify"],
  });
  const sections = (plan.landing?.sections ?? []).filter((s) => s.type !== "services");
  sections.splice(2, 0, ...services);
  return { ...plan, landing: { sections } };
}

describe("service entity by parameters", () => {
  test("defaults: name, price, visibility, description, photo, order; label from item_label", () => {
    const r = row({});
    const s = entity(r.spec, "service");
    expect(s?.label).toBe("Услуга");
    expect(s?.fields.map((f) => [f.name, f.type, f.required ?? false])).toEqual([
      ["name", "string", true],
      ["price", "money", false],
      ["active", "bool", true],
      ["description", "text", false],
      ["photo", "image", false],
      ["sort_order", "int", false],
    ]);
    expect(s?.fields.find((f) => f.name === "active")?.default).toBe(true);
    expect(s?.indexes).toEqual([{ fields: ["active", "sort_order"] }]);
    expect(s?.retention).toBeUndefined();
    expect(entity(r.spec, "service_category")).toBeUndefined();
  });

  test("duration (booking reads duration_min), categories, no photos, extra fields with a contact", () => {
    const r = row({
      item_label: "Процедура",
      with_duration: true,
      with_categories: true,
      with_photos: false,
      extra_fields: [
        { name: "sku", label: "Артикул", type: "string" },
        { name: "order_phone", label: "Телефон для заказа", type: "phone" },
      ],
    });
    const s = entity(r.spec, "service");
    expect(s?.label).toBe("Процедура");
    expect(s?.fields.map((f) => f.name)).toEqual([
      "name",
      "price",
      CATALOG_NAMES.duration,
      "category",
      "active",
      "description",
      "sort_order",
      "sku",
      "order_phone",
    ]);
    expect(s?.fields.find((f) => f.name === "duration_min")).toMatchObject({ type: "int", required: true });
    expect(s?.fields.find((f) => f.name === "category")?.ref).toEqual({
      entity: "service_category",
      onDelete: "set_null",
    });
    expect(s?.indexes).toEqual([{ fields: ["active", "sort_order"] }, { fields: ["category"] }]);
    expect(s?.retention).toEqual({ deleteAfterDays: 3650, mode: "anonymize" });
    expect(entity(r.spec, "service_category")?.fields.map((f) => f.name)).toEqual(["name", "sort_order"]);
  });

  test("an extra field may not repeat a catalog field", () => {
    const r = compilePlan(
      matrixPlan(registry, "catalog", {
        name: "t",
        params: { extra_fields: [{ name: "price", label: "Цена", type: "money" }] },
      }),
      registry,
    );
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(["FIELD_NAME_CONFLICT"]);
  });

  test("booking's expectParams are catalog parameters", () => {
    const booking = DRAFT_MANIFESTS.find((m) => m.id === "booking");
    const req = booking?.requires?.find((x) => x.module === "catalog");
    for (const k of Object.keys(req?.expectParams ?? {}))
      expect(catalogManifest.params.map((p) => p.name)).toContain(k);
  });
});

describe("permissions", () => {
  test("the visitor reads visible items only; prices hidden when show_prices is off; no writes", () => {
    const shown = row({});
    expect(perm(shown.spec, "guest", "service")).toEqual({
      role: "guest",
      entity: "service",
      ops: ["read"],
      rowFilter: { active: true },
    });
    expect(perm(shown.spec, "owner", "service")?.ops).toEqual(["read", "create", "update", "delete"]);
    const hidden = row({ show_prices: false, with_categories: true });
    expect(perm(hidden.spec, "guest", "service")?.hiddenFields).toEqual(["price"]);
    expect(perm(hidden.spec, "guest", "service_category")?.ops).toEqual(["read"]);
    expect(perm(hidden.spec, "owner", "service_category")?.ops).toEqual([
      "read",
      "create",
      "update",
      "delete",
    ]);
    expect(shown.spec.acceptance?.map((a) => [a.check.role, a.check.op, a.check.expect])).toEqual([
      ["guest", "read", "allow"],
      ["guest", "update", "deny"],
      ["owner", "create", "allow"],
    ]);
  });
});

describe("showcase page and the landing section", () => {
  test("without a lead form or booking: a price list on /services, a cabinet section, warnings", () => {
    const r = row({ with_categories: true, with_duration: true, show_prices: false });
    expect(r.spec.pages?.find((p) => p.route === "/services")).toEqual({
      route: "/services",
      title: "Каталог и цены",
      file: "ui/pages/CatalogServices.tsx",
      roles: ["guest", "owner"],
      nav: true,
    });
    const page = r.files["ui/pages/CatalogServices.tsx"] ?? "";
    expect(page).toContain('import { DataTable } from "@wizard/ui-kit";');
    expect(page).toContain('columns={["name","category","duration_min","description"]}');
    expect(page).not.toContain("<Catalog");
    expect(page).toContain('<ServiceShowcase title={"Услуги и цены"} main layout="cards" />');
    const cabinet = r.files["ui/pages/Cabinet.tsx"] ?? "";
    expect(cabinet).toContain('entity={"service"}');
    expect(cabinet).toContain('entity={"service_category"}');
    expect(r.warnings).toEqual([
      "На витрине нет кнопки «Выбрать»: в системе нет формы заявки на главной или записи — позиции показаны прайс-листом",
    ]);
  });

  test("with the lead form: cards whose «Выбрать» leads to the form's anchor; the landing renders the showcase", () => {
    const r = ok(
      compilePlan(
        clinicPlan(
          [
            { type: "services", variant: "list", content: { title: "Процедуры и цены", intro: "Пример: …" } },
            { type: "services", variant: "table", content: { title: "Прайс" } },
          ],
          { with_categories: true, with_duration: true, showcase_title: "Процедуры" },
        ),
        registry,
      ),
    );
    const page = r.files["ui/pages/CatalogServices.tsx"] ?? "";
    expect(page).toContain('import { Catalog, DataTable, type Rec, useDataSource } from "@wizard/ui-kit";');
    expect(page).toContain('onSelect={() => location.assign("/#lead")}');
    expect(page).toContain("files.imageSrc(r.photo, 480)");
    expect(page).toContain('price: typeof r.price === "number" ? r.price : null,');
    expect(page).toContain("r.duration_min} мин`");
    expect(page).toContain('<ServiceShowcase title={"Процедуры"} main layout="cards" />');
    const home = r.files["ui/pages/Home.tsx"] ?? "";
    expect(home).toContain('import { ServiceShowcase } from "./CatalogServices";');
    expect(home).toContain(
      '<ServiceShowcase title={"Процедуры и цены"} intro={"Пример: …"} anchor="services" layout="list" />',
    );
    expect(home).toContain('<ServiceShowcase title={"Прайс"} anchor="services_2" layout="table" />');
    expect(home).toContain('{"label":"Процедуры и цены","href":"#services"}');
    expect(r.warnings).toEqual([]);
  });

  test("a lead form with its own anchor; the tabs variant is not implemented yet", () => {
    const plan = clinicPlan([{ type: "services", variant: "cards", content: { title: "Услуги" } }]);
    const form = plan.landing?.sections.find((s) => s.type === "lead_form");
    if (form) form.anchor = "zayavka";
    const r = ok(compilePlan(plan, registry));
    expect(r.files["ui/pages/CatalogServices.tsx"]).toContain('location.assign("/#zayavka")');
    const tabs = compilePlan(
      clinicPlan([{ type: "services", variant: "tabs", content: { title: "Услуги" } }]),
      registry,
    );
    expect(tabs.ok ? [] : tabs.errors.map((e) => e.code)).toEqual(["SECTION_NOT_IMPLEMENTED"]);
  });

  test("with booking in the plan «Выбрать» opens booking of the item", () => {
    const r = row({ with_photos: false });
    const ctx: ScreenContext = {
      plan: r.plan,
      params: { item_label: "Услуга", show_prices: true, with_photos: false },
      allParams: {},
      present: new Set(["catalog", "booking", "leads", "landing"]),
      spec: r.spec,
      metrics: r.metrics,
      screen: catalogManifest.screens?.[0] as ScreenContext["screen"],
      roles: ["guest", "owner"],
    };
    expect(showcaseTarget(ctx)).toEqual({ kind: "booking", prefix: "/booking?service=" });
    const page = catalogShowcasePage(ctx);
    expect(page).toContain('import { Catalog, DataTable, type Rec, useNavigate } from "@wizard/ui-kit";');
    expect(page).toContain('onSelect={(r: Rec) => navigate("/booking?service=" + encodeURIComponent(r.id))}');
  });

  test("the plan without a services section gets a hint", () => {
    const r = ok(compilePlan(clinicPlan([]), registry));
    expect(r.warnings).toContain(
      "Каталог — на отдельной странице «Каталог и цены»; чтобы показать его на главной, добавьте секцию «Услуги из каталога»",
    );
  });

  test("determinism", () => {
    const plan = clinicPlan([{ type: "services", variant: "cards", content: { title: "Услуги" } }]);
    const a = ok(compilePlan(plan, registry));
    const b = ok(compilePlan(structuredClone(plan), registry));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("leads with the service choice", () => {
  test("the lead refers to a catalog item", () => {
    const plan = clinicPlan([]);
    plan.modules = plan.modules.map((m) =>
      m.id === "leads" ? { id: "leads", params: { with_service: true } } : m,
    );
    const r = ok(compilePlan(plan, registry));
    expect(entity(r.spec, "lead")?.fields.find((f) => f.name === "service")?.ref).toEqual({
      entity: "service",
      onDelete: "set_null",
    });
  });
});

describe("goal panel and scenarios", () => {
  test("services_active counts visible items; scenarios by parameters and modules", () => {
    const plain = row({ show_prices: false });
    expect(plain.metrics.map((m) => [m.id, m.module, m.planGoal])).toEqual([
      ["services_active", "catalog", true],
    ]);
    expect(plain.scenarios.map((s) => s.id)).toEqual(["GS-catalog-2"]);
    const full = ok(compilePlan(clinicPlan([], { with_duration: true }), registry));
    expect(full.scenarios.filter((s) => s.module === "catalog").map((s) => s.id)).toEqual([
      "GS-catalog-1",
      "GS-catalog-2",
      "GS-catalog-3",
      "GS-catalog-4",
    ]);
  });
});
