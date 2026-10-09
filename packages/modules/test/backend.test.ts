// V3-10 acceptance 1 (specs/agents/builder-v3.md §3 C5): the back end of the modules — entities, statuses,
// automations, permissions and RLS, ПДн, functions, goal scenarios, metrics — compiles without public screens
// (compilePlan(plan, registry, {front: "backend"})), on every CI matrix row and the plans of the measurement briefs;
// the v2 path is unchanged. Gates with a database — backend.gates.test.ts.
import { type AppSpec, validateSpec } from "@wizard/appspec";
import { piiMarkup, piiRetention } from "@wizard/gates";
import { describe, expect, test } from "vitest";
import { type CompileSuccess, compiledFingerprint, compilePlan } from "../src/index.js";
import { compiled, matrixPlans, mvpPlans } from "./backend-fixtures.js";
import { testRegistry } from "./fixtures.js";

const registry = testRegistry();
const plans = [
  ...matrixPlans(registry).map(([m, n, plan]) => [`${m} — ${n}`, plan] as const),
  ...mvpPlans(registry).map((p) => [p.name, p.plan] as const),
];

/** Roles of the public front: the public role and the roles with self sign-up (clients). */
const frontRoles = (spec: AppSpec) =>
  new Set(spec.roles.filter((r) => r.access === "public" || r.selfSignup).map((r) => r.name));
const backEnd = ({ pages: _p, ...rest }: AppSpec) => rest;

describe("V3-10: backend mode — modules compile as back-end recipes without public screens", () => {
  test.each(plans)("%s", (_name, plan) => {
    const v2 = compiled(plan, registry);
    const be = compiled(plan, registry, { front: "backend" });
    const front = frontRoles(be.spec);

    // No public pages: no page for the public role or the clients, no «/», no public screen file.
    const pages = be.spec.pages ?? [];
    expect(pages.filter((p) => p.roles.some((r) => front.has(r)))).toEqual([]);
    expect(pages.map((p) => p.route)).not.toContain("/");
    expect(Object.keys(be.files).filter((f) => f.startsWith("ui/") && !f.startsWith("ui/lib/"))).toEqual(
      expect.not.arrayContaining([
        "ui/pages/Home.tsx",
        "ui/pages/BookingBooking.tsx",
        "ui/pages/CatalogServices.tsx",
      ]),
    );
    expect(be.front).toBe("backend");

    // The same back end: entities, roles, permissions (RLS), automations, integrations, functions, acceptance,
    // compliance; the same metrics and goal scenarios; function sources byte for byte.
    expect(backEnd(be.spec)).toEqual(backEnd(v2.spec));
    expect(be.metrics).toEqual(v2.metrics);
    expect(be.scenarios.map(({ surface: _s, hooks: _h, ...s }) => s)).toEqual(v2.scenarios);
    for (const [f, src] of Object.entries(v2.files))
      if (f.startsWith("functions/")) expect(be.files[f], f).toBe(src);

    // Staff cabinets stay as in v2; every page v2 had beyond them is a module screen left to the v3 front (or the
    // engine's start page «/»).
    const kept = new Set(pages.map((p) => p.route));
    for (const p of v2.spec.pages ?? []) {
      if (kept.has(p.route)) {
        expect(pages).toContainEqual(p);
        expect(be.files[p.file], p.file).toBe(v2.files[p.file]);
      } else if (p.route !== "/" || be.publicFront?.screens.some((s) => s.route === "/"))
        expect(be.publicFront?.screens.map((s) => s.route)).toContain(p.route);
    }
    for (const s of be.publicFront?.screens ?? []) {
      expect(["public", "visitor"]).toContain(s.audience);
      expect(kept.has(s.route)).toBe(false);
    }

    // A valid spec whose ПДн are marked and kept no longer than a retention period (G2-PII-02, G2-PII-05).
    expect(validateSpec(be.spec).ok).toBe(true);
    expect(piiMarkup(be.spec)).toEqual([]);
    expect(piiRetention(be.spec)).toEqual([]);

    // Goal scenarios stay checkable: a visitor's or client's scenario runs on the v3 front through the hooks of the
    // public actions of its modules; the rest — in the staff cabinets.
    for (const s of be.scenarios) {
      const pub = s.steps.some((x) => x.actor === "visitor" || x.actor === "client");
      expect(s.surface, s.id).toBe(pub ? "public" : "cabinet");
      const modules = new Set([s.module, ...(s.withModules ?? [])]);
      const expected = new Set(
        (be.publicFront?.actions ?? []).filter((a) => modules.has(a.module)).map((a) => a.hook),
      );
      expect(new Set(s.hooks ?? []), s.id).toEqual(pub ? expected : new Set());
    }
  });
});

describe("V3-10: public front of a backend system", () => {
  const all = compiled(mvpPlans(registry).find((p) => p.name === "все модули")?.plan, registry, {
    front: "backend",
  });
  const action = (entity: string) => all.publicFront?.actions.find((a) => a.entity === entity);

  test("module screens of the site and the client cabinet are left to v3, staff cabinets stay", () => {
    expect(all.publicFront?.screens.map((s) => `${s.module}:${s.id} ${s.route}`).sort()).toEqual(
      [
        "booking:booking /booking",
        "catalog:services /services",
        "landing:credits /photos",
        "landing:home /",
        "packages:materials /materials",
        "visitor_cabinet:me /me",
        // V3-24 «Контент и блог»: the lists and the entry pages of the v3 front.
        "content:blog /blog",
        "content:article /blog/:slug",
        "content:rubric /blog/rubric/:slug",
        "content:pages /pages",
        "content:site_page /pages/:slug",
        // V3-23 «Интернет-магазин»: the goods, the cart with the checkout, the order's page.
        "shop:shop /shop",
        "shop:cart /cart",
        "shop:order /order/:id",
      ].sort(),
    );
    expect((all.spec.pages ?? []).map((p) => p.route)).toEqual(
      expect.arrayContaining(["/cabinet", "/cabinet-staff", "/deals", "/clients", "/cabinet/goals"]),
    );
  });

  test("public data actions name the headless hook, the entity, the roles and the public functions", () => {
    expect(action("lead")).toMatchObject({
      hook: "useLeadForm",
      module: "leads",
      roles: ["guest"],
      ops: ["create"],
    });
    expect(action("service")).toMatchObject({ hook: "useCatalog", module: "catalog", ops: ["read"] });
    expect(action("site_photo")).toMatchObject({ hook: "useContent", module: "landing" });
    expect(action("client_package")).toMatchObject({ hook: "useContent", roles: ["visitor"] });
    const booking = action("booking");
    expect(booking).toMatchObject({ hook: "useBooking", module: "booking", functions: ["busySlots"] });
    expect(booking?.booking).toMatchObject({
      serviceEntity: "service",
      durationField: "duration_min",
      consentMessagesField: "consent_messages",
      schedule: { tz: "Europe/Moscow", days: [1, 2, 3, 4, 5], start: 540, end: 1080, step: 60, capacity: 1 },
    });
    expect(all.publicFront?.functions.map((f) => f.name).sort()).toEqual(
      ["busySlots", "myMaterials", "packageCheck", "shopCdekOptions", "shopOrder", "shopPlaceOrder"].sort(),
    );
    // V3-23: the goods of «Интернет-магазин» with the checkout the v3 shop patterns pass to the headless shop.
    expect(action("product")).toMatchObject({
      hook: "useShop",
      module: "shop",
      ops: ["read"],
      functions: expect.arrayContaining(["shopPlaceOrder", "shopOrder", "shopCdekOptions"]),
      shop: {
        online: true,
        stockField: "stock",
        categoryEntity: "product_category",
        placeFn: "shopPlaceOrder",
        payment: { integration: "shop_pay", binding: "order" },
        orderPath: "/order/",
        methods: [
          { value: "pickup", label: "Самовывоз" },
          { value: "cdek", label: "СДЭК, пункт выдачи" },
        ],
      },
    });
    expect(action("pickup_point")).toMatchObject({ hook: "useContent", module: "shop" });
  });

  test("the lead and booking scenarios stay checkable on the v3 front", () => {
    const by = (id: string) => all.scenarios.find((s) => s.id === id);
    expect(by("GS-leads-1")).toMatchObject({ surface: "public", hooks: ["useLeadForm"] });
    expect(by("GS-booking-1")).toMatchObject({
      surface: "public",
      hooks: expect.arrayContaining(["useBooking"]),
    });
    expect(by("GS-deals-1")?.surface).toBe("cabinet");
  });

  // Acceptance 3 for now: staff cabinets stay the library's and take the client's theme tokens (themes v2: preset,
  // accent, font pair); the v3 design system reaches them through the same tokens when the harness connects it.
  test("staff cabinets stay from the library and take the plan's theme tokens", () => {
    const plan = structuredClone(mvpPlans(registry).find((p) => p.name === "mvp-07 CRM агентства")?.plan);
    if (!plan) throw new Error("no plan");
    plan.design = {
      ...plan.design,
      theme: "boutique",
      accent: "#7A3E9D",
      fontPair: { heading: "Cormorant Garamond", body: "Commissioner" },
    };
    const be = compiled(plan, registry, { front: "backend" });
    expect(be.spec.theme).toEqual({
      accent: "#7A3E9D",
      preset: "boutique",
      font: "Commissioner",
      headingFont: "Cormorant Garamond",
    });
    const cabinet = (be.spec.pages ?? []).find((p) => p.route === "/cabinet");
    expect(cabinet?.roles).toEqual(["owner"]);
    expect(be.files[cabinet?.file ?? ""]).toContain('from "@wizard/ui-kit"');
  });

  test("notes about the v2 public pages are left out", () => {
    const v2 = compiled(mvpPlans(registry).find((p) => p.name === "все модули")?.plan, registry);
    expect(v2.warnings.some((w) => w.includes("«Услуги из каталога»"))).toBe(true);
    expect(all.warnings.some((w) => w.includes("«Услуги из каталога»"))).toBe(false);
  });
});

describe("V3-10: the v2 path does not change", () => {
  test.each(plans)("%s: default = {front: 'v2'}, without backend fields", (_name, plan) => {
    const a = compilePlan(plan, registry, { appName: "Проверка" }) as CompileSuccess;
    const b = compilePlan(plan, registry, { appName: "Проверка", front: "v2" }) as CompileSuccess;
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.front).toBeUndefined();
    expect(a.publicFront).toBeUndefined();
    expect(a.scenarios.some((s) => "surface" in s || "hooks" in s)).toBe(false);
  });

  test("backend mode is deterministic", () => {
    for (const { plan } of mvpPlans(registry)) {
      const a = compiled(plan, registry, { front: "backend" });
      const b = compiled(plan, registry, { front: "backend" });
      expect(compiledFingerprint(b)).toBe(compiledFingerprint(a));
      expect(JSON.stringify(b.publicFront)).toBe(JSON.stringify(a.publicFront));
    }
  });
});
