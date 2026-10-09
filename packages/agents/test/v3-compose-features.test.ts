// V3-18: what the skeleton composes for the v3 features the goal scenarios found missing, without a model or a browser
// (the browser rung: apps/platform-api/test/v3-goals.browser.test.ts) — the texts of the first screen and the forms from
// the brief's offer, goals and name (never the audience, never a phrase cut off, never the planner's placeholders), the
// places of the owner's photos («Фото сайта») on the sections and in the page file, the client cabinet /me of «Кабинет
// посетителя» (the sections of the visitor's records) and the parameters of the cabinet in the plan of a brief.
import { type AppSpec, systemBriefSchema } from "@wizard/appspec";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import { briefPlan, type SiteModel } from "../src/builder/index.js";
import { clientCabinet } from "../src/builder/v3/compose/account.js";
import {
  briefCopy,
  catalogNoun,
  listedServices,
  placeOf,
  quotedAction,
  toVisitor,
} from "../src/builder/v3/compose/copy.js";
import { lintSitePage, siteFacts, withSitePages } from "../src/builder/v3/compose/index.js";
import type { SitePage, SiteSection } from "../src/builder/v3/compose/site.js";
import { applyEdit, variantsFor } from "../src/builder/v3/critic/ops.js";
import { DEFAULT_REGISTRY, fallbackNiche } from "../src/planner/index.js";
import { briefSite } from "./v3-brief-site.js";
import { EVAL_BRIEFS } from "./v3-eval-briefs.js";
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

/** What the skeleton must say for each eval brief (natural Russian from the offer, the goals and the name). */
const EXPECTED: Readonly<Record<string, { title: string; lead: string; form?: string; seo: string }>> = {
  "v3-01-interior-studio": {
    title: "Ремонт и отделка в Екатеринбурге",
    lead: "Дизайн квартиры, дизайн дома, авторский надзор и комплектация.",
    form: "Обсудить проект",
    seo: "Проверка — ремонт и отделка в Екатеринбурге",
  },
  "v3-02-dental-booking": {
    title: "Медицинская клиника в Казани",
    lead: "Запишитесь к врачам онлайн на свободное время.",
    form: "Запись к врачам онлайн на свободное время",
    seo: "Проверка — медицинская клиника в Казани",
  },
  "v3-03-cleaning-crm": {
    title: "Проверка — клининг",
    lead: "Оставьте заявку на уборку.",
    form: "Заявка на уборку",
    seo: "Проверка — клининг",
  },
  "v3-04-karelia-tours": {
    title: "Туры по Карелии",
    lead: "Выберите тур и оставьте заявку на заезд.",
    form: "Заявка на заезд",
    seo: "Проверка — туры по Карелии",
  },
  // V3-23: a shop without request forms.
  "v3-05-ceramics-shop": {
    title: "Проверка — мастерская",
    lead: "Закажите посуду в интернет-магазине и оплатите её картой.",
    seo: "Проверка — мастерская",
  },
};

describe("texts of the skeleton from the brief (no model)", () => {
  for (const [id, input] of Object.entries(EVAL_BRIEFS))
    test(id, async () => {
      const { site } = await briefSite(id, input);
      const hero = sectionOf(home(site), "hero").props as {
        title: string;
        lead?: string;
        action: { label: string };
      };
      const form = formOf(site)?.props as { title: string } | undefined;
      const want = EXPECTED[id];
      expect({ title: hero.title, lead: hero.lead, form: form?.title, seo: home(site).seo.title }).toEqual(
        want,
      );
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
    });
    expect(briefCopy({ name: "Белая линия", niche: "все желающие", keywordNiche: false, brief })).toEqual({
      title: "Белая линия",
      about: "Белая линия",
    });
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
    const issues = lintSitePage(site, me, { numbers: new Set() } as never).filter(
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
