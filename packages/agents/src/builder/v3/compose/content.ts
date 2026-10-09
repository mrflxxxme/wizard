// Content of the skeleton sections (no model): every text comes from the facts (brief, approved plan, spec); where a
// fact is missing the section gets an honest functional wording («Оставьте заявку») or is left out — never numbers,
// reviews or claims the owner did not give (D49, catalog H.4). Props are the union of what the variants of a section
// type may show; the slot schema of the chosen pattern keeps its part.
import { CONTENT_NAMES, CONTENT_SCREENS, entryPrefix } from "@wizard/modules";
import type { SectionType } from "@wizard/ui-kit/v3/patterns";
import { type SiteFacts, textOf } from "./facts.js";
import {
  ANCHOR_LABELS,
  type Binding,
  CONTENT_MODULE,
  isParamRoute,
  type PageKind,
  type PlannedPage,
} from "./site.js";

/** Where the main action of the site leads: a section of a page (form) or a page, a phone, an e-mail. */
export interface SiteAction {
  kind: "form" | "booking" | "catalog" | "page" | "phone" | "email";
  label: string;
  /** Route of the page that holds the target (absent for tel: and mailto:). */
  route?: string;
  /** Anchor of the section on that page. */
  anchor?: string;
  href?: string;
}

type Props = Record<string, unknown>;
type Link = { label: string; href: string };

const LINE = { title: 90, cta: 80, lead: 260, note: 120, tagline: 140, label: 40 } as const;

const fits = (s: string | undefined, max: number): string | undefined =>
  s && s.length <= max && !/\n/.test(s) ? s : undefined;

const REQUEST_RE = /заявк|запиш|запис|перезвон|звонок|спросить|вопрос/i;

/**
 * A text of the plan written for its request form (hero subtitle, call to action): kept only when the site's main
 * action is a form or a booking — otherwise it would promise what the page cannot do.
 */
const forAction = (text: string | undefined, a: SiteAction | null): string | undefined =>
  text && (a?.kind === "form" || a?.kind === "booking" || !REQUEST_RE.test(text)) ? text : undefined;

/** The href of an action as seen from a page: «#form» on its own page, «/booking#form» elsewhere. */
export function actionHref(a: SiteAction, from: string): string {
  if (a.href) return a.href;
  const route = a.route ?? "/";
  if (a.anchor) return route === from ? `#${a.anchor}` : `${route === "/" ? "/" : route}#${a.anchor}`;
  return route;
}

export function actionLink(a: SiteAction, from: string): Link {
  return { label: a.label, href: actionHref(a, from) };
}

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

/**
 * The main action of the site: the request form, the booking, the catalog, a phone — the first that exists.
 * `formOnHome` — the binding of the home form when a pattern placed it; `bookingForm` — the booking page holds its form.
 */
export function primaryAction(
  facts: SiteFacts,
  pages: readonly PlannedPage[],
  formOnHome: Binding | null,
  bookingForm = false,
): SiteAction | null {
  const heroCta = fits(textOf(facts, "hero", "cta"), LINE.label);
  if (formOnHome)
    return formOnHome.needs === "booking"
      ? { kind: "booking", label: heroCta ?? "Записаться", route: "/", anchor: "form" }
      : { kind: "form", label: heroCta ?? "Оставить заявку", route: "/", anchor: "form" };
  const booking = pages.find((p) => p.kind === "booking");
  if (booking)
    return {
      kind: "booking",
      label: heroCta ?? "Записаться",
      route: booking.route,
      ...(bookingForm ? { anchor: "form" } : {}),
    };
  const catalog = pages.find((p) => p.kind === "catalog");
  if (catalog) return { kind: "catalog", label: "Открыть каталог", route: catalog.route };
  if (facts.phone) return { kind: "phone", label: "Позвонить", href: telHref(facts.phone) };
  if (facts.email) return { kind: "email", label: "Написать письмо", href: `mailto:${facts.email}` };
  const other = pages.find((p) => p.kind !== "home" && p.kind !== "credits" && !isParamRoute(p.route));
  return other
    ? { kind: "page", label: fits(other.title, LINE.label) ?? "Подробнее о разделе", route: other.route }
    : null;
}

/** A second action for the first screen: the catalog when the main one is a form, else none. */
export function secondaryAction(
  primary: SiteAction | null,
  pages: readonly PlannedPage[],
): SiteAction | null {
  if (!primary || primary.kind === "catalog") return null;
  const catalog = pages.find((p) => p.kind === "catalog");
  return catalog ? { kind: "catalog", label: "Открыть каталог", route: catalog.route } : null;
}

const CTA_TITLES: Record<SiteAction["kind"], string> = {
  form: "Оставьте заявку",
  booking: "Запишитесь онлайн",
  catalog: "Посмотрите каталог",
  page: "Перейдите в раздел",
  phone: "Позвоните нам",
  email: "Напишите нам",
};

/** Everything a page section needs to fill its props. */
export interface SectionContext {
  facts: SiteFacts;
  page: PlannedPage;
  pages: readonly PlannedPage[];
  primary: SiteAction | null;
  secondary: SiteAction | null;
  binding: Binding | null;
  /** Anchors of the home page sections (menu of a one-page site). */
  homeSections: readonly { id: string; type: SectionType }[];
}

function headerNav(c: SectionContext): Link[] {
  const pages = c.pages.filter((p) => p.kind !== "credits" && p.kind !== "account" && !isParamRoute(p.route));
  const links: Link[] = pages.length >= 2 ? pages.map((p) => ({ label: navLabel(p), href: p.route })) : [];
  if (links.length < 2) {
    links.length = 0;
    for (const s of c.homeSections) {
      const label = ANCHOR_LABELS[s.type];
      if (label) links.push({ label, href: c.page.route === "/" ? `#${s.id}` : `/#${s.id}` });
    }
  }
  return links.slice(0, 6);
}

/** Label of a page in the menus (≤ 40 characters). */
export function navLabel(p: Pick<PlannedPage, "title" | "kind">): string {
  if (p.kind === "home") return "Главная";
  return fits(p.title, LINE.label) ?? p.title.slice(0, LINE.label).trim();
}

function brand(f: SiteFacts) {
  return { name: f.name, href: "/" };
}

function contactsList(f: SiteFacts) {
  const out: { label: string; value: string; href?: string }[] = [];
  if (f.phone) out.push({ label: "Телефон", value: f.phone, href: telHref(f.phone) });
  if (f.email) out.push({ label: "Почта", value: f.email, href: `mailto:${f.email}` });
  if (f.address && f.address.length <= 90) out.push({ label: "Адрес", value: f.address });
  return out;
}

/** Text items of a plan list (strings or objects) as {title, text}. */
function items(v: unknown, keys: readonly string[]): Record<string, string>[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === "string") return { [keys[0] as string]: x };
      if (x && typeof x === "object") {
        const o: Record<string, string> = {};
        for (const k of keys) {
          const val = (x as Record<string, unknown>)[k];
          if (typeof val === "string" && val.trim()) o[k] = val.trim();
        }
        return o;
      }
      return {};
    })
    .filter((o) => Object.keys(o).length > 0 && (o[keys[0] as string] ?? "").length > 0);
}

/**
 * The first screen's action on a page: the main action; on the page it opens — its section there (an anchor is set
 * only when the section was placed), else the next page of the site.
 */
function heroAction(c: SectionContext): Link | null {
  const a = c.primary;
  if (!a) return null;
  if (a.route !== c.page.route || a.anchor) return actionLink(a, c.page.route);
  const other = c.pages.find(
    (p) => p.route !== c.page.route && p.kind !== "credits" && !isParamRoute(p.route),
  );
  return other ? { label: navLabel(other), href: other.route } : null;
}

function heroProps(c: SectionContext): Props | null {
  const { facts: f, page } = c;
  const main = heroAction(c);
  if (!main) return null;
  if (page.kind !== "home") return { title: page.title, action: main };
  const title =
    fits(textOf(f, "hero", "title"), LINE.title) ??
    fits(f.description, LINE.title) ??
    fits(`${f.name}: ${f.niche}`, LINE.title) ??
    f.name.slice(0, LINE.title);
  const lead =
    forAction(fits(textOf(f, "hero", "subtitle"), LINE.lead), c.primary) ??
    (title === f.description ? undefined : fits(f.description, LINE.lead));
  const photos = f.photos.filter((p) => p.slot === "top" || /^top-\d+$/.test(p.slot));
  const out: Props = { title, action: main };
  if (lead) out.lead = lead;
  if (c.secondary) out.secondary = actionLink(c.secondary, page.route);
  if (photos[0]) out.image = { src: photos[0].src, alt: photos[0].alt };
  if (photos.length >= 2) out.images = photos.slice(0, 3).map((p) => ({ src: p.src, alt: p.alt }));
  return out;
}

function ctaProps(c: SectionContext): Props | null {
  const a = c.primary;
  if (!a) return null;
  // The page already holds the target (the form, or it is the page the action opens): no second call to it.
  if (a.route === c.page.route) return null;
  const f = c.facts;
  const steps = planSteps(f, 90);
  // The plan's call to action was written for its request form: only with a form or a booking as the main action.
  const plan = a.kind === "form" || a.kind === "booking";
  const out: Props = {
    title: (plan ? fits(textOf(f, "cta", "title"), LINE.cta) : undefined) ?? CTA_TITLES[a.kind],
    action: {
      ...actionLink(a, c.page.route),
      label: (plan ? fits(textOf(f, "cta", "cta"), LINE.label) : undefined) ?? a.label,
    },
  };
  const text = forAction(fits(textOf(f, "cta", "text"), 220), a);
  if (text) out.text = text;
  if (steps) out.steps = steps;
  if (f.phone && a.kind !== "phone") out.contact = { label: f.phone, href: telHref(f.phone) };
  return out;
}

function headerProps(c: SectionContext): Props {
  const out: Props = { brand: brand(c.facts), nav: headerNav(c) };
  if (c.primary) out.action = actionLink(c.primary, c.page.route);
  const account = c.pages.find((p) => p.kind === "account");
  if (account) out.secondary = { label: navLabel(account), href: account.route };
  if (c.facts.phone) out.phone = { label: c.facts.phone, href: telHref(c.facts.phone) };
  const note = fits(c.facts.address, 90);
  if (note) out.note = note;
  return out;
}

function footerProps(c: SectionContext): Props {
  const f = c.facts;
  const links = c.pages
    .filter((p) => !isParamRoute(p.route))
    .map((p) => ({ label: navLabel(p), href: p.route }))
    .slice(0, 6);
  const out: Props = {
    brand: brand(f),
    columns: [{ title: "Разделы", links }],
    legal: {
      operator:
        fits(f.operator, 120) ?? `Владелец сайта «${f.name}» — оператор персональных данных`.slice(0, 120),
      ...(f.operatorInn ? { details: `ИНН ${f.operatorInn}` } : {}),
      policy: { label: "Политика обработки персональных данных", href: f.policyPage },
    },
  };
  const tagline = fits(f.description, LINE.tagline);
  if (tagline) out.tagline = tagline;
  const contacts = contactsList(f);
  if (contacts.length) out.contacts = contacts;
  if (c.primary) out.action = actionLink(c.primary, c.page.route);
  return out;
}

/** A plan section of the owner: its heading, intro, text, note and list items (first of `types` that has content). */
function planSection(
  f: SiteFacts,
  types: readonly string[],
  itemKeys: readonly string[],
): { title?: string; intro?: string; text?: string; note?: string; items: Record<string, string>[] } | null {
  for (const t of types) {
    const s = f.texts.get(t);
    if (!s) continue;
    const str = (v: unknown, max: number) => fits(typeof v === "string" ? v : undefined, max);
    const out = {
      title: str(s.title, LINE.cta),
      intro: str(s.intro, LINE.lead) ?? str(s.subtitle, LINE.lead),
      text: typeof s.text === "string" ? s.text : undefined,
      note: str(s.note, LINE.note),
      items: items(s.items, itemKeys),
    };
    if (out.title || out.items.length) return out;
  }
  return null;
}

/** Drops undefined values (props stay plain JSON). */
const defined = (o: Props): Props => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Content sections in the slot contract of the V3-08 patterns, only from the owner's plan texts and photos: a section
 * whose required content the facts do not give (two FAQ answers, opening hours and a map for contacts, a price list)
 * is left out rather than filled with invented data (D49).
 */
function contentProps(type: SectionType, c: SectionContext): Props | null {
  const f = c.facts;
  const photo = (slot: string) => {
    const p = f.photos.find((x) => x.slot === slot);
    return p ? { src: p.src, alt: p.alt } : undefined;
  };
  switch (type) {
    case "services": {
      const p = planSection(f, ["services", "features"], ["title", "text"]);
      if (!p?.title || p.items.length < 2) return null;
      return defined({ title: p.title, intro: p.intro, items: p.items, note: p.note });
    }
    case "about": {
      const p = planSection(f, ["about", "text"], ["title"]);
      if (!p?.title || !p.text) return null;
      return defined({ title: p.title, paragraphs: [p.text], image: photo("about") });
    }
    case "gallery": {
      const images = f.photos.filter((x) => /^gallery(-\d+)?$/.test(x.slot));
      if (images.length < 2) return null;
      const p = planSection(f, ["gallery"], ["caption"]);
      return defined({
        title: p?.title ?? "Фото",
        lead: p?.intro,
        images: images.map((x) => ({ src: x.src, alt: x.alt })),
      });
    }
    case "team": {
      const p = planSection(f, ["team"], ["name", "role", "text"]);
      const people = (p?.items ?? [])
        .filter((x) => x.role)
        .map((x) => defined({ name: x.name, role: x.role, bio: x.text }));
      return p?.title && people.length ? defined({ title: p.title, intro: p.intro, people }) : null;
    }
    case "testimonials": {
      // Only real reviews of the owner: a text with its author (and the source when the plan names it).
      const p = planSection(f, ["testimonials"], ["text", "author", "source"]);
      const reviews = (p?.items ?? [])
        .filter((x) => x.text && x.author)
        .map((x) =>
          defined({ text: x.text, author: x.author, source: x.source ? { label: x.source } : undefined }),
        );
      return reviews.length ? defined({ title: p?.title ?? "Отзывы", reviews }) : null;
    }
    case "faq": {
      const p = planSection(f, ["faq"], ["question", "answer"]);
      const qa = (p?.items ?? [])
        .filter((x) => x.question && x.answer)
        .map((x) => ({ q: x.question, a: x.answer }));
      return p?.title && qa.length >= 2 ? defined({ title: p.title, intro: p.intro, items: qa }) : null;
    }
    default:
      // pricing needs a price list, contacts — opening hours and a map link: the plan of a module does not give them.
      return null;
  }
}

/** Labels of a button that say nothing about the action (catalog K09). */
const VAGUE = new Set(["Отправить", "Подробнее", "Узнать больше", "Далее"]);

/** Real steps of the owner's plan (2–4 lines): what happens after a request. */
function planSteps(f: SiteFacts, max: number): string[] | undefined {
  const steps = items(f.texts.get("steps")?.items, ["title"]).map((s) => s.title as string);
  return steps.length >= 2 && steps.length <= 4 && steps.every((s) => s.length <= max) ? steps : undefined;
}

/**
 * Props of a section bound to a headless hook (C4) in the slot contract of the V3-08 patterns with needs: the binding
 * (entity, the booking configuration, the catalog sections entity, the booking page of the catalog items) and the
 * section's own texts. The answer after a write and the empty list are functional wordings, never promises the owner
 * did not give (D49); the heading, the intro and the button come from the plan when it has them.
 */
function boundProps(type: SectionType, c: SectionContext): Props | null {
  const b = c.binding;
  if (!b) return null;
  if (c.page.module === CONTENT_MODULE) return contentEntryProps(type, c, b);
  const f = c.facts;
  const entity = b.action.entity;
  const contact = f.phone ? { contact: { label: f.phone, href: telHref(f.phone) } } : {};
  if (type === "form" && b.needs === "booking") {
    const cfg = b.action.booking;
    if (!cfg) return null;
    const text = fits(textOf(f, "booking", "intro"), LINE.lead);
    const submit = fits(textOf(f, "booking", "cta"), LINE.label);
    return {
      entity,
      booking: {
        schedule: cfg.schedule,
        serviceEntity: cfg.serviceEntity,
        ...(cfg.durationField ? { durationField: cfg.durationField } : {}),
        ...(cfg.specialistEntity ? { specialistEntity: cfg.specialistEntity } : {}),
        ...(b.packageCheckFn ? { packageCheckFn: b.packageCheckFn } : {}),
      },
      title: fits(textOf(f, "booking", "title"), LINE.cta) ?? "Запись онлайн",
      ...(text ? { text } : {}),
      submit: submit && !VAGUE.has(submit) ? submit : "Записаться",
      sent: { title: "Вы записаны" },
      again: "Записаться ещё раз",
      ...contact,
    };
  }
  if (type === "form") {
    const text = fits(textOf(f, "lead_form", "intro"), LINE.lead);
    const submit = fits(textOf(f, "lead_form", "submit_label"), LINE.label);
    const points = planSteps(f, 120);
    return {
      entity,
      title: fits(textOf(f, "lead_form", "title"), LINE.cta) ?? "Оставьте заявку",
      ...(text ? { text } : {}),
      submit: submit && !VAGUE.has(submit) ? submit : "Отправить заявку",
      sent: { title: "Заявка отправлена" },
      again: "Отправить ещё одну заявку",
      ...(points ? { points } : {}),
      ...contact,
    };
  }
  if (type === "catalog") {
    const booking = c.pages.find((p) => p.kind === "booking");
    return {
      entity,
      ...(b.categoryEntity ? { categoryEntity: b.categoryEntity } : {}),
      // The page heading (h1) is the screen title; the showcase heading says what the list is, without repeating it.
      title: c.page.title.trim().toLowerCase() === "услуги и цены" ? "Все услуги" : "Услуги и цены",
      empty: "В каталоге пока нет позиций",
      ...(booking ? { itemAction: { label: "Записаться", path: booking.route } } : {}),
    };
  }
  return { entity, title: fits(c.page.title, LINE.cta) ?? "Материалы", empty: "Записей пока нет" };
}

/** The route of a screen of «Контент и блог» on the site (a list, an entry page). */
const contentRoute = (c: SectionContext, screen: string | undefined) =>
  screen ? c.pages.find((p) => p.module === CONTENT_MODULE && p.screen === screen)?.route : undefined;

/**
 * Sections of the pages of «Контент и блог» (V3-24) in the slot contract of the article, rubric and blog patterns:
 * the entity of the screen, the address prefixes of its entry pages and rubric pages, the way back to the list. The
 * texts are functional (the list's name is the page's title); entries, dates and rubrics come from the data.
 */
function contentEntryProps(type: SectionType, c: SectionContext, b: Binding): Props | null {
  const screen = c.page.screen ? CONTENT_SCREENS[c.page.screen] : undefined;
  if (!screen) return null;
  const entity = b.action.entity;
  const entryRoute = contentRoute(c, screen.entry);
  const listPage = c.pages.find((p) => p.module === CONTENT_MODULE && p.screen === screen.list);
  const rubricRoute = c.pages.find((p) => p.module === CONTENT_MODULE && p.kind === "rubric")?.route;
  const articles = entity === CONTENT_NAMES.article;
  const listTitle = fits(c.page.kind === "content" ? c.page.title : listPage?.title, LINE.cta);
  if (type === "article") {
    if (!isParamRoute(c.page.route)) return null;
    return {
      entity,
      path: entryPrefix(c.page.route),
      ...(articles && rubricRoute ? { rubric: { path: entryPrefix(rubricRoute) } } : {}),
      ...(listPage
        ? { back: { label: fits(listPage.title, LINE.label) ?? "Все записи", href: listPage.route } }
        : {}),
      missing: "Возможно, запись убрали или адрес набран с ошибкой.",
    };
  }
  if (type === "rubric") {
    if (!rubricRoute) return null;
    const list = c.page.kind === "content" ? c.page : listPage;
    return {
      entity,
      ...(entryRoute ? { path: entryPrefix(entryRoute) } : {}),
      rubrics: { path: entryPrefix(rubricRoute) },
      title: c.page.kind === "content" ? "Все записи" : (listTitle ?? "Все записи"),
      level: c.page.kind === "rubric" ? 1 : 2,
      ...(list ? { all: { label: "Все", href: list.route } } : {}),
      empty: "Записей пока нет — загляните позже",
      pageSize: 6,
    };
  }
  if (type === "blog")
    return {
      entity,
      fields: { date: screen.dateField },
      ...(entryRoute ? { path: entryPrefix(entryRoute) } : {}),
      title: articles ? "Все записи" : "Все страницы",
      empty: articles ? "Записей пока нет — загляните позже" : "Страниц пока нет",
      pageSize: 9,
    };
  return null;
}

/** Props of a section of a page kind, or null when there is nothing honest to show. */
export function sectionProps(type: SectionType, c: SectionContext): Props | null {
  switch (type) {
    case "header":
      return headerProps(c);
    case "footer":
      return footerProps(c);
    case "hero":
      return heroProps(c);
    case "cta":
      return ctaProps(c);
    case "form":
    case "catalog":
    case "blog":
    case "article":
    case "rubric":
      return boundProps(type, c);
    default:
      return c.page.kind === "home" || type === "faq" || type === "contacts" ? contentProps(type, c) : null;
  }
}

/** The photo the first screen shows (its variant kept `image` or `images`). */
export function heroPhoto(hero: Props | null | undefined): string | undefined {
  const one = (hero?.image as { src?: string } | undefined)?.src;
  const many = (hero?.images as { src?: string }[] | undefined)?.[0]?.src;
  return one ?? many;
}

/** SEO of a page: title and description from the facts (≤ 70 / ≤ 160 characters), og:image from the hero photo. */
export function seoOf(
  f: SiteFacts,
  page: Pick<PlannedPage, "route" | "title" | "kind">,
  hero: Props | null,
): { title: string; description: string; image?: string } {
  const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
  const title = page.kind === "home" ? `${f.name} — ${f.niche}` : `${page.title} — ${f.name}`;
  const lead = typeof hero?.lead === "string" ? hero.lead : undefined;
  const description =
    page.kind === "home"
      ? (lead ?? f.description ?? `${f.name}: ${f.niche}.`)
      : `${page.title}. ${f.name}: ${f.niche}.`;
  const image = heroPhoto(hero);
  return {
    title: clip(title, 70),
    description: clip(description, 160),
    ...(image ? { image } : {}),
  };
}

export const KIND_LABELS: Readonly<Record<PageKind, string>> = {
  home: "главная",
  catalog: "каталог",
  booking: "запись",
  content: "раздел",
  account: "кабинет клиента",
  credits: "источники фото",
  entry: "страница записи",
  rubric: "рубрика",
};
