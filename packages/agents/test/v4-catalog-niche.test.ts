// V4-29 (acceptance build, defects 3 and 4): a menu or goods are ordered, not booked, and have no duration on the home
// preview (a coffee house showed «Капучино 200 ₽ / 2 ч» with «Записаться»), while services keep both; specialists the
// owner gave without names (the interview scrubs every answer: «имя — стилист-колорист») are one column of roles with
// a capital letter, never a table with an empty name column.
import { type SystemBrief, systemBriefSchema } from "@wizard/appspec";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { dentalBrief } from "../../appspec/test/brief-fixtures.js";
import { type SectionContext, sectionProps } from "../src/builder/v3/compose/content.js";
import type { SiteFacts } from "../src/builder/v3/compose/facts.js";
import type { PlannedPage } from "../src/builder/v3/compose/site.js";
import { STAFF_QUESTION_TEXT, staffFacts } from "../src/interview-v3/index.js";
import { addQa } from "../src/interview-v3/merge.js";

const page = (kind: PlannedPage["kind"], route: string, title: string): PlannedPage => ({
  kind,
  route,
  title,
  roles: ["guest"],
});
const HOME = page("home", "/", "Главная");
const MENU = page("catalog", "/services", "Меню");
const BOOKING = page("booking", "/booking", "Предзаказ");

const facts = (niche: string, texts: Record<string, Record<string, unknown>> = {}): SiteFacts =>
  ({
    name: "Проверка",
    niche,
    goals: [],
    texts: new Map(Object.entries(texts)),
    copy: { title: "Проверка", about: niche, home: "Проверка", site: "Проверка" },
    photos: [],
    places: [],
    policyPage: "/privacy",
    bookingByRequest: false,
    year: 2026,
    numbers: new Set<string>(),
    prices: true,
  }) as SiteFacts;

const ctx = (f: SiteFacts, at: PlannedPage, pages: PlannedPage[], leadForm?: string): SectionContext => ({
  facts: f,
  page: at,
  pages,
  primary: null,
  secondary: null,
  binding: { needs: "catalog", action: { hook: "useCatalog", entity: "service" } as never },
  homeSections: [],
  ...(leadForm ? { leadForm } : {}),
});

describe("V4-29 defect 3: the catalog of a menu or goods", () => {
  test("a coffee house: «Заказать» on every item, no duration on the home preview; its page keeps the duration", () => {
    const f = facts("кофейня");
    const home = sectionProps("catalog", ctx(f, HOME, [HOME, MENU, BOOKING]));
    expect(home?.itemAction).toEqual({ label: "Заказать", path: "/booking" });
    expect(home?.fields).toEqual({ duration: null });
    const own = sectionProps("catalog", ctx(f, MENU, [HOME, MENU, BOOKING]));
    expect(own?.itemAction).toEqual({ label: "Заказать", path: "/booking" });
    // GS-catalog-3 opens the catalog's page: the duration the module has stays there.
    expect(own?.fields).toBeUndefined();
    // Without a booking the item goes to the request form — an order too.
    const lead = sectionProps("catalog", ctx(facts("пекарня"), HOME, [HOME, MENU], "/#form"));
    expect(lead?.itemAction).toEqual({ label: "Заказать", path: "/#form" });
    // Every variant of the home preview takes «no duration».
    const grid = PATTERNS.find((p) => p.id === "catalog-grid");
    expect(grid?.slots.safeParse(home).success).toBe(true);
  });

  test("services (a salon, a clinic, a car service) keep «Записаться» and the duration", () => {
    for (const niche of ["салон красоты", "стоматология", "автосервис"]) {
      const home = sectionProps("catalog", ctx(facts(niche), HOME, [HOME, MENU, BOOKING]));
      expect(home?.itemAction, niche).toEqual({ label: "Записаться", path: "/booking" });
      expect(home?.fields, niche).toBeUndefined();
    }
    const lead = sectionProps("catalog", ctx(facts("стоматология"), HOME, [HOME, MENU], "/#form"));
    expect(lead?.itemAction).toEqual({ label: "Оставить заявку", path: "/#form" });
  });
});

describe("V4-29 defect 4: specialists without names", () => {
  test("the scrubbed staff answer gives the roles alone, with a capital letter", () => {
    const brief: SystemBrief = { ...systemBriefSchema.parse(dentalBrief()), qa: [] };
    addQa(brief, {
      q: STAFF_QUESTION_TEXT,
      a: "Дарья Орлова — стилист-колорист, Алина Шарипова — стилист, Ксения Белова — мастер маникюра",
      recommended: "x",
      chosen: "custom",
    });
    expect(brief.qa[0]?.a).toContain("имя — стилист-колорист");
    expect(staffFacts(brief)).toEqual(["Стилист-колорист", "Стилист", "Мастер маникюра"]);
    // Names the brief keeps stay as the owner wrote them.
    const named = {
      qa: [{ q: STAFF_QUESTION_TEXT, a: "Анна Смирнова — терапевт", recommended: "x", chosen: "custom" }],
    };
    expect(staffFacts(named as never)).toEqual(["Анна Смирнова — терапевт"]);
  });

  test("a team of roles only goes to the variant that shows roles alone (team-credits, one column)", () => {
    const f = facts("салон красоты", {
      team: {
        title: "Кто вас примет",
        items: [{ role: "стилист-колорист" }, { role: "стилист" }, "мастер маникюра"],
      },
    });
    const props = sectionProps("team", ctx(f, HOME, [HOME]));
    expect(props?.people).toEqual([
      { role: "стилист-колорист" },
      { role: "стилист" },
      { role: "мастер маникюра" },
    ]);
    const fits = PATTERNS.filter((p) => p.sectionType === "team" && p.slots.safeParse(props).success);
    expect(fits.map((p) => p.id)).toEqual(["team-credits"]);
  });
});
