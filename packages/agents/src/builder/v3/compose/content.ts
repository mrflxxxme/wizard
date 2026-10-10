// Content of the skeleton sections (no model): every text comes from the facts (brief, approved plan, spec); where a
// fact is missing the section gets an honest functional wording («Оставьте заявку») or is left out — never numbers,
// reviews or claims the owner did not give (D49, catalog H.4). Props are the union of what the variants of a section
// type may show; the slot schema of the chosen pattern keeps its part.
import {
  CONTENT_NAMES,
  CONTENT_SCREENS,
  entryPrefix,
  SHOP_TERMS_LABELS,
  SHOP_TERMS_ROUTES,
} from "@wizard/modules";
import { PATTERNS, type PatternMeta, patternById, type SectionType } from "@wizard/ui-kit/v3/patterns";
import { type CabinetSection, VISITOR_CABINET_MODULE } from "./account.js";
import { type SiteFacts, textOf } from "./facts.js";
import {
  ANCHOR_LABELS,
  type Binding,
  CONTENT_MODULE,
  isParamRoute,
  type PageKind,
  type PlannedPage,
  type SectionPhotos,
  SHOP_MODULE,
  type SiteModel,
  type SiteSection,
} from "./site.js";

/** Where the main action of the site leads: a section of a page (form) or a page, a phone, an e-mail. */
export interface SiteAction {
  kind: "form" | "booking" | "catalog" | "shop" | "page" | "phone" | "email";
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
      : {
          kind: "form",
          // The button the brief quotes for a request («Обсудить проект»).
          label: heroCta ?? fits(facts.copy.action, LINE.label) ?? "Оставить заявку",
          route: "/",
          anchor: "form",
        };
  const booking = pages.find((p) => p.kind === "booking");
  if (booking)
    return {
      kind: "booking",
      label: heroCta ?? "Записаться",
      route: booking.route,
      ...(bookingForm ? { anchor: "form" } : {}),
    };
  const shop = pages.find((p) => p.kind === "shop");
  if (shop) return { kind: "shop", label: SHOP_ACTION, route: shop.route };
  const catalog = pages.find((p) => p.kind === "catalog");
  if (catalog) return { kind: "catalog", label: "Открыть каталог", route: catalog.route };
  if (facts.phone) return { kind: "phone", label: "Позвонить", href: telHref(facts.phone) };
  if (facts.email) return { kind: "email", label: "Написать письмо", href: `mailto:${facts.email}` };
  const other = pages.find((p) => p.kind !== "home" && p.kind !== "credits" && !isParamRoute(p.route));
  return other
    ? { kind: "page", label: fits(other.title, LINE.label) ?? "Подробнее о разделе", route: other.route }
    : null;
}

/** The label of the way to the shop's goods (V3-23). */
const SHOP_ACTION = "Перейти в магазин";

/** A second action for the first screen: the shop or the catalog when the main one is a form, else none. */
export function secondaryAction(
  primary: SiteAction | null,
  pages: readonly PlannedPage[],
): SiteAction | null {
  if (!primary || primary.kind === "catalog" || primary.kind === "shop") return null;
  const shop = pages.find((p) => p.kind === "shop");
  if (shop) return { kind: "shop", label: SHOP_ACTION, route: shop.route };
  const catalog = pages.find((p) => p.kind === "catalog");
  return catalog ? { kind: "catalog", label: "Открыть каталог", route: catalog.route } : null;
}

const CTA_TITLES: Record<SiteAction["kind"], string> = {
  form: "Оставьте заявку",
  booking: "Запишитесь онлайн",
  catalog: "Посмотрите каталог",
  shop: "Выберите товары в магазине",
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
  /** Path of the site's request form («/#form») when the site has one (where a catalog item leads without booking). */
  leadForm?: string;
  /** The client cabinet of «Кабинет посетителя» (V3-18): the visitor role and the sections of his records. */
  cabinet?: { role: string; sections: CabinetSection[] };
}

type MenuPage = Pick<PlannedPage, "kind" | "route" | "module" | "screen">;

/** A page of the menus at all: not a utility page (photo credits), the client cabinet or an entry page. */
const menuPage = (p: MenuPage) => p.kind !== "credits" && p.kind !== "account" && !isParamRoute(p.route);

/**
 * A page of the header menu (V3-18): the lists of «Контент и блог» start empty (no entries in the seed or in prod), so
 * they live in the footer — the articles reach the header only on a site that has nothing else to show, the site's
 * information pages never.
 */
export function inHeader(p: MenuPage, pages: readonly MenuPage[]): boolean {
  if (!menuPage(p)) return false;
  if (p.module !== CONTENT_MODULE) return true;
  const others = pages.some((x) => x.kind !== "home" && x.module !== CONTENT_MODULE && menuPage(x));
  return !others && p.screen === "blog";
}

function headerNav(c: SectionContext): Link[] {
  const pages = c.pages.filter((p) => inHeader(p, c.pages));
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
  // V3-18: the business name the owner gave, else what the business is (never a placeholder or a cut name).
  return { name: f.copy.site, href: "/" };
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

/** The client cabinet /me: its account section is the heading of the page (h1), no first screen above it. */
const isCabinet = (c: SectionContext) =>
  c.page.kind === "account" && c.page.module === VISITOR_CABINET_MODULE && !!c.cabinet;

function heroProps(c: SectionContext): Props | null {
  const { facts: f, page } = c;
  if (isCabinet(c)) return null;
  const main = heroAction(c);
  if (!main) return null;
  if (page.kind !== "home") {
    const lead = pageLead(c);
    return { title: page.title, action: main, ...(lead ? { lead } : {}) };
  }
  // The owner's heading, else the system's description, else what the brief says the business offers and where.
  const title =
    fits(textOf(f, "hero", "title"), LINE.title) ??
    fits(f.description, LINE.title) ??
    fits(f.copy.title, LINE.title) ??
    f.copy.title;
  const lead =
    forAction(fits(textOf(f, "hero", "subtitle"), LINE.lead), c.primary) ??
    (title === f.description ? undefined : fits(f.description, LINE.lead)) ??
    forAction(fits(f.copy.lead, LINE.lead), c.primary);
  const photos = f.photos.filter((p) => p.slot === "top" || /^top-\d+$/.test(p.slot));
  const out: Props = { title, action: main };
  if (lead) out.lead = lead;
  if (c.secondary) out.secondary = actionLink(c.secondary, page.route);
  if (photos[0]) out.image = { src: photos[0].src, alt: photos[0].alt };
  if (photos.length >= 2) out.images = photos.slice(0, 3).map((p) => ({ src: p.src, alt: p.alt }));
  return out;
}

/**
 * The intro of an inner page's first screen (V3-18): what the page holds in the brief's words — the services of the
 * catalog, how the booking goes, where the photos come from; none — the page's own sections speak.
 */
function pageLead(c: SectionContext): string | undefined {
  const f = c.facts;
  switch (c.page.kind) {
    case "catalog":
      return (
        fits(textOf(f, "services", "intro"), LINE.lead) ?? forAction(fits(f.copy.lead, LINE.lead), c.primary)
      );
    case "booking":
      return f.bookingByRequest
        ? "Выберите услугу, день и удобное время — мы подтвердим запись."
        : "Выберите услугу, день и свободное время.";
    case "credits":
      return creditsLead(f);
    default:
      return undefined;
  }
}

/** «Источники фото»: the stocks' licences and the authors of the photos the site shows (as many as fit). */
export function creditsLead(f: SiteFacts): string | undefined {
  const credits = [...new Set(f.photos.flatMap((p) => (p.credit ? [p.credit] : [])))];
  if (credits.length === 0) return undefined;
  const head = "Фотографии на сайте — со стоков, по их бесплатным лицензиям. Авторы: ";
  for (let n = credits.length; n > 0; n--) {
    const text = `${head}${credits.slice(0, n).join("; ")}${n < credits.length ? " и другие" : ""}.`;
    if (text.length <= LINE.lead) return text;
  }
  return undefined;
}

function ctaProps(c: SectionContext): Props | null {
  const a = c.primary;
  if (!a) return null;
  // V3-18: home already opens with the main action (the first screen's button) — no second call repeating it.
  if (c.page.kind === "home") return null;
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
  // V3-18: «© <year>» with the operator the owner gave; before he gives one (a draft) — the site's name, no placeholder.
  const owner = fits(f.operator, 112);
  const out: Props = {
    brand: brand(f),
    columns: [{ title: "Разделы", links }],
    legal: {
      operator: owner
        ? `© ${f.year} ${owner}`
        : (fits(f.operator, 120) ?? fits(`© ${f.year} ${f.copy.site}`, 120) ?? `© ${f.year}`),
      ...(f.operatorInn || f.operatorOgrn
        ? {
            details: [
              f.operatorInn ? `ИНН ${f.operatorInn}` : "",
              f.operatorOgrn ? `${f.operatorOgrn.length === 15 ? "ОГРНИП" : "ОГРН"} ${f.operatorOgrn}` : "",
            ]
              .filter(Boolean)
              .join(", "),
          }
        : {}),
      policy: { label: "Политика обработки персональных данных", href: f.policyPage },
      // V3-18: a shop links its offer, delivery and payment, returns (ст. 26.1 ЗоЗПП) on every page.
      ...(c.pages.some((p) => p.module === SHOP_MODULE) ? { links: shopTermsLinks() } : {}),
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
      if (p?.title && p.items.length >= 2)
        return defined({ title: p.title, intro: p.intro, items: p.items, note: p.note });
      // V3-18: the services (or goods) the brief or the owner lists, as he wrote them.
      const listed = f.copy.services ?? [];
      if (listed.length < 2) return null;
      return { title: "Что мы предлагаем", items: listed.slice(0, 8).map((x) => ({ title: cap(x) })) };
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
    case "contacts": {
      // V3-18: the phone, the e-mail and the address the owner gave (no hours or map of our own), on home and booking.
      if (c.page.kind !== "home" && c.page.kind !== "booking") return null;
      const address = fits(f.address, 140);
      const email = f.email && f.email.length <= 80 ? f.email : undefined;
      if (!f.phone && !email && !address) return null;
      return defined({
        title: "Контакты",
        address: address ? { text: address } : undefined,
        phones: f.phone ? [{ number: f.phone, href: telHref(f.phone) }] : undefined,
        email,
      });
    }
    default:
      // pricing needs a price list: the plan of a module does not give one.
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
  if (b.action.shop) return shopProps(type, c, b);
  if (type === "blog" && c.page.kind === "home") return homeBlogProps(c, b);
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
      title:
        fits(textOf(f, "booking", "title"), LINE.cta) ?? fits(f.copy.booking, LINE.cta) ?? "Запись онлайн",
      ...(text ? { text } : {}),
      submit: submit && !VAGUE.has(submit) ? submit : "Записаться",
      sent: { title: f.bookingByRequest ? SENT_TITLES.bookingRequest : SENT_TITLES.booking },
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
      title:
        fits(textOf(f, "lead_form", "title"), LINE.cta) ??
        fits(f.copy.leadForm, LINE.cta) ??
        "Оставьте заявку",
      ...(text ? { text } : {}),
      submit: submit && !VAGUE.has(submit) ? submit : "Отправить заявку",
      sent: { title: SENT_TITLES.lead },
      again: "Отправить ещё одну заявку",
      ...(points ? { points } : {}),
      ...contact,
    };
  }
  if (type === "catalog") {
    const booking = c.pages.find((p) => p.kind === "booking");
    // V3-18: what the catalog shows in the brief's words («туры»), else the module's «услуги».
    const noun = f.copy.catalog;
    // An item leads to its booking, else to the request form of the site (as the module's showcase, GS-catalog-4).
    const itemAction = booking
      ? { label: "Записаться", path: booking.route }
      : c.leadForm
        ? { label: "Оставить заявку", path: c.leadForm }
        : null;
    const empty = (noun && fits(`${cap(noun)} скоро появятся`, 120)) || "В каталоге пока нет позиций";
    if (c.page.kind === "home") {
      // A preview of the first items with the way to the whole catalog: nothing while the catalog is empty.
      const page = c.pages.find((p) => p.kind === "catalog");
      const all = (noun && fits(`Все ${noun}`, LINE.label)) || "Весь каталог";
      return {
        entity,
        title: (noun && fits(cap(noun), LINE.cta)) || "Услуги и цены",
        empty,
        pageSize: 6,
        preview: true,
        ...(page ? { action: { label: all, href: page.route } } : {}),
        ...(itemAction ? { itemAction } : {}),
      };
    }
    const own = c.page.title.trim().toLowerCase();
    return {
      entity,
      ...(b.categoryEntity ? { categoryEntity: b.categoryEntity } : {}),
      // The page heading (h1) is the screen title; the showcase heading says what the list is, without repeating it.
      title: noun
        ? (fits(`Все ${noun}`, LINE.cta) ?? cap(noun))
        : own === "услуги и цены"
          ? "Все услуги"
          : "Услуги и цены",
      empty,
      ...(itemAction ? { itemAction } : {}),
    };
  }
  return { entity, title: fits(c.page.title, LINE.cta) ?? "Материалы", empty: "Записей пока нет" };
}

/** The seller's pages of a shop (served by the runtime from the seller's requisites, V3-18). */
const shopTermsLinks = () =>
  (["offer", "delivery", "returns"] as const).map((k) => ({
    label: SHOP_TERMS_LABELS[k],
    href: SHOP_TERMS_ROUTES[k],
  }));

/**
 * Sections of «Интернет-магазин» (V3-23) in the slot contract of the shop, cart and order patterns: the goods entity
 * and its sections, the module's checkout (delivery methods, payment, functions), the cart and order pages. The texts
 * are functional (the page's title is the heading of its page); goods, prices and statuses come from the data.
 */
function shopProps(type: SectionType, c: SectionContext, b: Binding): Props | null {
  const cfg = b.action.shop;
  if (!cfg) return null;
  const route = (kind: PageKind) => c.pages.find((p) => p.module === SHOP_MODULE && p.kind === kind)?.route;
  const shopRoute = route("shop");
  const cartRoute = route("cart");
  const productRoute = route("product");
  const back = shopRoute ? { back: { label: "Вернуться к товарам", href: shopRoute } } : {};
  const own = c.page.kind === type;
  if (type === "shop") {
    if (!cartRoute) return null;
    const intro = own ? undefined : fits(textOf(c.facts, "shop", "intro"), LINE.lead);
    // V3-18: on home — a preview of the first six goods with the way to all of them, nothing while there are none.
    const preview = c.page.kind === "home";
    return {
      entity: b.action.entity,
      ...(cfg.categoryEntity && !preview ? { categoryEntity: cfg.categoryEntity } : {}),
      fields: { stock: cfg.stockField },
      title: own
        ? (fits(c.page.title, LINE.cta) ?? "Товары")
        : (fits(textOf(c.facts, "shop", "title"), LINE.cta) ?? "Товары"),
      ...(intro ? { text: intro } : {}),
      level: own ? 1 : 2,
      empty: "Товары скоро появятся",
      pageSize: own ? 24 : preview ? 6 : 8,
      ...(preview
        ? { preview: true, ...(shopRoute ? { all: { label: "Все товары", href: shopRoute } } : {}) }
        : {}),
      cart: { label: "Корзина", href: cartRoute },
      ...(productRoute ? { product: { path: productRoute.replace(/:id$/, "") } } : {}),
    };
  }
  if (type === "product") {
    if (!cartRoute || !isParamRoute(c.page.route)) return null;
    return {
      entity: b.action.entity,
      path: c.page.route.replace(/:id$/, ""),
      fields: { stock: cfg.stockField },
      cart: { label: "Корзина", href: cartRoute },
      ...(shopRoute ? { back: { label: "Все товары", href: shopRoute } } : {}),
      missing: "Возможно, товар сняли с продажи или адрес набран с ошибкой.",
    };
  }
  if (type === "cart") {
    const note = fits(textOf(c.facts, "delivery", "note"), 200);
    return {
      title: fits(c.page.title, LINE.cta) ?? "Корзина",
      level: 1,
      checkout: {
        methods: cfg.methods,
        online: cfg.online,
        ...(cfg.courierPrice !== undefined ? { courierPrice: cfg.courierPrice } : {}),
        pointEntity: cfg.pointEntity,
        placeFn: cfg.placeFn,
        cdekFn: cfg.cdekFn,
        ...(cfg.payment ? { payment: cfg.payment } : {}),
        orderPath: cfg.orderPath,
        ...(cfg.consentMessages ? { consentMessages: true } : {}),
      },
      ...back,
      terms: Object.fromEntries(
        (["offer", "delivery", "returns"] as const).map((k) => [
          k,
          { label: SHOP_TERMS_LABELS[k], href: SHOP_TERMS_ROUTES[k] },
        ]),
      ),
      empty: "В корзине пока ничего нет",
      ...(note ? { note } : {}),
    };
  }
  if (type === "order") {
    if (!isParamRoute(c.page.route)) return null;
    const f = c.facts;
    return {
      level: 1,
      path: cfg.orderPath,
      ...(cfg.payment ? { payment: cfg.payment } : {}),
      ...back,
      ...(f.phone ? { contact: { label: f.phone, href: telHref(f.phone) } } : {}),
    };
  }
  return null;
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
      // V3-18: the site's information pages are a list without dates (their date is the last edit, not news).
      ...(articles ? {} : { dates: false }),
    };
  return null;
}

/**
 * The latest articles of «Контент и блог» on home (V3-18): three of them with the way to their list, nothing while
 * there are none (the seed and prod start without articles).
 */
function homeBlogProps(c: SectionContext, b: Binding): Props {
  const list = c.pages.find((p) => p.module === CONTENT_MODULE && p.screen === "blog");
  const entry = contentRoute(c, CONTENT_SCREENS.blog?.entry);
  return {
    entity: b.action.entity,
    fields: { date: CONTENT_SCREENS.blog?.dateField ?? "published_at" },
    ...(entry ? { path: entryPrefix(entry) } : {}),
    title: fits(list?.title, LINE.cta) ?? "Блог",
    empty: "Записей пока нет — загляните позже",
    pageSize: 3,
    preview: true,
    ...(list ? { action: { label: "Все записи", href: list.route } } : {}),
  };
}

/**
 * The client cabinet (V3-18) in the slot contract of the account patterns: the page's title as its h1, the sections of
 * the visitor's records, sign-in by a code with the way back, the site's main action for an empty cabinet.
 */
function accountProps(c: SectionContext): Props | null {
  if (!isCabinet(c) || !c.cabinet) return null;
  const next = new URLSearchParams({ role: c.cabinet.role, next: c.page.route });
  return {
    title: fits(c.page.title, LINE.cta) ?? "Личный кабинет",
    level: 1,
    sections: c.cabinet.sections,
    signIn: { label: "Войти по коду", href: `/login?${next}` },
    ...(c.primary ? { action: actionLink(c.primary, c.page.route) } : {}),
    empty: "Здесь появятся ваши записи и заявки",
  };
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
    case "account":
      return accountProps(c);
    case "form":
    case "catalog":
    case "blog":
    case "article":
    case "rubric":
    case "shop":
    case "cart":
    case "order":
    case "product":
      return boundProps(type, c);
    default:
      return c.page.kind === "home" || type === "faq" || type === "contacts" ? contentProps(type, c) : null;
  }
}

// ------------------------------------------------------------------------------------- the owner's photos (V3-18)

/** Places of the owner's photos of a type, in page order (hero: top, top-2…; about; gallery…; features…). */
const placesOf = (f: SiteFacts, type: SiteFacts["places"][number]["type"]) =>
  f.places.filter((p) => p.type === type).map((p) => p.slot);

/**
 * Places of the owner's photos a home section shows («Фото сайта», B2-38: the landing's slots of the plan — the same
 * the cabinet lists): the first screen its hero places, «О нас» its photo, the gallery its pictures by their slots,
 * the services the picture of each item. Undefined — the section has no place.
 */
export function sectionPhotos(type: SectionType, c: SectionContext, props: Props): SectionPhotos | undefined {
  const f = c.facts;
  if (c.page.kind !== "home" || f.places.length === 0) return undefined;
  const out: SectionPhotos = {};
  if (type === "hero") {
    const top = placesOf(f, "hero");
    if (top[0]) out.image = top[0];
    if (top.length >= 2 && Array.isArray(props.images)) out.images = top;
  } else if (type === "about") {
    const about = placesOf(f, "about");
    if (about[0]) out.image = about[0];
  } else if (type === "gallery" && Array.isArray(props.images)) {
    // The gallery shows the stock photos of its places in their order: each picture keeps its place.
    const shown = f.photos.filter((x) => /^gallery(-\d+)?$/.test(x.slot)).map((x) => x.slot);
    const places = new Set(placesOf(f, "gallery"));
    if (shown.some((slot) => places.has(slot))) out.images = shown;
  } else if (type === "services" && Array.isArray(props.items)) {
    const features = placesOf(f, "features");
    if (features.length) out.items = features.slice(0, props.items.length);
  }
  return Object.keys(out).length ? out : undefined;
}

type Shape = Record<string, unknown>;
type ZodDef = { type?: string; innerType?: unknown; element?: unknown };
const defOf = (t: unknown): ZodDef => (t as { _zod?: { def?: ZodDef } } | undefined)?._zod?.def ?? {};
/** The schema without optional / nullable / default wrappers. */
function bare(t: unknown): unknown {
  let x = t;
  for (let d = defOf(x); d.type === "optional" || d.type === "nullable" || d.type === "default"; d = defOf(x))
    x = d.innerType;
  return x;
}
const shapeOf = (t: unknown): Shape => (bare(t) as { shape?: Shape } | undefined)?.shape ?? {};

/** Slot names of a variant and of its items (the zod object schema of the pattern). */
export function slotShape(p: PatternMeta): { keys: Set<string>; itemKeys: Set<string> } {
  const shape = shapeOf(p.slots);
  return {
    keys: new Set(Object.keys(shape)),
    itemKeys: new Set(Object.keys(shapeOf(defOf(bare(shape.items)).element))),
  };
}

/** The places a variant can show: `image` with its image slot, `images` with its list, `items` with item pictures. */
export function fitPhotos(
  p: PatternMeta | undefined,
  photos: SectionPhotos | undefined,
  props: Props,
): SectionPhotos | undefined {
  if (!p || !photos) return undefined;
  const { keys, itemKeys } = slotShape(p);
  const out: SectionPhotos = {};
  if (photos.image && keys.has("image")) out.image = photos.image;
  if (photos.images && keys.has("images") && Array.isArray(props.images)) out.images = photos.images;
  if (photos.items && itemKeys.has("image") && Array.isArray(props.items)) out.items = photos.items;
  return Object.keys(out).length ? out : undefined;
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
  // The same source as the first screen (V3-18): the owner's business name, what the business is in his words and
  // its place — never a placeholder name, never the first words of the brief cut off.
  const { home, site } = f.copy;
  const own = `${page.title} — ${site}`;
  const title = page.kind === "home" ? home : own.length <= 70 ? own : page.title;
  const lead = typeof hero?.lead === "string" ? hero.lead : undefined;
  const fit = (...xs: (string | undefined)[]) => xs.find((x) => x && x.length <= 160);
  const description =
    (page.kind === "home"
      ? fit(lead && `${home}. ${lead}`, lead, f.description, `${home}.`)
      : fit(`${page.title}. ${home}.`, `${page.title}. ${site}.`)) ??
    lead ??
    `${home}.`;
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
  shop: "магазин",
  cart: "корзина",
  order: "заказ покупателя",
  product: "страница товара",
};

/** The «sent» headings of the module forms: the goal scenarios read them after a write (GS-leads-1, GS-booking-1). */
export const SENT_TITLES = {
  lead: "Заявка отправлена",
  booking: "Вы записаны",
  /** Bookings the staff confirms (confirm = manual), as the module's v2 page. */
  bookingRequest: "Заявка на запись отправлена",
} as const;
/** A booking heading the booking goal scenarios accept (staff confirmation says «Заявка на запись отправлена»). */
const BOOKED_RE = /Вы записаны|Заявка на запись отправлена/;

/** A form section bound to its module (request or booking). */
const isForm = (s: SiteSection) => s.type === "form" && typeof s.props.entity === "string";

/** «#form» on the form's own page, «/#form» or «/booking#form» elsewhere. */
const formHref = (route: string, id: string, from: string) => (route === from ? `#${id}` : `${route}#${id}`);

/** The first screen's main action led to `href` (the label stays). */
function heroTo(s: SiteSection, href: string): SiteSection {
  const action = s.props.action as { label?: unknown; href?: unknown } | undefined;
  if (!action || typeof action.label !== "string" || action.href === href) return s;
  return { ...s, props: { ...s.props, action: { ...action, href } } };
}

/** A catalog item's action to `target` when the variant shows item actions (its slot schema keeps one). */
function itemsTo(
  s: SiteSection,
  target: { label: string; path: string },
  patternOf: (id: string) => PatternMeta | undefined,
): SiteSection {
  const now = s.props.itemAction as { label?: unknown; path?: unknown } | undefined;
  const itemAction = { label: typeof now?.label === "string" ? now.label : target.label, path: target.path };
  if (now?.path === itemAction.path && now.label === itemAction.label) return s;
  const parsed = patternOf(s.pattern)?.slots.safeParse({ ...s.props, itemAction });
  if (!parsed?.success || (parsed.data as Props).itemAction === undefined) return s;
  return { ...s, props: { ...s.props, itemAction } };
}

/** The «sent» heading of a module form in the module's wording (the owner's text under it stays). */
function sentTitle(s: SiteSection): SiteSection {
  const booking = s.props.booking !== undefined;
  const sent = (s.props.sent ?? {}) as { title?: unknown };
  const title = typeof sent.title === "string" ? sent.title : "";
  if (booking ? BOOKED_RE.test(title) : title.includes(SENT_TITLES.lead)) return s;
  const fixed = booking ? SENT_TITLES.booking : SENT_TITLES.lead;
  return { ...s, props: { ...s.props, sent: { ...sent, title: fixed } } };
}

/**
 * The rules of the site's actions, kept after every step that writes pages — the skeleton, a model's page, an edit of
 * the critic (siteFiles applies them; builder-v3.md C6): the first screen's main action leads to the request or booking
 * form of its own page (#<section id>), on a page without one — to the form of the site's main action (its page and
 * anchor); a catalog item leads to its booking, else to the request form; a module form's «sent» heading is the
 * module's wording. The modules' goal scenarios check exactly this in the browser (GS-landing-1, GS-catalog-4,
 * GS-leads-1, GS-booking-1). V3-18: every section shows the places of the owner's photos it holds (photoRules,
 * GS-landing-2). `library` — the variants a section may take (default: the ui-kit library and those patternOf knows).
 */
export function siteRules(
  site: SiteModel,
  patternOf: (id: string) => PatternMeta | undefined = patternById,
  library: readonly PatternMeta[] = PATTERNS,
): SiteModel {
  return actionRules(photoRules(site, patternOf, library), patternOf);
}

/** The places of the owner's photos of a section's places, in order (image, images, items). */
const placeList = (p: SectionPhotos | undefined): string[] => [
  ...(p?.image ? [p.image] : []),
  ...(p?.images ?? []),
  ...(p?.items ?? []),
];

/** How many of a section's places a variant shows with these props. */
const shownBy = (meta: PatternMeta | undefined, s: SiteSection, props: Props): number =>
  new Set(placeList(fitPhotos(meta, s.photos, props))).size;

/** Binding slots of the module-bound patterns: a variant that drops one is never taken (the composer's FIXED_KEYS). */
const BINDING_KEYS = [
  "entity",
  "booking",
  "categoryEntity",
  "fields",
  "itemAction",
  "preview",
  "dates",
] as const;

/**
 * V3-18 (GS-landing-2): a section keeps showing the places of the owner's photos («Фото сайта» of the cabinet) it holds,
 * whatever step changed it — a model's page that chose a variant without a picture (hero-typographic), an edit of the
 * critic. When its variant shows fewer of them than another of the same type and binding that accepts its content,
 * the section takes that one (the most places shown, then the most content kept, then the library order). The owner's
 * upload thus always reaches the page; a section without places is left as it is.
 */
function photoRules(
  site: SiteModel,
  patternOf: (id: string) => PatternMeta | undefined,
  library: readonly PatternMeta[],
): SiteModel {
  let changed = false;
  const pages = site.pages.map((page) => {
    const sections = page.sections.map((s) => {
      if (s.type === "signature" || placeList(s.photos).length === 0) return s;
      const meta = patternOf(s.pattern);
      const now = shownBy(meta, s, s.props);
      const needs = meta?.needs ?? null;
      let best: { meta: PatternMeta; props: Props; shown: number; kept: number } | null = null;
      for (const p of [...library, ...(meta && !library.includes(meta) ? [meta] : [])]) {
        if (p.id === s.pattern || p.sectionType !== s.type || p.needs !== needs) continue;
        const parsed = p.slots.safeParse(s.props);
        if (!parsed.success) continue;
        const props = parsed.data as Props;
        if (BINDING_KEYS.some((k) => s.props[k] !== undefined && props[k] === undefined)) continue;
        const shown = shownBy(p, s, props);
        const kept = Object.keys(props).filter((k) => props[k] !== undefined).length;
        if (!best || shown > best.shown || (shown === best.shown && kept > best.kept))
          best = { meta: p, props, shown, kept };
      }
      if (!best || best.shown <= now) return s;
      return { ...s, pattern: best.meta.id, props: best.props };
    });
    if (sections.every((s, i) => s === page.sections[i])) return page;
    changed = true;
    return { ...page, sections };
  });
  return changed ? { ...site, pages } : site;
}

/** The action rules of siteRules: the first screen's action, the catalog items, the «sent» headings. */
function actionRules(site: SiteModel, patternOf: (id: string) => PatternMeta | undefined): SiteModel {
  const forms = site.pages.flatMap((p) =>
    p.sections
      .filter(isForm)
      .map((s) => ({ route: p.route, id: s.id, booking: s.props.booking !== undefined })),
  );
  const first = forms[0];
  if (!first) return site;
  const p = site.primary;
  const named =
    p && (p.kind === "form" || p.kind === "booking") ? forms.find((f) => f.route === p.route) : undefined;
  const main = named ?? forms.find((f) => !f.booking) ?? first;
  const booking = forms.find((f) => f.booking);
  const lead = forms.find((f) => !f.booking);
  const itemTarget = booking
    ? { label: "Записаться", path: booking.route === "/" ? formHref("/", booking.id, "") : booking.route }
    : lead
      ? { label: "Оставить заявку", path: formHref(lead.route, lead.id, "") }
      : null;
  let changed = false;
  const pages = site.pages.map((page) => {
    const own = page.sections.find(isForm);
    const hero = page.sections.find((s) => s.type === "hero");
    const heroHref = own ? `#${own.id}` : formHref(main.route, main.id, page.route);
    const sections = page.sections.map((s) => {
      let next = s;
      if (s === hero) next = heroTo(s, heroHref);
      else if (s.type === "catalog" && itemTarget) next = itemsTo(s, itemTarget, patternOf);
      else if (isForm(s)) next = sentTitle(s);
      return next;
    });
    if (sections.every((s, i) => s === page.sections[i])) return page;
    changed = true;
    return { ...page, sections };
  });
  return changed ? { ...site, pages } : site;
}
