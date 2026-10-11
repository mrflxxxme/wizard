// V3-18: what the skeleton composes for the v3 features the goal scenarios found missing, without a model or a browser
// (the browser rung: apps/platform-api/test/v3-goals.browser.test.ts) — the texts of the first screen and the forms from
// the brief's offer, goals and name (never the audience, never a phrase cut off, never the planner's placeholders), the
// places of the owner's photos («Фото сайта») on the sections and in the page file, the client cabinet /me of «Кабинет
// посетителя» (the sections of the visitor's records) and the parameters of the cabinet in the plan of a brief.
import { type AppSpec, systemBriefSchema } from "@wizard/appspec";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { briefPlan, createPageComposer, readSite, type SiteModel } from "../src/builder/index.js";
import { clientCabinet } from "../src/builder/v3/compose/account.js";
import {
  briefCopy,
  businessName,
  businessOf,
  catalogNoun,
  isPlaceholderName,
  listedServices,
  offerOf,
  ownWords,
  placeOf,
  quotedAction,
  quotedName,
  toVisitor,
} from "../src/builder/v3/compose/copy.js";
import {
  lintSitePage,
  primaryAction,
  secondaryAction,
  siteFacts,
  withSitePages,
} from "../src/builder/v3/compose/index.js";
import type { SitePage, SiteSection } from "../src/builder/v3/compose/site.js";
import { applyEdit, variantsFor } from "../src/builder/v3/critic/ops.js";
import { DEFAULT_REGISTRY, fallbackNiche } from "../src/planner/index.js";
import { briefSite, evalRequest } from "./v3-brief-site.js";
import { CERAMICS_SHOP, CLEANING_CRM, EVAL_BRIEFS } from "./v3-eval-briefs.js";
import { FEATURE_BRIEFS } from "./v3-feature-briefs.js";

const home = (site: SiteModel) => site.pages.find((p) => p.route === "/") as SitePage;
const sectionOf = (page: SitePage | undefined, type: string) =>
  page?.sections.find((s) => s.type === type) as SiteSection;
/** The lead or booking form of a site (the home page's, else the booking page's). */
const formOf = (site: SiteModel) =>
  site.pages.flatMap((p) => p.sections).find((s) => s.type === "form" && typeof s.props.entity === "string");
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * What the skeleton must say for each eval brief (V3-18): the owner's business name, what the business is and offers in
 * his words (his first message, tools/eval/briefs/<id>.json «text»), the place — natural Russian; the system's name of
 * the test («Проверка») is a placeholder and never shows.
 */
const EXPECTED: Readonly<
  Record<string, { title: string; lead: string; form?: string; action: string; seo: string }>
> = {
  "v3-01-interior-studio": {
    title: "Студия дизайна интерьеров «Линия» в Екатеринбурге",
    lead: "Дизайн квартиры, дизайн дома, авторский надзор и комплектация.",
    form: "Обсудить проект",
    action: "Обсудить проект",
    seo: "Линия — студия дизайна интерьеров в Екатеринбурге",
  },
  "v3-02-dental-booking": {
    title: "Стоматологическая клиника в Казани",
    lead: "Запишитесь к врачам онлайн на свободное время.",
    form: "Запись к врачам онлайн на свободное время",
    action: "Записаться",
    seo: "Стоматологическая клиника в Казани",
  },
  "v3-03-cleaning-crm": {
    title: "Клининговая компания в Новосибирске",
    lead: "Уборка квартир после ремонта, уборка офисов и мойка окон.",
    form: "Заявка на уборку",
    action: "Оставить заявку",
    seo: "Клининговая компания в Новосибирске",
  },
  "v3-04-karelia-tours": {
    title: "Туры по Карелии",
    lead: "Сплавы, пешие маршруты и зимние поездки на снегоходах.",
    form: "Заявка на заезд",
    action: "Оставить заявку",
    seo: "Туры по Карелии",
  },
  // V3-23: a shop without request forms.
  "v3-05-ceramics-shop": {
    title: "Керамическая мастерская из Твери",
    lead: "Кружки, тарелки и вазы ручной работы.",
    action: "Перейти в магазин",
    seo: "Керамическая мастерская из Твери",
  },
};

/** The name a new system gets from the owner's first message (V3-18: the platform's nameFromPrompt). */
const SYSTEM_NAMES: Readonly<Record<string, string>> = {
  "v3-01-interior-studio": "Линия",
  "v3-02-dental-booking": "Стоматологическая клиника",
  "v3-03-cleaning-crm": "Клининговая компания",
  "v3-04-karelia-tours": "Турфирма",
  "v3-05-ceramics-shop": "Керамическая мастерская",
};

/** Words of a test or a draft that never show on a site. */
const PLACEHOLDER_WORDS = /(?:^|[^\p{L}])(?:проверка|тест|test|пример|черновик|новая система)(?![\p{L}])/iu;

/** V3-18: what home shows besides the first screen and the form, and what the catalog is called. */
const HOME: Readonly<Record<string, { body: string[]; services?: string[]; catalog?: string }>> = {
  "v3-01-interior-studio": {
    body: ["hero", "services", "catalog", "blog", "form"],
    services: ["Дизайн квартиры", "Дизайн дома", "Авторский надзор", "Комплектация"],
  },
  "v3-02-dental-booking": { body: ["hero", "catalog"] },
  "v3-03-cleaning-crm": {
    body: ["hero", "services", "catalog", "blog", "form"],
    services: ["Уборка квартир после ремонта", "Уборка офисов", "Мойка окон"],
    catalog: "Виды уборки",
  },
  "v3-04-karelia-tours": {
    body: ["hero", "services", "catalog", "blog", "form"],
    services: ["Сплавы", "Пешие маршруты", "Зимние поездки на снегоходах"],
    catalog: "Туры",
  },
  "v3-05-ceramics-shop": {
    body: ["hero", "shop", "services", "blog"],
    services: ["Кружки", "Тарелки", "Вазы ручной работы"],
  },
};

describe("V3-18: home previews the modules' data and the brief's services; the catalog is called as the brief says", () => {
  for (const [id, input] of Object.entries(EVAL_BRIEFS))
    test(id, async () => {
      const { site } = await briefSite(id, input);
      const want = HOME[id];
      const page = home(site);
      expect(page.sections.map((s) => s.type).filter((t) => t !== "header" && t !== "footer")).toEqual(
        want?.body,
      );
      // No closing call on home: the first screen's button is the main action already.
      expect(page.sections.some((s) => s.type === "cta")).toBe(false);
      const services = sectionOf(page, "services")?.props as { title: string; items: { title: string }[] };
      if (want?.services) {
        expect(services.title).toBe("Что мы предлагаем");
        expect(services.items.map((x) => x.title)).toEqual(want.services);
      } else expect(services).toBeUndefined();
      const preview = sectionOf(page, "catalog")?.props;
      const catalog = site.pages.find((p) => p.kind === "catalog");
      if (preview) {
        // A preview: the first six items, nothing while empty, the way to the whole catalog.
        expect(preview).toMatchObject({ preview: true, pageSize: 6 });
        expect(preview.categoryEntity).toBeUndefined();
        expect((preview.action as { href: string }).href).toBe(catalog?.route);
      }
      if (want?.catalog) {
        const noun = want.catalog.toLowerCase();
        expect(catalog?.title).toBe(want.catalog);
        expect(preview?.title).toBe(want.catalog);
        expect((preview?.action as { label: string } | undefined)?.label).toBe(`Все ${noun}`);
        const own = sectionOf(catalog, "catalog").props;
        expect(own.title).toBe(`Все ${noun}`);
        expect(own.empty).toBe(`${want.catalog} скоро появятся`);
        // The page's first screen says what the page holds, not only its title and a button.
        expect(typeof sectionOf(catalog, "hero").props.lead).toBe("string");
      } else if (catalog) expect(catalog.title).toBe("Каталог и цены");
      // The shop's goods on home: a preview of six with the way to all of them, no filter (V3-18).
      const shop = sectionOf(page, "shop")?.props;
      if (shop) {
        expect(shop).toMatchObject({
          preview: true,
          pageSize: 6,
          all: { label: "Все товары", href: "/shop" },
        });
        expect(shop.categoryEntity).toBeUndefined();
      }
      // A blog preview shows the latest three articles and hides while there are none.
      const blog = sectionOf(page, "blog")?.props;
      if (blog) expect(blog).toMatchObject({ preview: true, pageSize: 3, action: { href: "/blog" } });
    });
});

describe("texts of the skeleton from the brief (no model)", () => {
  for (const [id, input] of Object.entries(EVAL_BRIEFS))
    test(id, async () => {
      const { site, files, plan } = await briefSite(id, input);
      const hero = sectionOf(home(site), "hero").props as {
        title: string;
        lead?: string;
        action: { label: string };
      };
      const form = formOf(site)?.props as { title: string } | undefined;
      const want = EXPECTED[id];
      expect({
        title: hero.title,
        lead: hero.lead,
        ...(form ? { form: form.title } : {}),
        action: hero.action.label,
        seo: home(site).seo.title,
      }).toEqual(want);
      // No placeholder words anywhere the visitor or a search engine reads them (ui/seo.json too); a heading ≤ 60 in
      // sentence case; SEO titles ≤ 70 and descriptions ≤ 160, never cut off.
      const seo = JSON.parse(files.get("ui/seo.json") ?? "{}") as {
        site: string;
        pages: Record<string, { title: string; description: string }>;
      };
      const seoTexts = [seo.site, ...Object.values(seo.pages).flatMap((p) => [p.title, p.description])];
      for (const t of [hero.title, hero.lead ?? "", form?.title ?? "", hero.action.label, ...seoTexts])
        expect(t, t).not.toMatch(PLACEHOLDER_WORDS);
      expect(hero.title.length).toBeLessThanOrEqual(60);
      expect(hero.title.charAt(0)).toBe(hero.title.charAt(0).toUpperCase());
      // Sentence case: a capital only at the start, in a quoted name or in a place name after its preposition.
      const capitals = hero.title
        .replace(/«[^»]*»/g, "")
        .split(" ")
        .slice(1)
        .filter((w, i, ws) => /^[А-ЯЁ]/.test(w) && !/^(?:в|во|по|из)$/.test(ws[i - 1] ?? ""));
      expect(capitals, hero.title).toEqual([]);
      for (const p of Object.values(seo.pages)) {
        expect(p.title.length, p.title).toBeLessThanOrEqual(70);
        expect(p.description.length, p.description).toBeLessThanOrEqual(160);
        expect(`${p.title} ${p.description}`).not.toMatch(/…/);
      }
      // The lead names 2–4 services of the brief or of the owner's words (each word of each found there).
      const request = evalRequest(id) ?? "";
      const corpus = new Set(norm(`${request} ${JSON.stringify(input)}`).split(" "));
      // (A brief without services: the visitor's action said to him, «Запишитесь к врачам…».)
      if (!/^[А-ЯЁ][а-яё]+(?:те|тесь)\s/.test(hero.lead ?? "")) {
        const items = (hero.lead ?? "").replace(/\.$/, "").split(/,\s*|\s+и\s+/);
        expect(items.length, hero.lead).toBeGreaterThanOrEqual(2);
        expect(items.length, hero.lead).toBeLessThanOrEqual(4);
        for (const w of norm(items.join(" ")).split(" ")) expect(corpus.has(w), w).toBe(true);
      }
      // Never a niche label less specific than the owner's words («ремонт и отделка» for a design studio,
      // «медицинская клиника» for a dental one).
      const what = businessOf(request)?.what;
      if (what && !norm(what).includes(norm(plan.niche)))
        for (const t of [hero.title, home(site).seo.title])
          expect(` ${norm(t)} `.includes(` ${norm(plan.niche)} `), `«${t}»: «${plan.niche}»`).toBe(false);
      // The owner's quoted name is the brand of the SEO titles and of the header and footer of every page.
      const brand = what ? quotedName(businessOf(request)?.sentence ?? "") : undefined;
      expect(seo.site).toBe(brand ?? want?.seo);
      for (const p of site.pages)
        for (const s of p.sections.filter((x) => x.type === "header" || x.type === "footer")) {
          expect((s.props.brand as { name: string }).name, `${p.route} ${s.type}`).toBe(seo.site);
          const operator = (s.props.legal as { operator?: string } | undefined)?.operator ?? "";
          expect(operator).not.toMatch(PLACEHOLDER_WORDS);
          expect(operator).not.toMatch(/…/);
        }
      // The name the platform gives the new system (nameFromPrompt → businessName): never cut, never a placeholder;
      // built with it, the site says the same.
      const system = businessName(request) ?? "";
      expect(system).toBe(SYSTEM_NAMES[id]);
      const named = await briefSite(id, input, { appName: system });
      expect(sectionOf(home(named.site), "hero").props.title).toBe(want?.title);
      expect(home(named.site).seo.title).toBe(want?.seo);
      expect((sectionOf(home(named.site), "header").props.brand as { name: string }).name).toBe(seo.site);
      // Never the audience as a heading, never the first words of a sentence of the brief cut off (the planner's
      // niche of an unknown business), never the planner's placeholders.
      const brief = systemBriefSchema.parse(input);
      const audience = norm(brief.audience);
      const cut = norm(fallbackNiche(brief.audience));
      const texts = [hero.title, hero.lead ?? "", form?.title ?? "", hero.action.label, home(site).seo.title];
      for (const t of texts) {
        expect(t).not.toMatch(/…|\.\.\./);
        expect(norm(t)).not.toBe(audience);
      }
      for (const t of form ? [hero.title, form.title] : [hero.title]) {
        expect(audience.startsWith(norm(t)), `${t} — начало аудитории`).toBe(false);
        expect(t).not.toBe("Связаться");
      }
      expect(hero.action.label).not.toBe("Связаться");
      // The planner's niche of a business its keywords do not know is the first words of the audience: not shown.
      if (audience.startsWith(cut))
        for (const t of texts) expect(norm(t).includes(cut), `«${t}» содержит «${cut}»`).toBe(false);
      // Every text ends where its phrase ends: a heading has no dangling preposition, conjunction or comma.
      for (const t of form ? [hero.title, form.title] : [hero.title])
        expect(t).not.toMatch(/(?:\s(?:в|во|на|по|к|с|для|и|или|которые|который)|[,:;—-])$/i);
    });

  test("rules: the visitor's action, the place, the services, the quoted button", () => {
    expect(toVisitor("Посетитель выбирает тур и оставляет заявку на заезд")).toBe(
      "Выберите тур и оставьте заявку на заезд",
    );
    expect(toVisitor("Пациенты записываются к врачам онлайн")).toBe("Запишитесь к врачам онлайн");
    // A clause with a verb not said to the visitor ends the sentence (never half of it in the 3rd person).
    expect(toVisitor("Клиенты оставляют заявку на мойку окон и сами видят, что с ней")).toBe(
      "Оставьте заявку на мойку окон",
    );
    expect(toVisitor("посетитель оставляет заявку на уборку на сайте")).toBe("Оставьте заявку на уборку");
    expect(toVisitor("Заявки с сайта попадают менеджерам и не теряются")).toBeNull();
    expect(placeOf(["Частные клиенты и офисы Новосибирска"])).toBeUndefined();
    expect(placeOf(["Путешественники, которые ищут небольшие группы по Карелии"])).toBe("по Карелии");
    expect(placeOf(["Пациенты клиники в Казани, записываются с телефона"])).toBe("в Казани");
    expect(listedServices(["показывает услуги: стрижка, окрашивание, укладка"])).toEqual([
      "стрижка",
      "окрашивание",
      "укладка",
    ]);
    expect(listedServices(["показывает услуги с ценами «от»"])).toBeNull();
    expect(catalogNoun(["показывает туры с ценой и длительностью"])).toBe("туры");
    expect(catalogNoun(["показывает услуги с ценами «от»"])).toBeNull();
    expect(quotedAction(["Посетители оставляют заявку «Обсудить проект» с любой страницы"])).toBe(
      "Обсудить проект",
    );
    expect(quotedAction(["показывает «Заявка отправлена»"])).toBeUndefined();
    // Without a place and a known niche: the name and what the business is; without anything: the name.
    const brief = systemBriefSchema.parse({ audience: "Все желающие" });
    expect(
      briefCopy({ name: "Белая линия", niche: "стоматологическая клиника", keywordNiche: true, brief }),
    ).toEqual({
      title: "Белая линия — стоматологическая клиника",
      about: "стоматологическая клиника",
      brand: "Белая линия",
      home: "Белая линия — стоматологическая клиника",
      site: "Белая линия",
    });
    expect(briefCopy({ name: "Белая линия", niche: "все желающие", keywordNiche: false, brief })).toEqual({
      title: "Белая линия",
      about: "Белая линия",
      brand: "Белая линия",
      home: "Белая линия",
      site: "Белая линия",
    });
    // A placeholder name is never the business: the niche alone.
    expect(briefCopy({ name: "Проверка", niche: "клининг", keywordNiche: true, brief })).toMatchObject({
      title: "Клининг",
      home: "Клининг",
      site: "Клининг",
    });
  });

  test("rules: the owner's words — what the business is, its name, its offer", () => {
    expect(businessOf("Мы студия дизайна интерьеров «Линия» в Екатеринбурге, работаем шестой год.")).toEqual({
      what: "студия дизайна интерьеров",
      sentence: "Мы студия дизайна интерьеров «Линия» в Екатеринбурге, работаем шестой год.",
    });
    expect(businessOf("Стоматологическая клиника в Казани, пять врачей.")?.what).toBe(
      "стоматологическая клиника",
    );
    expect(businessOf("У нас клининговая компания в Новосибирске: уборка квартир")?.what).toBe(
      "клининговая компания",
    );
    // Size and praise are not what the business is.
    expect(businessOf("Мы небольшая турфирма из Петрозаводска, водим группы")?.what).toBe("турфирма");
    expect(businessOf("Мы небольшая керамическая мастерская из Твери: кружки")?.what).toBe(
      "керамическая мастерская",
    );
    // A business after a wish or a preposition is not the speaker's own («нужен сайт для клиники»).
    expect(businessOf("Нужен сайт для стоматологической клиники в Казани.")).toBeNull();
    expect(businessOf("Хотим запись онлайн. Сайт клиники уже есть.")).toBeNull();
    expect(quotedName("Мы студия дизайна интерьеров «Линия» в Екатеринбурге")).toBe("Линия");
    expect(quotedName("кнопка «Обсудить проект» на каждой странице")).toBeUndefined();
    expect(quotedName("этапы «новая», «расчёт»")).toBeUndefined();
    const cleaning =
      "У нас клининговая компания в Новосибирске: уборка квартир после ремонта, офисов и мойка окон.";
    expect(offerOf(cleaning, businessOf(cleaning))).toEqual([
      "уборка квартир после ремонта",
      "уборка офисов",
      "мойка окон",
    ]);
    const ceramics =
      "Мы мастерская из Твери: кружки, тарелки, вазы ручной работы, многие вещи в одном экземпляре.";
    expect(offerOf(ceramics, businessOf(ceramics))).toEqual(["кружки", "тарелки", "вазы ручной работы"]);
    // A list of the staff is not the offer; the services listed elsewhere are.
    const dental =
      "Стоматологическая клиника в Казани, пять врачей: терапевт, ортодонт и детский стоматолог.";
    expect(offerOf(dental, businessOf(dental))).toBeNull();
    expect(offerOf("Нужны страницы услуг (дизайн дома, авторский надзор).", null)).toEqual([
      "дизайн дома",
      "авторский надзор",
    ]);
    for (const n of ["Проверка", "Тест 2", "test", "Новая система", "Пример"])
      expect(isPlaceholderName(n), n).toBe(true);
    for (const n of ["Линия", "Тесто и крем", "Белая линия"]) expect(isPlaceholderName(n), n).toBe(false);
  });

  test("the business name: the owner's quoted one, else the system's name when he gave it", async () => {
    const id = "v3-02-dental-booking";
    const input = EVAL_BRIEFS[id] as never;
    // The owner named the system: the name stands after what the business is, and leads the SEO titles.
    const named = await briefSite(id, input, { appName: "Белая линия" });
    expect(sectionOf(home(named.site), "hero").props.title).toBe(
      "Стоматологическая клиника «Белая линия» в Казани",
    );
    expect(home(named.site).seo.title).toBe("Белая линия — стоматологическая клиника в Казани");
    // The platform named the system after the start of his text (nameFromPrompt): never shown, never cut off.
    const request = evalRequest("v3-01-interior-studio") ?? "";
    const auto = (request.split(/[.!?\n]/)[0] ?? "").slice(0, 60).trim();
    const copy = briefCopy({
      name: auto,
      niche: "ремонт и отделка",
      keywordNiche: true,
      brief: systemBriefSchema.parse(EVAL_BRIEFS["v3-01-interior-studio"]),
      request,
    });
    expect(copy).toMatchObject({
      title: "Студия дизайна интерьеров «Линия» в Екатеринбурге",
      brand: "Линия",
      home: "Линия — студия дизайна интерьеров в Екатеринбурге",
      site: "Линия",
    });
    // Without the owner's words the brief alone speaks; the test's name still never shows.
    const bare = await briefSite("v3-03-cleaning-crm", EVAL_BRIEFS["v3-03-cleaning-crm"] as never, {
      request: null,
    });
    expect(sectionOf(home(bare.site), "hero").props.title).toBe("Клининг");
    expect(home(bare.site).seo.title).toBe("Клининг");
  });

  test("V3-40 (final v3-11, v3-12): a step of the cart or a form is never the lead of the first screen", () => {
    const brief = systemBriefSchema.parse({
      ...EVAL_BRIEFS["v3-05-ceramics-shop"],
      goals: [
        {
          id: "g_sell",
          text: "Покупатель выбирает доставку (Почта России или СДЭК до пункта выдачи)",
          success: "Заказ оплачен",
        },
      ],
      scenarios: [
        {
          id: "s_buy",
          actor: "visitor",
          when: "покупатель выбирает товары и кладёт их в корзину",
          // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
          then: ["показывает сумму заказа"],
          goalId: "g_sell",
          moduleHint: "shop",
        },
      ],
    });
    const copy = briefCopy({ name: "Чай и мёд", niche: "чай и мёд", keywordNiche: true, brief });
    // The visitor's first action of this brief is exactly what the final measurement showed as the lead.
    expect(toVisitor("Покупатель выбирает доставку (Почта России или СДЭК до пункта выдачи)")).toBe(
      "Выберите доставку (Почта России или СДЭК до пункта выдачи)",
    );
    expect(copy.lead ?? "").not.toMatch(/^(Выберите|Положите|Укажите)/);
    // A visitor's own action that says what the business does still leads.
    const booking = systemBriefSchema.parse({
      ...EVAL_BRIEFS["v3-05-ceramics-shop"],
      goals: [
        {
          id: "g_book",
          text: "Клиент записывается на мастер-класс по гончарному делу",
          success: "Запись в кабинете",
        },
        ...(CERAMICS_SHOP.goals ?? []),
      ],
    });
    expect(briefCopy({ name: "Глина", niche: "керамика", keywordNiche: true, brief: booking }).lead).toBe(
      "Запишитесь на мастер-класс по гончарному делу.",
    );
  });

  test("V3-40 (final v3-11, v3-12): the lead in the owner's opening words when no business word is known", () => {
    const tea =
      "Мы семейное дело из Барнаула: собираем и сушим травяные сборы, качаем мёд на своей пасеке, продаём по всей России. Нужен интернет-магазин.";
    expect(ownWords(tea)).toEqual({
      deed: "Собираем и сушим травяные сборы, качаем мёд на своей пасеке, продаём по всей России.",
    });
    expect(
      ownWords("Мы фермерское хозяйство под Владимиром: молоко, творог, сыры, яйца. Продаём через чат."),
    ).toEqual({
      items: ["молоко", "творог", "сыры", "яйца"],
    });
    // The deed ends where his «мы» stops doing: «восемь лет на рынке» is not what the business does.
    expect(
      ownWords("Мы строим каркасные дома под ключ в Вологде и области, восемь лет на рынке, своя бригада."),
    ).toEqual({ deed: "Строим каркасные дома под ключ в Вологде и области." });
    // «Работаем шестой год», digits, an address or not his «мы» — nothing.
    expect(ownWords("Мы студия интерьеров, работаем шестой год.")).toBeNull();
    expect(ownWords("Мы водим группы до 12 человек: сплавы, походы.")).toBeNull();
    expect(ownWords("Стоматологическая клиника в Казани: терапевт, хирург.")).toBeNull();
    // In the brief's copy it is the lead when the brief lists no services.
    const brief = systemBriefSchema.parse({
      ...EVAL_BRIEFS["v3-05-ceramics-shop"],
      goals: [
        {
          id: "g_sell",
          text: "Покупатель выбирает доставку (Почта России или СДЭК до пункта выдачи)",
          success: "Заказ оплачен",
        },
      ],
      scenarios: [],
    });
    expect(
      briefCopy({ name: "Чай и мёд", niche: "чай и мёд", keywordNiche: true, brief, request: tea }).lead,
    ).toBe("Собираем и сушим травяные сборы, качаем мёд на своей пасеке, продаём по всей России.");
  });

  test("V3-40 (final v3-05, v3-12): a shop with a booking — the composed first screen leads to the goods", async () => {
    const input = {
      ...CERAMICS_SHOP,
      goals: [
        ...(CERAMICS_SHOP.goals ?? []),
        { id: "g_class", text: "Клиенты записываются на мастер-класс", success: "Запись в кабинете" },
      ],
      scenarios: [
        ...(CERAMICS_SHOP.scenarios ?? []),
        {
          id: "s_class",
          actor: "visitor" as const,
          when: "клиент записывается на мастер-класс по гончарному делу",
          // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
          then: ["выбирает дату и время", "получает подтверждение"],
          goalId: "g_class",
          moduleHint: "booking",
        },
      ],
    };
    const { site } = await briefSite("v3-05-ceramics-shop", input);
    expect(site.pages.some((p) => p.kind === "booking" || p.sections.some((x) => x.props.booking))).toBe(
      true,
    );
    const hero = sectionOf(home(site), "hero").props as {
      action: { label: string; href: string };
      secondary?: { label: string; href: string };
    };
    expect(hero.action).toEqual({ label: "Перейти в магазин", href: "/shop" });
    expect(site.primary).toMatchObject({ kind: "shop" });
  });

  test("V3-40: a site with a shop sells first — «Перейти в магазин», the booking is the second action", () => {
    const pages = [
      { kind: "home", route: "/", title: "Главная" },
      { kind: "booking", route: "/booking", title: "Запись" },
      { kind: "shop", route: "/shop", title: "Магазин" },
    ] as unknown as Parameters<typeof primaryAction>[1];
    const facts = { texts: new Map(), copy: { title: "Керамика" } } as unknown as Parameters<
      typeof primaryAction
    >[0];
    const primary = primaryAction(facts, pages, null);
    expect(primary).toMatchObject({ kind: "shop", label: "Перейти в магазин", route: "/shop" });
    expect(secondaryAction(primary, pages)).toMatchObject({
      kind: "booking",
      label: "Записаться",
      route: "/booking",
    });
    // Without a shop the booking stays the main action, the shop-less secondary is none.
    const noShop = pages.filter((p) => p.kind !== "shop");
    expect(primaryAction(facts, noShop, null)).toMatchObject({ kind: "booking", route: "/booking" });
  });

  test("V3-18 (pilot v3-05): a country or a delivery scope is not where the business is", () => {
    const brief = systemBriefSchema.parse({
      ...EVAL_BRIEFS["v3-05-ceramics-shop"],
      audience: "Покупатели посуды ручной работы в России, заказывают с телефона",
    });
    const request =
      "Мы небольшая керамическая мастерская: кружки, тарелки, вазы ручной работы. Доставка по России СДЭК, отправляем в Казань и в Москву.";
    const copy = briefCopy({ name: "Проверка", niche: "керамика", keywordNiche: false, brief, request });
    expect(copy.title).toBe("Керамическая мастерская");
    expect(copy.site).toBe("Керамическая мастерская");
    for (const t of [copy.title, copy.home, copy.site, copy.about])
      expect(t).not.toMatch(/России|Казан|Москв/);
    expect(placeOf(["Доставка по России и в Беларусь", "Работаем по РФ", "Мастерская в Твери"])).toBe(
      "в Твери",
    );
    // The name the owner gives in so many words is the brand.
    const named = briefCopy({
      name: "Проверка",
      niche: "керамика",
      keywordNiche: false,
      brief,
      request: `${request} Мастерская называется «Глина и печь».`,
    });
    expect(named).toMatchObject({ title: "Керамическая мастерская «Глина и печь»", site: "Глина и печь" });
  });
});

describe("V3-40: the skeleton laid out again without the patterns of a close site (a pinned style)", () => {
  test("most patterns of the first layout give way; every section stays; the style stays", async () => {
    const first = await briefSite("v3-05-ceramics-shop", EVAL_BRIEFS["v3-05-ceramics-shop"] as never);
    const patternsOf = (site: SiteModel) =>
      site.pages.flatMap((p) => p.sections.map((x) => x.pattern)).filter((id) => id !== "signature");
    const used = [...new Set(patternsOf(first.site))];
    const out = await createPageComposer().skeleton({
      ...first.ctx,
      files: new Map(first.ctx.files),
      avoidPatterns: used,
    });
    const files = new Map(first.ctx.files);
    for (const [p, v] of out.files) v === null ? files.delete(p) : files.set(p, v);
    const again = readSite(files) as SiteModel;
    const sections = (site: SiteModel) =>
      site.pages.flatMap((p) => p.sections.map((x) => `${p.route}#${x.type}`));
    expect(sections(again)).toEqual(sections(first.site));
    expect(again.archetype).toBe(first.site.archetype);
    const kept = new Set(patternsOf(again).filter((id) => used.includes(id)));
    // A pattern stays only where no other variant of the section takes its content.
    expect(kept.size).toBeLessThan(used.length / 2);
  });
});

describe("the owner's photos of «Фото сайта» on the v3 pages", () => {
  test("the home hero shows the place of its photo; the page file asks useSitePhotos for it", async () => {
    const { site, files, ctx } = await briefSite(
      "v3-01-interior-studio",
      EVAL_BRIEFS["v3-01-interior-studio"] as never,
    );
    // The cabinet lists the plan's landing places: the first screen is «top».
    expect(siteFacts(ctx).places.map((p) => p.slot)).toContain("top");
    const hero = sectionOf(home(site), "hero");
    expect(hero.photos).toEqual({ image: "top" });
    // No stock photo here: a variant that can show the owner's photo once he uploads it.
    const meta = PATTERNS.find((p) => p.id === hero.pattern);
    const shape = (meta?.slots as unknown as { shape?: object } | undefined)?.shape ?? {};
    expect(Object.keys(shape)).toContain("image");
    const src = files.get(home(site).file) ?? "";
    expect(src).toContain('import { useSitePhotos } from "@wizard/ui-kit/v3/headless";');
    expect(src).toContain("const photo = useSitePhotos();");
    expect(src).toContain('image={photo.one("top", undefined)}');
    // Other pages have no places: no hook.
    const services = site.pages.find((p) => p.route === "/services");
    expect(files.get(services?.file ?? "")).not.toContain("useSitePhotos");
  });

  test("a stock photo stays the fallback of its place; the critic keeps a variant that shows the place", async () => {
    const input = EVAL_BRIEFS["v3-04-karelia-tours"] as never;
    const { site, ctx } = await briefSite("v3-04-karelia-tours", input);
    const hero = sectionOf(home(site), "hero");
    // The critic may not swap the first screen for a variant without a photo: the owner's photo would be lost.
    const variants = variantsFor(PATTERNS, hero).map((p) => p.id);
    expect(variants).not.toContain("hero-typographic");
    const swap = applyEdit(
      { site, design: ctx.design },
      { op: "swap_variant", route: "/", section: hero.id, pattern: "hero-typographic" },
      { library: PATTERNS, numbers: new Set<string>() },
    );
    expect(swap).toMatchObject({ ok: false });
    // With a stock photo of the plan the hero shows it and the page falls back to it.
    const withStock = {
      ...ctx.plan,
      design: {
        ...ctx.plan.design,
        photos: [
          {
            slot: "top",
            file: "stock-1",
            alt: "Лодка у берега Онежского озера",
            provider: "pexels" as const,
            author: "Автор",
            pageUrl: "https://www.pexels.com/photo/1",
            license: "Pexels License",
            licenseUrl: "https://www.pexels.com/license/",
            query: "карелия",
          },
        ],
      },
    };
    const facts = siteFacts({ ...ctx, plan: withStock as never });
    expect(facts.photos.map((p) => p.slot)).toEqual(["top"]);
  });
});

describe("the client cabinet /me of «Кабинет посетителя»", () => {
  test("v3-02: the account section is the page's h1 with «Мои записи», its fields and «Отменить запись»", async () => {
    const { site, spec } = await briefSite(
      "v3-02-dental-booking",
      EVAL_BRIEFS["v3-02-dental-booking"] as never,
    );
    const me = site.pages.find((p) => p.route === "/me") as SitePage;
    expect(me.sections.map((s) => s.type)).toEqual(["header", "account", "footer"]);
    const account = sectionOf(me, "account");
    expect(account.pattern).toMatch(/^account-/);
    const props = account.props as {
      level: number;
      sections: { entity: string; label: string; fields: string[]; cancel?: unknown }[];
      signIn: { href: string };
    };
    expect(props.level).toBe(1);
    expect(props.sections.map((s) => [s.entity, s.label])).toEqual([["booking", "Мои записи"]]);
    expect(props.sections[0]?.fields).toContain("name");
    expect(props.sections[0]?.cancel).toEqual({
      field: "status",
      value: "cancelled",
      label: "Отменить запись",
    });
    expect(props.signIn.href).toBe("/login?role=visitor&next=%2Fme");
    // The page passes the lint: one h1, the sign-in link is a link of the site.
    // (The footer's «© <year>» is a fact of the composition.)
    const year = String(new Date().getUTCFullYear());
    const issues = lintSitePage(site, me, { numbers: new Set([year]) } as never).filter(
      (i) => i.severity === "error",
    );
    expect(issues).toEqual([]);
    expect(withSitePages(spec, site).pages?.find((p) => p.route === "/me")?.roles).toEqual(["visitor"]);
  });

  test("a brief with requests: the plan shows «Мои заявки» too, the cabinet has its section", async () => {
    const input = FEATURE_BRIEFS["v3-x-cleaning-cabinet"] as never;
    const bp = briefPlan(systemBriefSchema.parse(input), DEFAULT_REGISTRY, [], { appName: "Проверка" });
    expect(bp?.plan.modules.find((m) => m.id === "visitor_cabinet")?.params).toMatchObject({
      show_leads: true,
    });
    const { site } = await briefSite("v3-x-cleaning-cabinet", input);
    const me = site.pages.find((p) => p.route === "/me");
    const props = sectionOf(me, "account").props as { sections: { entity: string; label: string }[] };
    expect(props.sections.map((s) => s.label)).toContain("Мои заявки");
  });

  test("a site without the module has no cabinet section", async () => {
    const { site } = await briefSite("v3-04-karelia-tours", EVAL_BRIEFS["v3-04-karelia-tours"] as never);
    expect(site.pages.some((p) => p.sections.some((s) => s.type === "account"))).toBe(false);
  });
});

describe("booking by a package («Абонементы») on a v3 booking pattern", () => {
  test("the booking form binds the package check (a camelCase function name)", async () => {
    const { site } = await briefSite("v3-x-yoga-packages", FEATURE_BRIEFS["v3-x-yoga-packages"] as never);
    const booking = site.pages.find((p) => p.route === "/booking");
    const form = sectionOf(booking, "form");
    expect(form.pattern).toMatch(/^form-booking-/);
    expect((form.props.booking as { packageCheckFn?: string }).packageCheckFn).toBe("packageCheck");
    // Bookings the staff confirms: the form says what the module's v2 page says.
    expect(form.props.sent).toEqual({ title: "Заявка на запись отправлена" });
  });
});

describe("clientCabinet: the sections the visitor may read", () => {
  test("a section the visitor role may not read is left out; no cancel without the update right", () => {
    const spec = {
      roles: [
        { name: "guest", label: "Гость", access: "public" },
        { name: "visitor", label: "Клиент", access: "login", loginMethods: ["email_otp"], selfSignup: true },
      ],
      entities: [
        {
          name: "booking",
          label: "Запись",
          fields: [
            { name: "starts_at", label: "Начало", type: "datetime" },
            {
              name: "status",
              label: "Статус",
              type: "enum",
              enum: [{ value: "cancelled", label: "Отменена" }],
            },
          ],
        },
        { name: "lead", label: "Заявка", fields: [{ name: "name", label: "Имя", type: "string" }] },
      ],
      permissions: [
        { role: "visitor", entity: "booking", ops: ["read"], rowFilter: { email: "$user.email" } },
      ],
    } as unknown as AppSpec;
    const plan = { modules: [{ id: "visitor_cabinet", params: { show_leads: true } }] };
    expect(clientCabinet(spec, plan)).toEqual({
      role: "visitor",
      sections: [
        {
          id: "booking",
          entity: "booking",
          label: "Мои записи",
          fields: ["starts_at", "status"],
          empty: "Записей пока нет",
        },
      ],
    });
    expect(clientCabinet(spec, { modules: [] })).toBeNull();
  });
});

describe("a site wanted, a module of the site in the plan (V3-18, checkpoint v3-007)", () => {
  test("a CRM whose plan has only the landing and staff modules gets the lead form: its home page is not empty", async () => {
    // biome-ignore lint/suspicious/noThenProperty: field name fixed by builder-v3.md §3 C1
    const base = { then: ["сохраняет сделку"], priority: "must" as const };
    const crm = {
      ...CLEANING_CRM,
      goals: [
        {
          id: "g_deals",
          text: "Руководитель видит сделки и загрузку бригад",
          success: "Выезды не срываются",
        },
      ],
      scenarios: [
        {
          ...base,
          id: "s_deal",
          actor: "staff" as const,
          when: "менеджер ведёт сделку по этапам",
          moduleHint: "deals",
          goalId: "g_deals",
        },
      ],
    };
    const bp = briefPlan(systemBriefSchema.parse(crm), DEFAULT_REGISTRY, [], { appName: "Клининг" });
    const ids = bp?.plan.modules.map((m) => m.id) ?? [];
    expect(ids).toContain("landing");
    expect(ids).toContain("leads");
    const { site } = await briefSite("v3-x-crm-landing", crm as never);
    const home = site.pages.find((p) => p.route === "/");
    expect(home?.sections.some((s) => s.type === "hero")).toBe(true);
    expect(home?.sections.some((s) => s.type === "form")).toBe(true);
  });
});
