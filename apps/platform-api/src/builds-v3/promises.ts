// V4-21: a brief scenario is checked against what it promises the visitor sees, not only by the gates. Its «видит …»
// steps (`then`) are read by a dictionary into promises — an entity and a feature: services, prices, doctors with
// photos and experience, reviews, contacts, the schedule. Each promise needs a section of its type on the site
// (ui/site.json); in Chromium (the critic's inspector, the draft's demo rows) the section must also show it: a record
// whose name is not a stand-in («Услуга 1», «Иван Иванов»), a price with «₽» or «от», a loaded photo, a phone or an
// address. A promise not kept fails the scenario with the reason in words. No model.
import type { BriefScenario } from "@wizard/appspec";
import { type KnownContacts, phoneKey, placeholderOf, siteModel } from "@wizard/gates";
import type { GoalBrowserProvider } from "../agents/goal-browser.js";
import { type CriticInspectorOptions, criticInspector } from "./critic.js";

export const PROMISE_KINDS = [
  "services",
  "prices",
  "staff",
  "staff_photo",
  "staff_experience",
  "reviews",
  "contacts",
  "schedule",
] as const;
export type PromiseKind = (typeof PROMISE_KINDS)[number];

/** One promise of a scenario: what the visitor is to see, and the step that says so. */
export interface ScenarioPromise {
  kind: PromiseKind;
  step: string;
}

/** A step that shows something to the visitor (not one that acts: «записывается», «оставляет заявку»). */
const VIEW_RE =
  /(?:^|[\s,;—-])(?:видит|увидит|видно|смотрит|посмотр\p{L}*|просматрива\p{L}*|показ\p{L}*|изуча\p{L}*|знакомит\p{L}*|читает|узна[её]т|находит|найд[её]т|сравнива\p{L}*)/iu;

const STAFF_RE =
  /врач|доктор|специалист|мастер(?!ск)|тренер|преподавател|педагог|сотрудник|команд[ауеы]|персонал/iu;

/** What each kind is found by in a step; staff features count only with staff in the same step. */
const WORDS: readonly { kind: PromiseKind; re: RegExp; staff?: true }[] = [
  { kind: "services", re: /услуг|процедур|ассортимент|каталог|товар/iu },
  { kind: "prices", re: /цен[аыуео]?(?:\P{L}|$)|ценам|ценами|стоимост|прайс|тариф/iu },
  { kind: "staff", re: STAFF_RE },
  { kind: "staff_photo", re: /фото|портрет|снимк/iu, staff: true },
  { kind: "staff_experience", re: /опыт|стаж/iu, staff: true },
  { kind: "reviews", re: /отзыв/iu },
  { kind: "contacts", re: /контакт|адрес|телефон|как добраться|на карте|карт[ау](?:\P{L}|$)/iu },
  { kind: "schedule", re: /расписани|часы работы|график работы|режим работы|время работы/iu },
];

/** The promises of a scenario's `then` steps, each kind once (the first step that says it). */
export function scenarioPromises(scenario: Pick<BriefScenario, "then">): ScenarioPromise[] {
  const out = new Map<PromiseKind, ScenarioPromise>();
  for (const step of scenario.then) {
    if (!VIEW_RE.test(step)) continue;
    const staff = STAFF_RE.test(step);
    for (const w of WORDS)
      if (!out.has(w.kind) && (!w.staff || staff) && w.re.test(step)) out.set(w.kind, { kind: w.kind, step });
  }
  return [...out.values()];
}

/** Section types (ui/site.json `type`) that can keep a promise; signature sections (free code) may keep any. */
const SECTION_TYPES: Readonly<Record<PromiseKind, readonly string[]>> = {
  services: ["services", "pricing", "catalog", "shop", "product"],
  prices: ["pricing", "services", "catalog", "shop", "product"],
  staff: ["team"],
  staff_photo: ["team"],
  staff_experience: ["team"],
  reviews: ["testimonials"],
  contacts: ["contacts", "footer"],
  schedule: ["contacts", "footer", "services", "pricing"],
};

/** What is missing, in the owner's words (the build log and «Запросы на развитие»). */
const MISSING_RU: Readonly<Record<PromiseKind, string>> = {
  services: "на сайте нет списка услуг",
  prices: "на сайте нет цен",
  staff: "на сайте нет специалистов",
  staff_photo: "у специалистов нет фото",
  staff_experience: "у специалистов не указан опыт",
  reviews: "на сайте нет отзывов",
  contacts: "на сайте нет контактов",
  schedule: "на сайте нет расписания или часов работы",
};

/** Not kept in the browser: the section is there but does not show it. */
const EMPTY_RU: Readonly<Record<PromiseKind, string>> = {
  services: "в списке услуг только заглушки вместо названий",
  prices: "цены не показаны: нет суммы с «₽» или «от»",
  staff: "в секции специалистов нет настоящих имён",
  staff_photo: "фото специалистов не загрузились",
  staff_experience: "у специалистов не указан опыт",
  reviews: "в секции отзывов нет текстов отзывов",
  contacts: "в контактах нет телефона или адреса",
  schedule: "не показаны часы работы",
};

/** What to add when the site has no section for a promise (the reason says what to do, V4-21). */
const ADD_RU: Readonly<Record<PromiseKind, string>> = {
  services: "нужна секция услуг с их названиями",
  prices: "нужны цены у услуг: сумма с «₽» или «от …»",
  staff: "нужна секция специалистов с их именами",
  staff_photo: "нужна секция специалистов с их фото",
  staff_experience: "нужна секция специалистов с их опытом или стажем",
  reviews: "нужна секция отзывов с их текстами",
  contacts: "нужны контакты: телефон или адрес",
  schedule: "нужны часы работы",
};

const reason = (p: ScenarioPromise, text: string) => `Обещано в сценарии «${short(p.step)}»: ${text}.`;
const quoted = (xs: readonly string[]) =>
  xs
    .slice(0, 3)
    .map((x) => `«${short(x)}»`)
    .join(", ");

/** Where a promise was looked for and what it showed instead (the page, the section, its first names). */
function seen(shown: readonly { route: string; view: SectionView }[], contacts?: KnownContacts): string {
  const first = shown[0];
  if (!first) return "";
  const what = first.view.names.length ? `: показано ${quoted(first.view.names)}` : "";
  const known = contacts?.phones.length
    ? `; телефоны из брифа: ${contacts.phones.slice(0, 2).join(", ")}`
    : "";
  return ` (страница ${first.route}, секция «${first.view.id}»${what}${known})`;
}
const short = (s: string) => (s.length > 90 ? `${s.slice(0, 89)}…` : s);

interface SiteSectionRef {
  route: string;
  id: string;
  type: string;
}

/** Sections of ui/site.json with their type and page. */
function siteSections(files: ReadonlyMap<string, string>): SiteSectionRef[] {
  const site = siteModel(files);
  if (!site) return [];
  return site.pages.flatMap((p) =>
    ((p.sections ?? []) as { id: string; type?: string }[]).map((s) => ({
      route: p.route,
      id: s.id,
      type: s.type ?? "",
    })),
  );
}

/** What the page shows in one section (the probe script). */
export interface SectionView {
  id: string;
  /** Visible text of the section. */
  text: string;
  /** Names of its items: headings of cards, list entries, people. */
  names: string[];
  /** Longer texts of its items (quotes, paragraphs). */
  texts: string[];
  /** Quotes (blockquote, q) with text: what a review looks like in free code. */
  quotes?: string[];
  /** Pictures that loaded (complete, with a size). */
  images: number;
}

/** The probe run in the page: the sections of <main> (and the header and footer) with what they show. */
export const SECTION_PROBE_SCRIPT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const txt = (el) => (el.innerText || "").replace(/\\s+/g, " ").trim();
  const roots = [];
  const main = document.querySelector("main");
  if (main) for (const el of main.children) if (el.id) roots.push([el.id, el]);
  for (const tag of ["header", "footer"]) { const el = document.querySelector(tag); if (el) roots.push([tag, el]); }
  return roots.map(([id, el]) => ({
    id,
    text: txt(el).slice(0, 4000),
    names: [...el.querySelectorAll("h3, h4, dt, figcaption, li > strong, li > b, [itemprop=name]")]
      .filter(vis).map(txt).filter(Boolean).slice(0, 40),
    texts: [...el.querySelectorAll("blockquote, q, p, li")].filter(vis).map(txt)
      .filter((t) => t.length >= 30).slice(0, 40),
    quotes: [...el.querySelectorAll("blockquote, q")].filter(vis).map(txt).filter((t) => t.length >= 20).slice(0, 20),
    images: [...el.querySelectorAll("img")].filter((i) => i.complete && i.naturalWidth > 0 && vis(i)).length,
  }));
})()`;

/** «Услуга 1», «Товар №2», «Врач 3»: names a generator gives its records, not the owner's. */
const NUMBERED_RE =
  /^(?:услуга|товар|позиция|продукт|процедура|врач|специалист|мастер|сотрудник|отзыв|клиент|item|product|service)\s*№?\s*\d+$/iu;
const stubName = (s: string) => NUMBERED_RE.test(s.trim()) || placeholderOf(s) !== null;
const realNames = (v: SectionView) => v.names.filter((n) => n.length >= 2 && !stubName(n));

const PRICE_RE = /\d[\d\s ]*(?:₽|руб)|(?:^|\s)от\s+\d/iu;
const PHONE_RE = /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g;
const ADDRESS_RE =
  /(?:^|[\s,])(?:ул\.|улица|пр-т|проспект|пер\.|переулок|шоссе|наб\.|набережная|бульвар|пл\.|площадь)\s/iu;
const HOURS_RE =
  /\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}|ежедневно|круглосуточно|без выходных|(?:пн|пон|вт|ср|чт|пт|сб|вс)\b/iu;
const EXPERIENCE_RE = /опыт|стаж|\d+\s*(?:год|года|лет)\b/iu;

/** «Анна Смирнова», «Игорь Ким — хирург»: a name and a surname, both capitalised (not «Выберите услугу»). */
const PERSON_RE = /^\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?\s+\p{Lu}\p{Ll}+(?:-\p{Lu}\p{Ll}+)?(?:\s|$|[,—–-])/u;
const people = (v: SectionView) => realNames(v).filter((n) => PERSON_RE.test(n.trim()));

/** Kinds a section written as code (signature) keeps only by a strong sign: people's names, quotes, a phone or address. */
const STRICT_KINDS: ReadonlySet<PromiseKind> = new Set([
  "staff",
  "staff_photo",
  "staff_experience",
  "reviews",
  "contacts",
]);

/**
 * Whether a section as shown keeps a promise. `strict` — a section written as code (any heading or paragraph may look
 * like a card): staff only by people's names, their photo and experience only next to them, reviews only by quotes.
 */
export function keeps(kind: PromiseKind, v: SectionView, contacts?: KnownContacts, strict = false): boolean {
  if (strict)
    switch (kind) {
      case "staff":
        return people(v).length > 0;
      case "staff_photo":
        return people(v).length > 0 && v.images > 0;
      case "staff_experience":
        return people(v).length > 0 && EXPERIENCE_RE.test(v.text);
      case "reviews":
        return (v.quotes ?? []).some((q) => placeholderOf(q) === null);
      default:
        break;
    }
  switch (kind) {
    case "services":
      // Cards with names: at least one is not a stand-in; a section without item names keeps it by its text.
      return v.names.length ? realNames(v).length > 0 : v.text.length >= 60;
    case "prices":
      return PRICE_RE.test(v.text);
    case "staff":
      return realNames(v).length > 0;
    case "staff_photo":
      return v.images > 0;
    case "staff_experience":
      return EXPERIENCE_RE.test(v.text);
    case "reviews":
      return v.texts.some((t) => placeholderOf(t) === null);
    case "contacts": {
      if (ADDRESS_RE.test(v.text)) return true;
      const phones = v.text.match(PHONE_RE) ?? [];
      if (!contacts?.phones.length) return phones.length > 0;
      const known = new Set(contacts.phones.map(phoneKey));
      return phones.some((p) => known.has(phoneKey(p)));
    }
    case "schedule":
      return HOURS_RE.test(v.text);
  }
}

/** Kinds the composer can keep from the facts: the repair round is for these only. */
const REPAIRABLE: ReadonlySet<PromiseKind> = new Set(["services", "contacts", "schedule"]);

/** A page opened in the browser: the sections it shows (by id); null — it did not open. */
export type SiteViews = ReadonlyMap<string, readonly SectionView[]>;

export interface PromiseCheck {
  promises: ScenarioPromise[];
  /** Russian reasons of the promises not kept. */
  problems: string[];
  /**
   * Of `problems`, those the composer can keep from the facts (services, contacts, hours): the repair round gets only
   * these; specialists without their facts, reviews and prices (D49: never invented) go to «Запросы на развитие».
   */
  repairable: string[];
  /** The browser looked at the sections (false — by the site model only). */
  browser: boolean;
}

/**
 * Checks the promises of a scenario on the site: by the site model (a section of the type), then, with `views` (the
 * pages opened in the browser), by what those sections show. A promise is kept when any of its sections keeps it.
 */
export function checkPromises(
  scenario: Pick<BriefScenario, "then">,
  files: ReadonlyMap<string, string>,
  views: SiteViews | null,
  contacts?: KnownContacts,
): PromiseCheck {
  const promises = scenarioPromises(scenario);
  const problems: string[] = [];
  const repairable: string[] = [];
  if (!promises.length) return { promises, problems, repairable, browser: false };
  const sections = siteSections(files);
  const miss = (p: ScenarioPromise, text: string) => {
    const r = reason(p, text);
    problems.push(r);
    if (REPAIRABLE.has(p.kind)) repairable.push(r);
  };
  for (const p of promises) {
    const types = SECTION_TYPES[p.kind];
    // A signature section is free code: what it shows is known only in the browser. It may keep a promise there (by a
    // strong sign for people, reviews and contacts); without the browser it keeps none of those.
    const candidates = sections.filter(
      (s) =>
        types.includes(s.type) || (s.type === "signature" && (views !== null || !STRICT_KINDS.has(p.kind))),
    );
    // The footer alone is no section of contacts or hours: it only keeps them by what it shows.
    const own = candidates.filter((s) => s.type !== "footer");
    if (!own.length && !(views && candidates.length)) {
      miss(p, `${MISSING_RU[p.kind]} — ${ADD_RU[p.kind]}`);
      continue;
    }
    if (!views) continue;
    const shown = candidates.flatMap((s) =>
      (views.get(s.route) ?? [])
        .filter((v) => v.id === s.id || v.id === s.type)
        .map((view) => ({ route: s.route, view, strict: s.type === "signature" })),
    );
    if (!shown.length) {
      miss(p, `${MISSING_RU[p.kind]} — ${ADD_RU[p.kind]}`);
      continue;
    }
    if (!shown.some((x) => keeps(p.kind, x.view, contacts, x.strict)))
      miss(p, `${EMPTY_RU[p.kind]}${seen(shown, p.kind === "contacts" ? contacts : undefined)}`);
  }
  return { promises, problems, repairable, browser: views !== null };
}

/** Routes worth opening for the promises: the pages of their candidate sections (no entry pages with a parameter). */
export function promiseRoutes(
  scenario: Pick<BriefScenario, "then">,
  files: ReadonlyMap<string, string>,
): string[] {
  const kinds = new Set(scenarioPromises(scenario).map((p) => p.kind));
  if (!kinds.size) return [];
  const types = new Set([...[...kinds].flatMap((k) => SECTION_TYPES[k]), "signature"]);
  return [
    ...new Set(
      siteSections(files)
        // The header and the footer are on every page: the home page shows them.
        .filter((s) => types.has(s.type) && !s.route.includes(":"))
        .map((s) => (s.type === "footer" || s.type === "header" ? "/" : s.route)),
    ),
  ];
}

export interface SitePromiseInput {
  scenario: Pick<BriefScenario, "then">;
  spec: Parameters<ReturnType<typeof criticInspector>>[0]["spec"];
  files: ReadonlyMap<string, string>;
  contacts?: KnownContacts;
  signal?: AbortSignal;
}

/**
 * The browser side: the pages of the promises opened by the critic's inspector at 1440 (the draft's demo rows, the
 * library's photos), each section probed. Null — the system did not build or no browser (the model-only check stands).
 */
export async function siteViews(
  browser: GoalBrowserProvider,
  input: SitePromiseInput,
  o: Omit<CriticInspectorOptions, "browser" | "probe"> = {},
): Promise<SiteViews | null> {
  const routes = promiseRoutes(input.scenario, input.files);
  if (!routes.length) return new Map();
  const views = new Map<string, SectionView[]>();
  const inspect = criticInspector({
    ...o,
    browser,
    probe: async (page, route) => {
      views.set(route, (await page.evaluate(SECTION_PROBE_SCRIPT)) as SectionView[]);
    },
  });
  const r = await inspect({
    spec: input.spec,
    files: input.files,
    routes,
    viewports: [{ width: 1440, height: 900, scheme: "light" }],
    shots: [],
    fonts: [],
    ...(input.contacts ? { contacts: input.contacts } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return r.ok ? views : null;
}
