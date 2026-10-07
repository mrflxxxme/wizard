// B2-35: the section library in the landing module — every variant of SECTION_CATALOG is ready, has a renderer and is
// in some row of the CI matrix (which G0/G1 run in gates.test.ts and in the browser in sections.browser.test.ts); the
// page renders each section type with its ui-kit block; prices come from the data of the plan's modules.
import { type PlanSection, SECTION_CATALOG, type SystemPlan, THEME_PRESETS } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  type CompileSuccess,
  compilePlan,
  LANDING_MATRIX,
  landingManifest,
  librarySections,
  matrixPlan,
  SECTION_RENDERERS,
  sectionBands,
} from "../src/index.js";
import { testRegistry } from "./fixtures.js";

const registry = testRegistry();
/** ui-kit block (or the catalog showcase) of each section type. */
const BLOCK: Readonly<Record<string, string>> = {
  header: "Header",
  hero: "Hero",
  features: "Features",
  steps: "Steps",
  services: "ServiceShowcase",
  pricing: "Pricing",
  booking: "Booking",
  lead_form: "LeadForm",
  gallery: "Gallery",
  team: "Team",
  testimonials: "Testimonials",
  stats: "Stats",
  about: "About",
  faq: "Faq",
  cta: "Cta",
  contacts: "Contacts",
  hours: "Hours",
  logos: "Logos",
  text: "TextBlock",
  footer: "Footer",
};
const ok = (r: ReturnType<typeof compilePlan>): CompileSuccess => {
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return r;
};

/** A plan with «Абонементы и пакеты» and a landing, without the catalog; `pricing` — the section to add. */
function packagesPricingPlan(pricing: PlanSection): SystemPlan {
  const plan = matrixPlan(registry, "packages", {
    name: "тарифы на лендинге",
    params: { kind: "visits", write_off_on_booking: false, expiry_reminder_days: 0 },
    withModules: ["client_card", "landing"],
  });
  const sections = [...(plan.landing?.sections ?? [])];
  sections.splice(sections.length - 1, 0, pricing);
  return { ...plan, landing: { sections } };
}

describe("section library (B2-35)", () => {
  test("20 types × 3–5 layouts; every variant is ready, rendered and in a matrix row", () => {
    expect(SECTION_CATALOG.length).toBeGreaterThanOrEqual(15);
    expect(SECTION_CATALOG.length).toBeLessThanOrEqual(20);
    const inRows = new Set(LANDING_MATRIX.flatMap((r) => r.sections.map((s) => `${s.type}/${s.variant}`)));
    for (const t of SECTION_CATALOG) {
      expect(t.variants.length, t.type).toBeGreaterThanOrEqual(3);
      expect(t.variants.length, t.type).toBeLessThanOrEqual(5);
      expect([...t.ready], t.type).toEqual([...t.variants]);
      expect(SECTION_RENDERERS[t.type], t.type).toBeDefined();
      for (const v of t.variants) expect(inRows.has(`${t.type}/${v}`), `${t.type}/${v}`).toBe(true);
    }
    expect(landingManifest.tests?.matrix.map((r) => r.name)).toEqual(
      expect.arrayContaining(LANDING_MATRIX.map((r) => r.name)),
    );
    // Rows try themes v2 too.
    expect(new Set(LANDING_MATRIX.map((r) => r.theme)).size).toBe(LANDING_MATRIX.length);
    for (const r of LANDING_MATRIX) expect(THEME_PRESETS).toContain(r.theme);
  });

  test.each(LANDING_MATRIX.map((r, k) => [r.name, k] as const))(
    "%s: the page has every block with its layout, anchors and rhythm",
    (_n, k) => {
      const row = LANDING_MATRIX[k] as (typeof LANDING_MATRIX)[number];
      const r = ok(compilePlan(matrixPlan(registry, "landing", row), registry, { appName: "Пример" }));
      const home = r.files["ui/pages/Home.tsx"] ?? "";
      for (const s of librarySections(k)) {
        expect(home, s.type).toContain(`<${BLOCK[s.type]} `);
      }
      for (const s of librarySections(k).filter((x) => x.type !== "services"))
        expect(home).toContain(`variant="${s.variant}"`);
      expect(home).toContain(`layout="${librarySections(k).find((s) => s.type === "services")?.variant}"`);
      expect(home).toContain('tone="alt"');
      expect(home).toContain('action={{"label":"Записаться","href":"/booking"}}');
      expect(r.spec.theme?.preset).toBe(row.theme);
    },
  );

  test("bands of the design rhythm (B2-37): every 2nd body section, airy — every 3rd, the section's own band wins", () => {
    const types = ["header", "hero", "features", "steps", "faq", "about", "cta", "footer"].map((type) => ({
      type,
    }));
    expect(sectionBands(types, undefined)).toEqual([null, null, "base", "alt", "base", "alt", null, null]);
    expect(sectionBands(types, "airy")).toEqual([null, null, "base", "base", "alt", "base", null, null]);
    const own = types.map((t, i) => (i === 2 ? { ...t, band: "alt" as const } : t));
    expect(sectionBands(own, "airy")[2]).toBe("alt");
    // Odd matrix rows set the bands by hand: the alternate band is on the page where the row put it.
    const row = LANDING_MATRIX[1] as (typeof LANDING_MATRIX)[number];
    expect(row.sections.some((s) => s.band === "alt")).toBe(true);
    const home =
      ok(compilePlan(matrixPlan(registry, "landing", row), registry)).files["ui/pages/Home.tsx"] ?? "";
    expect(home.match(/tone="alt"/g)?.length).toBe(
      sectionBands(row.sections, undefined).filter((b) => b === "alt").length,
    );
  });

  test("texts from the plan: plain strings and objects become items; nothing is invented", () => {
    const r = ok(compilePlan(matrixPlan(registry, "landing", LANDING_MATRIX[0] as never), registry));
    const home = r.files["ui/pages/Home.tsx"] ?? "";
    expect(home).toContain(
      'items={[{"value":"Пример: 10 лет","label":"опыт"},{"value":"Пример: 500","label":"клиентов"}]}',
    );
    expect(home).toContain(
      'items={[{"day":"Пн–Пт","time":"10:00–20:00"},{"day":"Сб","time":"11:00–18:00"}]}',
    );
    expect(home).toContain('items={[{"name":"Пример: партнёр"}]}');
    expect(home).toContain('items={[{"name":"Пример: мастер","role":"Пример: стрижки"}]}');
    // Prices are read from the catalog, never written into the page.
    expect(home).toContain('entity={"service"}');
    expect(home).not.toMatch(/₽/);
  });

  test("prices without the catalog: tariffs of packages, visitors read them", () => {
    const r = ok(
      compilePlan(
        packagesPricingPlan({ type: "pricing", variant: "table", content: { title: "Пример: тарифы" } }),
        registry,
      ),
    );
    const home = r.files["ui/pages/Home.tsx"] ?? "";
    expect(home).toContain('entity={"package_plan"}');
    expect(home).toContain('details={[{"field":"visits","suffix":"визитов"}]}');
    expect(home).toContain('query={{"filter":{"active":true}}}');
    const guest = r.spec.permissions.find((p) => p.role === "guest" && p.entity === "package_plan");
    expect(guest?.ops).toEqual(["read"]);
    // Without a pricing section the tariffs stay closed.
    const closed = ok(
      compilePlan(
        packagesPricingPlan({ type: "text", variant: "plain", content: { text: "Пример" } }),
        registry,
      ),
    );
    expect(closed.spec.permissions.some((p) => p.role === "guest" && p.entity === "package_plan")).toBe(
      false,
    );
  });

  test("a gallery without items shows six tiles: a photo slot each (B2-38), the theme graphic without photos", () => {
    const plan = matrixPlan(registry, "landing", { name: "g", params: {} });
    const sections = [...(plan.landing?.sections ?? [])];
    sections.splice(2, 0, { type: "gallery", variant: "masonry", content: { title: "Пример: работы" } });
    const r = ok(compilePlan({ ...plan, landing: { sections } }, registry));
    const home = r.files["ui/pages/Home.tsx"];
    expect(home).toContain('{ ...{}, image: photo("gallery") }');
    expect(home).toContain('{ ...{}, image: photo("gallery-6") }');
    const off = matrixPlan(registry, "landing", { name: "g", params: { photos: false } });
    const r2 = ok(compilePlan({ ...off, landing: { sections } }, registry));
    expect(r2.files["ui/pages/Home.tsx"]).toContain("items={[{},{},{},{},{},{}]}");
    expect(r2.files["ui/pages/Home.tsx"]).not.toContain("useSitePhotos");
  });
});
