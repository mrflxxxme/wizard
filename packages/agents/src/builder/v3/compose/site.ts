// The site model of the page composer (V3-12): which public pages the system has and in what order their sections go.
// Pages come from the public front of the backend-mode modules (V3-10: screens left to v3, data actions served by the
// headless hooks) plus the home page; the order of sections follows the page kind (catalog D2: the site with requests
// and the booking flow). The model is stored in the system as ui/site.json, so a scenario step continues the skeleton.
import type { AppSpec, Page } from "@wizard/appspec";
import {
  CATALOG_NAMES,
  CONTENT_NAMES,
  CONTENT_SCREENS,
  type PublicAction,
  type PublicFront,
  type PublicScreen,
} from "@wizard/modules";
import type { PatternNeeds, SectionType } from "@wizard/ui-kit/v3/patterns";
import type { V3PagePlan } from "../contract.js";
import type { SiteAction } from "./content.js";

/** Composer state in the system repository (not read by the build). */
export const SITE_PATH = "ui/site.json";
/** Folder of the composed page files (inside ui/pages: Tailwind and the v3 import rules apply). */
export const SITE_PAGES_DIR = "ui/pages/site";
/** Folder of the signature sections written as free code. */
export const SECTIONS_DIR = "ui/sections";
/** At most this many signature sections per site (D77 (6)). */
export const MAX_SIGNATURES = 2;

/**
 * Kind of a page: its section order and bindings. V3-24: `entry` — one entry of «Контент и блог» by the slug of the
 * address (/blog/:slug, /pages/:slug), `rubric` — the posts of a rubric (/blog/rubric/:slug).
 */
export type PageKind =
  | "home"
  | "catalog"
  | "booking"
  | "content"
  | "account"
  | "credits"
  | "entry"
  | "rubric"
  | "shop"
  | "cart"
  | "order";

/** The module «Контент и блог» (V3-24). */
export const CONTENT_MODULE = "content";
/**
 * The module «Интернет-магазин» (V3-23): `shop` — the goods with «В корзину», `cart` — the cart with the checkout,
 * `order` — the order of its buyer by the id of the address (/order/:id); each section is the heading of its page.
 */
export const SHOP_MODULE = "shop";
const SHOP_PAGE_KINDS: Readonly<Record<string, PageKind>> = { shop: "shop", cart: "cart", order: "order" };

/** A route with a parameter (an entry page): not a menu item, its SEO comes from the entry at runtime. */
export const isParamRoute = (route: string): boolean => route.includes(":");

/** A section of a page: a library pattern (or a signature section written as code) and its content. */
export interface SiteSection {
  /** Anchor on the page (unique per page). */
  id: string;
  type: SectionType | "signature";
  /** Library pattern id, or «signature». */
  pattern: string;
  props: Record<string, unknown>;
  /** Signature section: its file in ui/sections and what it shows (Russian). */
  file?: string;
  title?: string;
}

export interface SeoMeta {
  title: string;
  description: string;
  /** og:image — the first screen photo (same origin). */
  image?: string;
}

export interface SitePage {
  route: string;
  title: string;
  kind: PageKind;
  file: string;
  component: string;
  /** Label of the page in the menus. */
  nav: string;
  /** Shown in the header menu (utility pages live only in the footer). */
  header: boolean;
  roles: string[];
  module?: string;
  seo: SeoMeta;
  sections: SiteSection[];
}

export interface SiteModel {
  version: 1;
  /** Seed of the pattern choice (design seed + system). */
  seed: string;
  archetype: string;
  /** Where the main action of the site leads (the request form, the booking…); null — nowhere. */
  primary: SiteAction | null;
  pages: SitePage[];
}

/** Section order of a page kind; types without content or without a pattern are skipped. */
export const PAGE_SECTIONS: Readonly<Record<PageKind, readonly SectionType[]>> = {
  home: [
    "header",
    "hero",
    "shop",
    "services",
    "about",
    "gallery",
    "team",
    "testimonials",
    "pricing",
    "faq",
    "form",
    "cta",
    "contacts",
    "footer",
  ],
  catalog: ["header", "hero", "catalog", "pricing", "faq", "cta", "footer"],
  booking: ["header", "hero", "form", "faq", "contacts", "footer"],
  // V3-24: the list of articles shows the rubric section (with the rubric links) when the site has rubrics, else blog.
  content: ["header", "hero", "rubric", "blog", "cta", "footer"],
  account: ["header", "hero", "catalog", "footer"],
  credits: ["header", "hero", "gallery", "footer"],
  // V3-24: the entry and the rubric are the heading of their page (h1), no first screen above them.
  entry: ["header", "article", "cta", "footer"],
  rubric: ["header", "rubric", "cta", "footer"],
  // V3-23: the goods, the cart and the order are the heading of their page (h1); the shop's goods also show on home.
  shop: ["header", "shop", "faq", "contacts", "footer"],
  cart: ["header", "cart", "footer"],
  order: ["header", "order", "footer"],
};

/** Russian labels of section anchors in the menu of a one-page site. */
export const ANCHOR_LABELS: Partial<Record<SectionType, string>> = {
  services: "Услуги",
  about: "О нас",
  gallery: "Галерея",
  team: "Команда",
  testimonials: "Отзывы",
  pricing: "Цены",
  faq: "Вопросы",
  form: "Заявка",
  contacts: "Контакты",
};

/** The page a module screen gives (catalog D2). */
export function pageKind(screen: Pick<PublicScreen, "module" | "id" | "audience" | "route">): PageKind {
  if (screen.route === "/") return "home";
  if (screen.module === CONTENT_MODULE) {
    const c = CONTENT_SCREENS[screen.id];
    if (c?.kind === "entry") return "entry";
    if (c?.kind === "rubric") return "rubric";
    return "content";
  }
  if (screen.module === SHOP_MODULE && SHOP_PAGE_KINDS[screen.id])
    return SHOP_PAGE_KINDS[screen.id] as PageKind;
  if (screen.module === "landing" && screen.id === "credits") return "credits";
  if (screen.audience === "visitor") return "account";
  if (screen.module === "catalog") return "catalog";
  if (screen.module === "booking") return "booking";
  return "content";
}

/** PascalCase of a route: «/» → Home, «/services» → Services, «/me/orders» → MeOrders. */
export function componentOf(route: string): string {
  if (route === "/") return "Home";
  const name = route
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/^:/, "by-"))
    .join("-")
    .replace(/(^|[-_])([a-z0-9])/g, (_, _d, c: string) => c.toUpperCase());
  return /^[A-Z]/.test(name) ? name : `Page${name}`;
}

/** The headless hook binding of a section: what `needs` it asks of the pattern and the action it serves. */
export interface Binding {
  needs: Exclude<PatternNeeds, null>;
  action: PublicAction;
  /** Catalog: the sections entity the role may read (filters and the sections/tabs variants). */
  categoryEntity?: string;
  /** Booking: the package check before the write (a public function of the packages module). */
  packageCheckFn?: string;
}

const NEEDS_OF: Readonly<Record<PublicAction["hook"], Exclude<PatternNeeds, null>>> = {
  useLeadForm: "lead",
  useBooking: "booking",
  useCatalog: "catalog",
  useContent: "content",
  useShop: "cart",
};

/** Public function of the packages module the booking asks before writing (B2-18). */
const PACKAGE_CHECK_FN = "packageCheck";

/** Entities of the landing module that serve the owner's photos, not a public list. */
const NOT_LISTED = new Set(["site_photo"]);

/**
 * Sections of a page of «Контент и блог» (V3-24): the entity of its screen (CONTENT_SCREENS) — one entry, the posts of
 * a rubric, or a list; the list of articles is the rubric section when the site has rubrics.
 */
function contentBinding(screen: string | undefined, type: SectionType, front: PublicFront): Binding | null {
  const c = screen ? CONTENT_SCREENS[screen] : undefined;
  if (!c) return null;
  const of = (entity: string): Binding | null => {
    const a = front.actions.find(
      (x) => x.module === CONTENT_MODULE && x.entity === entity && x.hook === "useContent",
    );
    return a ? { needs: "content", action: a } : null;
  };
  const rubrics = of(CONTENT_NAMES.rubric) !== null;
  const articles = c.entity === CONTENT_NAMES.article;
  if (type === "article") return c.kind === "entry" ? of(c.entity) : null;
  if (type === "rubric")
    return rubrics && (c.kind === "rubric" || (c.kind === "list" && articles)) ? of(c.entity) : null;
  if (type === "blog") return c.kind === "list" && !(articles && rubrics) ? of(c.entity) : null;
  return null;
}

/** Which action a section of a page binds (form, catalog, blog, an entry of «Контент и блог»), if any. */
export function bindingOf(
  page: { kind: PageKind; module?: string; screen?: string },
  type: SectionType,
  front: PublicFront,
  pages: readonly { kind: PageKind }[],
): Binding | null {
  if (page.module === CONTENT_MODULE) return contentBinding(page.screen, type, front);
  const pick = (hook: PublicAction["hook"], module?: string) => {
    const a = front.actions.find(
      (x) => x.hook === hook && (!module || x.module === module) && !NOT_LISTED.has(x.entity),
    );
    if (!a) return null;
    const out: Binding = { needs: NEEDS_OF[a.hook], action: a };
    if (a.hook === "useCatalog" && front.actions.some((x) => x.entity === CATALOG_NAMES.category))
      out.categoryEntity = CATALOG_NAMES.category;
    if (a.hook === "useBooking" && front.functions.some((f) => f.name === PACKAGE_CHECK_FN))
      out.packageCheckFn = PACKAGE_CHECK_FN;
    return out;
  };
  if (type === "form") {
    if (page.kind === "booking") return pick("useBooking");
    if (page.kind === "home")
      return pick("useLeadForm") ?? (pages.some((p) => p.kind === "booking") ? null : pick("useBooking"));
    return null;
  }
  if (type === "catalog") {
    if (page.kind === "catalog") return pick("useCatalog", page.module) ?? pick("useCatalog");
    if (page.kind === "account") return pick("useContent", page.module);
    return null;
  }
  if (type === "blog" && page.kind === "content") return pick("useContent", page.module);
  // V3-23: the goods on their page and on home, the cart with the checkout, the order of its buyer.
  if (type === "shop" && (page.kind === "shop" || page.kind === "home")) return pick("useShop");
  if ((type === "cart" && page.kind === "cart") || (type === "order" && page.kind === "order"))
    return pick("useShop");
  return null;
}

/** A page of the sitemap before its sections are composed. */
export interface PlannedPage {
  route: string;
  title: string;
  kind: PageKind;
  module?: string;
  /** Screen id of the module (the content module binds its sections by it). */
  screen?: string;
  roles: string[];
}

/** Page kinds served on a route with a parameter. */
const PARAM_KINDS: ReadonlySet<PageKind> = new Set(["entry", "rubric", "order"]);

/**
 * Public pages of the system: the module screens left to v3 and the home page. A system without public screens and
 * public actions (a CRM) has no public site.
 */
export function plannedPages(spec: AppSpec, front: PublicFront): PlannedPage[] {
  if (front.screens.length === 0 && front.actions.length === 0) return [];
  const everyone = spec.roles.map((r) => r.name);
  const out: PlannedPage[] = [];
  const seen = new Set<string>();
  const screens = [...front.screens].sort((a, b) => (a.route === "/" ? -1 : b.route === "/" ? 1 : 0));
  if (!screens.some((s) => s.route === "/"))
    out.push({ route: "/", title: "Главная", kind: "home", roles: everyone });
  for (const s of screens) {
    const kind = pageKind(s);
    // Routes with a parameter are pages only for the entries of «Контент и блог» (V3-24) and the shop's order (V3-23).
    if (seen.has(s.route) || (isParamRoute(s.route) && !PARAM_KINDS.has(kind))) continue;
    seen.add(s.route);
    out.push({
      route: s.route,
      title: s.route === "/" ? "Главная" : s.title,
      kind,
      module: s.module,
      screen: s.id,
      roles: s.roles.length ? [...s.roles] : everyone,
    });
  }
  // Home first, then the pages of the screens in their order, the entry pages, utility pages (photo credits) last.
  return [
    ...out.filter((p) => p.kind === "home"),
    ...out.filter((p) => p.kind !== "home" && p.kind !== "credits" && !isParamRoute(p.route)),
    ...out.filter((p) => isParamRoute(p.route)),
    ...out.filter((p) => p.kind === "credits"),
  ];
}

/** The page plans of the contract (C6) from the site model. */
export function pagePlans(site: SiteModel, routes?: readonly string[]): V3PagePlan[] {
  return site.pages
    .filter((p) => !routes || routes.includes(p.route))
    .map((p) => ({
      route: p.route,
      title: p.title,
      file: p.file,
      roles: [...p.roles],
      sections: p.sections.map((s) => ({ id: s.id, pattern: s.pattern, props: s.props })),
    }));
}

/**
 * The spec with the composed pages (AppSpec.pages: route, title, file, roles) — the one way public pages of a v3 system
 * reach its spec: the harness (V3-11) applies it to the merged files before every commit, G0 and the preview
 * (`withSitePages(spec, readSite(files))`). The pages of the modules (staff cabinets) stay as compiled: a site page on
 * a route a module already serves is left out. Roles the spec does not know are dropped; a page left without one
 * gets the public roles (else the first role), so the spec stays valid.
 */
export function withSitePages(spec: AppSpec, site: SiteModel): AppSpec {
  const own = spec.pages ?? [];
  const taken = new Set(own.map((p) => p.route));
  const known = new Set(spec.roles.map((r) => r.name));
  const publicRoles = spec.roles.filter((r) => r.access === "public").map((r) => r.name);
  const fallback = publicRoles.length ? publicRoles : spec.roles.slice(0, 1).map((r) => r.name);
  const pages: Page[] = site.pages
    .filter((p) => !taken.has(p.route))
    .map((p) => {
      const roles = p.roles.filter((r) => known.has(r));
      return { route: p.route, title: p.title, file: p.file, roles: roles.length ? roles : fallback };
    });
  return { ...spec, pages: [...own, ...pages] };
}

/** Reads the site model of the system files (null when the skeleton has not run). */
export function readSite(files: ReadonlyMap<string, string>): SiteModel | null {
  const text = files.get(SITE_PATH);
  if (!text) return null;
  try {
    const v = JSON.parse(text) as SiteModel;
    return v && v.version === 1 && Array.isArray(v.pages) ? v : null;
  } catch {
    return null;
  }
}
