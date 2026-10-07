// B2-45 (D76 measurement screenshots): «/» of a system without the landing is a public home with the plan's actions
// (booking, catalog, lead form, the visitor's records) and a quiet sign-in for the team, or a staff sign-in page for a
// back-office system; the landing's header menu has no near-duplicates (navLinks).
import type { PlanSection, SystemPlan } from "@wizard/appspec";
import { describe, expect, it } from "vitest";
import { compilePlan, MAX_NAV_LINKS, navLinks, sameNavLabel, sectionAnchors } from "../src/index.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";
import { libraryPlan, yogaPlan } from "./fixtures-b218.js";

const registry = testRegistry();

const goalOf = (id: string) =>
  registry.modules.find((d) => d.manifest.id === id)?.manifest.goals[0] as SystemPlan["goals"][number]["id"];

function plan(niche: string, modules: SystemPlan["modules"]): SystemPlan {
  const base = landingLeadsPlan();
  return {
    ...base,
    niche,
    goals: [{ id: goalOf(modules[0]?.id ?? ""), statement: "Цель системы для проверки главной" }],
    modules,
    landing: undefined,
    outOfScope: [],
    custom: [],
  };
}

function home(p: SystemPlan, appName?: string) {
  const r = compilePlan(p, registry, appName ? { appName } : {});
  if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
  return { r, home: r.files["ui/pages/Home.tsx"] ?? "" };
}

const CATALOG = { id: "catalog", params: { with_duration: true } };

describe("home page without the landing", () => {
  it("beauty salon (catalog, booking, notify, staff): booking first, services and the team's sign-in", () => {
    const { r, home: h } = home(
      plan("салон красоты", [CATALOG, { id: "booking" }, { id: "notify" }, { id: "staff" }]),
      "Студия «Лён»",
    );
    expect(r.spec.pages?.find((p) => p.route === "/")?.file).toBe("ui/pages/Home.tsx");
    expect(h).not.toContain("Открыть кабинет");
    expect(h).toContain(
      '<Header brand={"Студия «Лён»"} links={[{"label":"Услуги и цены","href":"/services"}]} cta={{"label":"Записаться","href":"/booking"}} sticky />',
    );
    expect(h).toContain(
      '<Hero title={"Студия «Лён»"} subtitle={"Запись онлайн: выберите услугу и удобное время."}',
    );
    expect(h).toContain('eyebrow={"Салон красоты"}');
    expect(h).toContain(
      'primary={{"label":"Записаться","href":"/booking"}} secondary={{"label":"Услуги и цены","href":"/services"}}',
    );
    expect(h).toContain('<Steps title={"Как записаться"}');
    expect(h).toContain(
      '<ServiceShowcase title={"Услуги и цены"} anchor="services" layout="cards" tone="alt" />',
    );
    expect(h).toContain('import { ServiceShowcase } from "./CatalogServices";');
    expect(h).toContain('{"label":"Войти в кабинет","href":"/login?next=%2Fcabinet"}');
    expect(h).not.toContain("<LeadForm");
  });

  it("meeting room (catalog, booking, notify) with the visitor cabinet: «Мои записи» through the visitor's sign-in", () => {
    const { home: h } = home(
      plan("переговорная в коворкинге", [
        CATALOG,
        { id: "booking" },
        { id: "notify" },
        { id: "visitor_cabinet", params: { show_bookings: true } },
      ]),
    );
    expect(h).toContain('{"label":"Мои записи","href":"/login?role=visitor&next=%2Fme"}');
    expect(h).toContain('cta={{"label":"Записаться","href":"/booking"}}');
    // The name is the niche: no line above it.
    expect(h).not.toContain("eyebrow=");
  });

  it("leads without the landing: the lead form on «/» (the goal scenario opens it there), catalog «Выбрать» → #lead", () => {
    const { r, home: h } = home(
      plan("ремонт квартир", [{ id: "leads" }, { id: "notify" }, { id: "catalog" }]),
    );
    expect(h).toContain('cta={{"label":"Оставить заявку","href":"#lead"}}');
    expect(h).toContain('<LeadForm entity={"lead"} title={"Оставьте заявку"}');
    expect(h).toContain('anchor="lead"');
    expect(r.files["ui/pages/CatalogServices.tsx"]).toContain('location.assign("/#lead")');
  });

  it("CRM (deals, clients, resources): a staff sign-in page, not an empty canvas", () => {
    const { home: h } = home(
      plan("агентство недвижимости", [
        { id: "deals" },
        { id: "client_card" },
        { id: "resources" },
        { id: "notify" },
      ]),
      "Квартал",
    );
    expect(h).toContain("Рабочее пространство команды");
    expect(h).toContain('primary={{"label":"Войти","href":"/login?next=%2Fcabinet"}}');
    expect(h).toContain('variant="minimal"');
    expect(h).not.toContain("links=");
    expect(h).not.toContain("<LeadForm");
  });

  it("online school (packages, visitor cabinet, no public pages): the students' sign-in leads, not the staff page", () => {
    const { home: h } = home(yogaPlan());
    expect(h).toContain('cta={{"label":"Личный кабинет","href":"/login?role=visitor&next=%2Fme"}}');
    expect(h).toContain('{"label":"Материалы","href":"/login?role=visitor&next=%2Fmaterials"}');
    expect(h).toContain('{"label":"Войти в кабинет","href":"/login?next=%2Fcabinet"}');
    expect(h).not.toContain("Рабочее пространство");
  });

  it("library (resources, clients, staff): the staff sign-in page", () => {
    expect(home(libraryPlan()).home).toContain("Рабочее пространство команды");
  });

  it("is deterministic", () => {
    const p = plan("салон красоты", [CATALOG, { id: "booking" }, { id: "notify" }, { id: "staff" }]);
    expect(home(p).home).toBe(home(p).home);
  });
});

describe("landing header menu (navLinks)", () => {
  const sections: PlanSection[] = [
    { type: "header", variant: "bar", content: { cta: "Записаться" } },
    { type: "hero", variant: "split", content: { title: "Юрист для бизнеса" } },
    { type: "features", variant: "grid", content: { title: "Почему мы" } },
    { type: "lead_form", variant: "card", content: { title: "Записаться на консультацию" } },
    { type: "steps", variant: "numbered", content: { title: "Как мы работаем" } },
    { type: "cta", variant: "card", content: { title: "Запишитесь на консультацию", cta: "Записаться" } },
    { type: "faq", variant: "accordion", content: { title: "Вопросы и ответы" } },
    { type: "about", variant: "split", content: { title: "О нас" } },
    { type: "testimonials", variant: "grid", content: { title: "Отзывы клиентов" } },
    { type: "contacts", variant: "simple", content: { title: "Контакты" } },
    { type: "footer", variant: "simple", content: {} },
  ];
  const anchors = sectionAnchors(sections);

  it("one item for the lead form and the call to action; near-duplicate labels collapse", () => {
    expect(sameNavLabel("Записаться на консультацию", "Запишитесь на консультацию!")).toBe(true);
    expect(sameNavLabel("Отзывы", "Отзывы клиентов")).toBe(true);
    expect(sameNavLabel("Контакты", "Отзывы")).toBe(false);
    const links = navLinks(sections, anchors, "#lead", "Записаться");
    expect(links.map((l) => l.label)).toEqual([
      "Почему мы",
      "Записаться на консультацию",
      "Как мы работаем",
      "Вопросы и ответы",
    ]);
    expect(links.length).toBeLessThanOrEqual(MAX_NAV_LINKS);
    expect(links.filter((l) => /запи/i.test(l.label))).toHaveLength(1);
  });

  it("an item equal to the header button and a repeated title are dropped", () => {
    const s: PlanSection[] = [
      { type: "header", variant: "bar", content: { cta: "Цены" } },
      { type: "pricing", variant: "cards", content: { title: "Цены!" } },
      { type: "features", variant: "grid", content: { title: "Наши преимущества" } },
      { type: "about", variant: "split", content: { title: "Преимущества" } },
      { type: "lead_form", variant: "card", content: { title: "Оставьте заявку" } },
    ];
    expect(navLinks(s, sectionAnchors(s), "#lead", "Цены").map((l) => l.label)).toEqual([
      "Наши преимущества",
      "Оставьте заявку",
    ]);
  });

  it("the compiled landing has the deduplicated menu", () => {
    const p = landingLeadsPlan();
    const lead = p.landing?.sections.find((s) => s.type === "lead_form");
    if (lead) lead.content = { ...lead.content, title: "Записаться на консультацию" };
    const cta = p.landing?.sections.find((s) => s.type === "cta");
    if (cta) cta.content = { ...cta.content, title: "Запишитесь на консультацию" };
    const r = compilePlan(p, registry, { appName: "Улыбка" });
    if (!r.ok) throw new Error("compile failed");
    const h = r.files["ui/pages/Home.tsx"] ?? "";
    expect(h).toContain('"label":"Записаться на консультацию"');
    expect(h).not.toContain('"label":"Запишитесь на консультацию"');
  });
});
