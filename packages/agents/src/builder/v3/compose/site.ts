// The site model of the page composer (V3-12): which public pages the system has and in what order their sections go.
// Pages come from the public front of the backend-mode modules (V3-10: screens left to v3, data actions served by the
// headless hooks) plus the home page; the order of sections follows the page kind (catalog D2: the site with requests
// and the booking flow). The model is stored in the system as ui/site.json, so a scenario step continues the skeleton.
import type { AppSpec, Page } from "@wizard/appspec";
import type { PublicAction, PublicFront, PublicScreen } from "@wizard/modules";
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

export type PageKind = "home" | "catalog" | "booking" | "content" | "account" | "credits";

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
  content: ["header", "hero", "blog", "cta", "footer"],
  account: ["header", "hero", "catalog", "footer"],
  credits: ["header", "hero", "gallery", "footer"],
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
}

const NEEDS_OF: Readonly<Record<PublicAction["hook"], Exclude<PatternNeeds, null>>> = {
  useLeadForm: "lead",
  useBooking: "booking",
  useCatalog: "catalog",
  useContent: "content",
};

/** Entities of the landing module that serve the owner's photos, not a public list. */
const NOT_LISTED = new Set(["site_photo"]);

/** Which action a section of a page binds (form, catalog, blog), if any. */
export function bindingOf(
  page: { kind: PageKind; module?: string },
  type: SectionType,
  front: PublicFront,
  pages: readonly { kind: PageKind }[],
): Binding | null {
  const pick = (hook: PublicAction["hook"], module?: string) => {
    const a = front.actions.find(
      (x) => x.hook === hook && (!module || x.module === module) && !NOT_LISTED.has(x.entity),
    );
    return a ? { needs: NEEDS_OF[a.hook], action: a } : null;
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
  return null;
}

/** A page of the sitemap before its sections are composed. */
export interface PlannedPage {
  route: string;
  title: string;
  kind: PageKind;
  module?: string;
  roles: string[];
}

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
    if (seen.has(s.route) || /:/.test(s.route)) continue;
    seen.add(s.route);
    out.push({
      route: s.route,
      title: s.route === "/" ? "Главная" : s.title,
      kind: pageKind(s),
      module: s.module,
      roles: s.roles.length ? [...s.roles] : everyone,
    });
  }
  // Home first, then the pages of the screens in their order, utility pages (photo credits) last.
  return [
    ...out.filter((p) => p.kind === "home"),
    ...out.filter((p) => p.kind !== "home" && p.kind !== "credits"),
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
      sections: p.sections.map((s) => ({ id: s.id, pattern: s.pattern, props: s.props })),
    }));
}

/**
 * The spec with the composed pages (AppSpec.pages: route, title, file, roles): an existing page of the same route is
 * replaced, cabinets of the modules stay. The harness (V3-11) applies it with the composer's files.
 */
export function withSitePages(spec: AppSpec, site: SiteModel): AppSpec {
  const routes = new Set(site.pages.map((p) => p.route));
  const known = new Set(spec.roles.map((r) => r.name));
  const pages: Page[] = site.pages.map((p) => ({
    route: p.route,
    title: p.title,
    file: p.file,
    roles: p.roles.filter((r) => known.has(r)),
  }));
  return { ...spec, pages: [...(spec.pages ?? []).filter((p) => !routes.has(p.route)), ...pages] };
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
