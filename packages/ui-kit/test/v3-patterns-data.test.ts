// V3-08 (node): the module-bound section types of the pattern library — form (needs lead | booking), catalog (needs
// catalog), blog (needs content): 8–12 structurally different variants each, every variant binds the headless hook of
// its need (C4) and keeps the logic out of the markup, forms carry the personal data consent (G2-PII-04), slots accept
// only AppSpec identifiers and the module's booking configuration. Rendering, interactions and states in Chromium —
// packages/build/test/patterns-v3-data.browser.test.ts.
import { describe, expect, test } from "vitest";
import { lintPattern, PATTERNS, type PatternNeeds } from "../src/v3/patterns/index.js";

const TYPES = {
  form: ["lead", "booking"],
  catalog: ["catalog"],
  blog: ["content"],
} as const satisfies Record<string, readonly PatternNeeds[]>;

const HOOK: Record<string, string> = {
  lead: "useLeadForm",
  booking: "useBooking",
  catalog: "useCatalog",
  content: "useContent",
};

const of = (type: string) => PATTERNS.filter((p) => p.sectionType === type);

describe("module-bound section types", () => {
  test.each(Object.entries(TYPES))(
    "%s: 8–12 variants, at least 6 layout families, each bound to a module need",
    (type, needs) => {
      const list = of(type);
      expect(list.length).toBeGreaterThanOrEqual(8);
      expect(list.length).toBeLessThanOrEqual(12);
      expect(new Set(list.map((p) => p.layout)).size).toBeGreaterThanOrEqual(6);
      for (const p of list) expect(needs as readonly PatternNeeds[], p.id).toContain(p.needs);
    },
  );

  test("every variant binds its hook from @wizard/ui-kit/v3/headless and passes the pattern lint", () => {
    for (const type of Object.keys(TYPES))
      for (const p of of(type)) {
        expect(p.source, p.id).toMatch(/from "@wizard\/ui-kit\/v3\/headless"/);
        expect(p.source, p.id).toContain(`${HOOK[p.needs ?? ""]}(`);
        expect(lintPattern(p.source, p.file), p.id).toEqual([]);
        // No data API of its own: the module's hooks read and write (C4).
        expect(p.source, p.id).not.toMatch(/fetch\(|\/api\/data|@wizard\/sdk/);
      }
  });

  test("forms show the consent of the form model with the policy link, labels and errors tied to their fields", () => {
    for (const p of of("form")) {
      expect(p.source, p.id).toContain("form.consent");
      expect(p.source, p.id).toContain("policyPage");
      expect(p.source, p.id).toContain("политикой обработки персональных данных");
      expect(p.source, p.id).toMatch(/htmlFor=\{id\}/);
      expect(p.source, p.id).toContain('"aria-describedby": error ? errId : undefined');
      expect(p.source, p.id).toContain('role="alert"');
    }
  });

  test("lists say loading, empty and error in Russian, page with «Показать ещё» and keep prices to the data", () => {
    for (const type of ["catalog", "blog"])
      for (const p of of(type)) {
        expect(p.source, p.id).toMatch(/Загружаем (каталог|записи)…/);
        expect(p.source, p.id).toMatch(/Не получилось загрузить/);
        expect(p.source, p.id).toContain("Показать ещё");
        const code = p.source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
        expect(code, p.id).not.toMatch(/\d\s?₽|по запросу|от \d/);
      }
  });

  test("slots take AppSpec identifiers and the module's booking configuration only", () => {
    const grid = PATTERNS.find((p) => p.id === "catalog-grid");
    const booking = PATTERNS.find((p) => p.id === "form-booking-grid");
    const inline = PATTERNS.find((p) => p.id === "form-inline");
    if (!grid || !booking || !inline) throw new Error("patterns missing");
    const ex = (p: typeof grid) => p.example as Record<string, unknown>;
    expect(grid.slots.safeParse({ ...ex(grid), entity: "Service; drop" }).success).toBe(false);
    expect(
      grid.slots.safeParse({ ...ex(grid), itemAction: { label: "Записаться", path: "https://x.ru" } })
        .success,
    ).toBe(false);
    expect(inline.slots.safeParse({ ...ex(inline), fields: ["name", "Phone"] }).success).toBe(false);
    const { booking: binding, ...noBinding } = ex(booking);
    expect(binding).toBeDefined();
    expect(booking.slots.safeParse(noBinding).success).toBe(false);
    const b = binding as { schedule: Record<string, unknown> };
    expect(
      booking.slots.safeParse({ ...ex(booking), booking: { ...b, schedule: { ...b.schedule, days: [7] } } })
        .success,
    ).toBe(false);
    // The sections variants need the section entity.
    const sections = PATTERNS.find((p) => p.id === "catalog-sections");
    const { categoryEntity: _c, ...flat } = ex(grid);
    expect(sections?.slots.safeParse(flat).success).toBe(false);
  });
});

// V3-18: the hooks the modules' goal scenarios look for on a v3 page (builder-v3.md C3, the DOM contract of ui-kit v2).
describe("the DOM contract of the goal scenarios", () => {
  const slotNames = (p: (typeof PATTERNS)[number]) =>
    Object.keys((p.slots as unknown as { shape?: Record<string, unknown> }).shape ?? {});

  test("first screens: the root is Hero with the build's wzId, the main action is wz-hero-primary", () => {
    for (const p of of("hero")) {
      expect(p.source, p.id).toMatch(/<section\s+data-wz-component="Hero"\s+data-wz-id=\{wzId\}/);
      expect(p.source, p.id).toMatch(/href=\{action\.href\}\s+data-testid="wz-hero-primary"/);
      expect(p.source.match(/wz-hero-primary/g)?.length, p.id).toBe(1);
    }
  });

  test("forms: LeadForm or BookingForm roots, fields by name, the steps and states of a booking", () => {
    for (const p of of("form")) {
      const root = p.needs === "booking" ? "BookingForm" : "LeadForm";
      expect(p.source, p.id).toMatch(
        new RegExp(`data-wz-component="${root}"\\s+data-wz-id=\\{(props\\.)?wzId\\}`),
      );
      // Text of the pattern source (a template literal of the TSX), not a template here.
      expect(p.source, p.id).toContain(["data-testid={`wz-field-$", "{field.name}`}"].join(""));
      if (p.needs !== "booking") continue;
      for (const hook of [
        'data-testid="booking-page"',
        "booking-day",
        'data-testid="booking-time"',
        'data-testid="booking-slots"',
        'data-testid="booking-form"',
        'data-testid="booking-done"',
        'data-testid="wz-empty"',
      ])
        expect(p.source, `${p.id}: ${hook}`).toContain(hook);
      // The service step: a list (testid) or radio cards (booking-${name} of the choice named «service»).
      expect(p.source, p.id).toMatch(
        /testid="booking-service"|name="service"[\s\S]*booking-\$\{name\}|booking-\$\{name\}[\s\S]*name="service"/,
      );
      // A choice of specialists is marked wherever the pattern offers one.
      if (p.source.includes('label="Специалист"') || p.source.includes('legend="Специалист"'))
        expect(p.source, p.id).toMatch(/booking-specialist|booking-\$\{name\}/);
    }
    // A form in steps says which step is on the screen; a booking in steps marks its «Далее».
    expect(of("form").find((p) => p.id === "form-stepper")?.source).toContain(
      "data-wz-steps={groups.length}",
    );
    expect(of("form").find((p) => p.id === "form-booking-steps")?.source).toContain(
      'data-testid="booking-next"',
    );
  });

  test("catalog items are wz-itemcard, their action wz-itemcard-cta; durations in minutes below two hours", () => {
    for (const p of of("catalog")) {
      expect(p.source, p.id).toContain('data-testid="wz-itemcard"');
      if (slotNames(p).includes("itemAction"))
        expect(p.source, p.id).toContain('data-testid="wz-itemcard-cta"');
      expect(p.source, p.id).toContain(["if (v < 120) return `$", "{v} мин`;"].join(""));
    }
  });
});
