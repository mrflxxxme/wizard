// The preview skeleton of the public site (V3-12, D77 (10): preview ≤ 5 min, no model): pages from the public front,
// sections in the order of the page kind, a library pattern for each (patternFor's selection with the seed and the
// patterns already on the site, so variants and layout families spread over the page and the site; the slot schema of
// the variant must accept the content), texts from the facts, one header and one footer for the whole site with the
// page list, SEO per page.
import {
  PATTERNS,
  type PatternMeta,
  type PatternNeeds,
  type SectionType,
  selectPattern,
} from "@wizard/ui-kit/v3/patterns";
import type { V3BuildContext } from "../contract.js";
import {
  KIND_LABELS,
  primaryAction,
  type SectionContext,
  type SiteAction,
  secondaryAction,
  sectionProps,
  seoOf,
} from "./content.js";
import { type SiteFacts, siteFacts } from "./facts.js";
import { lintErrors, lintPage } from "./lint.js";
import {
  type Binding,
  bindingOf,
  componentOf,
  PAGE_SECTIONS,
  type PlannedPage,
  plannedPages,
  SITE_PAGES_DIR,
  type SiteModel,
  type SitePage,
  type SiteSection,
} from "./site.js";

export interface ComposeLibrary {
  /** Patterns to choose from (default: the ui-kit library). */
  patterns?: readonly PatternMeta[];
}

/** Content a variant should show when it is there: photos, the footer's list of pages (utility pages live only there). */
const KEEP = [["image", "images"], ["columns"]] as const;

/**
 * Picks the pattern of a section: its type and needs, the slots accept `props`, variants that keep the photos and the
 * page list first, not the layout of the section before; then patternFor's seeded selection with variety.
 */
export function choosePattern(
  library: readonly PatternMeta[],
  q: {
    type: SectionType;
    needs: PatternNeeds;
    props: Record<string, unknown>;
    archetype: string;
    seed: string;
    used: readonly string[];
    prevLayout?: string;
  },
): PatternMeta | null {
  const fits = library.filter(
    (p) => p.sectionType === q.type && p.needs === q.needs && p.slots.safeParse(q.props).success,
  );
  if (fits.length === 0) return null;
  // Photos of the owner and the footer's page list are not dropped when some variant shows them.
  const keep = KEEP.filter((group) => group.some((k) => q.props[k] !== undefined));
  const keeping = fits.filter((p) => {
    const out = p.slots.parse(q.props) as Record<string, unknown>;
    return keep.every((group) => group.some((k) => out[k] !== undefined));
  });
  const shown = keeping.length ? keeping : fits;
  const fresh = shown.filter((p) => p.layout !== q.prevLayout);
  const pool = fresh.length ? fresh : shown;
  // Other types stay in the list: patternFor's selection counts the layout families of every pattern already used.
  return selectPattern([...library.filter((p) => p.sectionType !== q.type), ...pool], {
    sectionType: q.type,
    archetype: q.archetype,
    seed: q.seed,
    used: q.used,
  });
}

/** The props a pattern keeps of the content (its slot schema strips what the variant does not show). */
const slotProps = (p: PatternMeta, props: Record<string, unknown>) =>
  p.slots.parse(props) as Record<string, unknown>;

export interface SkeletonResult {
  site: SiteModel;
  facts: SiteFacts;
  notes: string[];
  /** Sections left out: no pattern of the type (or none accepts the content). */
  missing: { route: string; type: SectionType; needs: PatternNeeds }[];
}

/** Composes the site model of a build context (deterministic: the same context gives the same site). */
export function composeSite(ctx: V3BuildContext, lib: ComposeLibrary = {}): SkeletonResult {
  const library = lib.patterns ?? PATTERNS;
  const facts = siteFacts(ctx);
  const planned = plannedPages(ctx.spec, ctx.publicFront);
  const seed = `${ctx.design.seed}:${ctx.systemId}`;
  const archetype = ctx.design.archetype;
  const site: SiteModel = { version: 1, seed, archetype, primary: null, pages: [] };
  const notes: string[] = [];
  const missing: SkeletonResult["missing"] = [];
  if (planned.length === 0) {
    notes.push("Публичных страниц в системе нет: сайт не нужен, работают кабинеты.");
    return { site, facts, notes, missing };
  }
  const used: string[] = [];

  // A. Sections bound to the headless hooks (form, catalog, blog): they decide where the main action leads.
  const bound = new Map<string, { binding: Binding; section: SiteSection; layout: string }>();
  for (const page of planned)
    for (const type of PAGE_SECTIONS[page.kind]) {
      const binding = bindingOf(page, type, ctx.publicFront, planned);
      if (!binding) continue;
      const c = context(facts, page, planned, null, null, binding, []);
      const props = sectionProps(type, c);
      if (!props) continue;
      const p = choosePattern(library, { type, needs: binding.needs, props, archetype, seed, used });
      if (!p) {
        missing.push({ route: page.route, type, needs: binding.needs });
        continue;
      }
      used.push(p.id);
      bound.set(`${page.route}#${type}`, {
        binding,
        section: { id: type, type, pattern: p.id, props: slotProps(p, props) },
        layout: p.layout,
      });
    }
  const homeForm = bound.get("/#form")?.binding ?? null;
  const booking = planned.find((p) => p.kind === "booking");
  const primary = primaryAction(facts, planned, homeForm, !!booking && bound.has(`${booking.route}#form`));
  const secondary = secondaryAction(primary, planned);
  site.primary = primary;

  // B. Body sections of every page in the order of its kind.
  const bodies = new Map<string, { sections: SiteSection[]; layouts: string[] }>();
  for (const page of planned) {
    const sections: SiteSection[] = [];
    const layouts: string[] = [];
    for (const type of PAGE_SECTIONS[page.kind]) {
      if (type === "header" || type === "footer") continue;
      const b = bound.get(`${page.route}#${type}`);
      if (b) {
        sections.push(b.section);
        layouts.push(b.layout);
        continue;
      }
      if (bindingOf(page, type, ctx.publicFront, planned)) continue;
      const c = context(facts, page, planned, primary, secondary, null, []);
      const props = sectionProps(type, c);
      if (!props) continue;
      const p = choosePattern(library, {
        type,
        needs: null,
        props,
        archetype,
        seed,
        used,
        ...(layouts.length ? { prevLayout: layouts[layouts.length - 1] } : {}),
      });
      if (!p) {
        missing.push({ route: page.route, type, needs: null });
        continue;
      }
      used.push(p.id);
      sections.push({ id: type, type, pattern: p.id, props: slotProps(p, props) });
      layouts.push(p.layout);
    }
    bodies.set(page.route, { sections, layouts });
  }

  // C. One header and one footer for the site: the pattern is chosen on the home page, the menu links per page.
  const homeSections = (bodies.get("/")?.sections ?? []).map((s) => ({
    id: s.id,
    type: s.type as SectionType,
  }));
  const chrome = (type: "header" | "footer", page: PlannedPage) =>
    sectionProps(type, context(facts, page, planned, primary, secondary, null, homeSections));
  const first = planned[0] as PlannedPage;
  const pick = (type: "header" | "footer") => {
    const props = chrome(type, first);
    return props ? choosePattern(library, { type, needs: null, props, archetype, seed, used }) : null;
  };
  const header = pick("header");
  if (header) used.push(header.id);
  const footer = pick("footer");
  if (footer) used.push(footer.id);
  for (const t of ["header", "footer"] as const)
    if (!(t === "header" ? header : footer)) missing.push({ route: "/", type: t, needs: null });

  const names = new Set<string>();
  for (const page of planned) {
    const body = bodies.get(page.route)?.sections ?? [];
    const sections: SiteSection[] = [];
    const headerProps = header ? chrome("header", page) : null;
    if (header && headerProps)
      sections.push({
        id: "header",
        type: "header",
        pattern: header.id,
        props: slotProps(header, headerProps),
      });
    sections.push(...body);
    const footerProps = footer ? chrome("footer", page) : null;
    if (footer && footerProps)
      sections.push({
        id: "footer",
        type: "footer",
        pattern: footer.id,
        props: slotProps(footer, footerProps),
      });
    let component = componentOf(page.route);
    while (names.has(component)) component = `${component}2`;
    names.add(component);
    const hero = body.find((s) => s.type === "hero")?.props ?? null;
    const sitePage: SitePage = {
      route: page.route,
      title: page.title,
      kind: page.kind,
      file: `${SITE_PAGES_DIR}/${component}.tsx`,
      component,
      nav: page.kind === "home" ? "Главная" : page.title,
      header: page.kind !== "credits" && page.kind !== "account",
      roles: page.roles,
      ...(page.module ? { module: page.module } : {}),
      seo: seoOf(facts, page, hero),
      sections,
    };
    site.pages.push(sitePage);
  }

  for (const m of missing)
    notes.push(
      `Для секции «${m.type}»${m.needs ? ` (${m.needs})` : ""} на странице ${m.route} в библиотеке пока нет подходящего паттерна — секция пропущена.`,
    );
  const kinds = site.pages.map((p) => `${KIND_LABELS[p.kind]} (${p.route})`).join(", ");
  notes.unshift(
    `Собрал каркас сайта в стиле «${ctx.design.name}»: ${site.pages.length} стр. — ${kinds}. Тексты — из брифа, без выдуманных фактов.`,
  );
  for (const page of site.pages) {
    const errors = lintErrors(lintSitePage(site, page, facts, library));
    if (errors.length)
      notes.push(
        `Проверка страницы ${page.route}: ${errors
          .slice(0, 3)
          .map((e) => e.message_ru)
          .join("; ")}`,
      );
  }
  return { site, facts, notes, missing };
}

function context(
  facts: SiteFacts,
  page: PlannedPage,
  pages: readonly PlannedPage[],
  primary: SiteAction | null,
  secondary: SiteAction | null,
  binding: Binding | null,
  homeSections: SectionContext["homeSections"],
): SectionContext {
  return { facts, page, pages, primary, secondary, binding, homeSections };
}

/** Lint of a composed page: library sources by id, signature sections by their file. */
export function lintSitePage(
  site: SiteModel,
  page: SitePage,
  facts: SiteFacts,
  library: readonly PatternMeta[] = PATTERNS,
  signatures: ReadonlyMap<string, string> = new Map(),
) {
  const home = site.pages.find((p) => p.route === "/");
  return lintPage({
    sections: page.sections.map((s) => {
      const meta = library.find((p) => p.id === s.pattern);
      return {
        id: s.id,
        type: s.type,
        pattern: s.pattern,
        ...(meta ? { layout: meta.layout } : {}),
        source: meta?.source ?? (s.file ? (signatures.get(s.file) ?? "") : ""),
        props: s.props,
      };
    }),
    numbers: facts.numbers,
    routes: site.pages.map((p) => p.route),
    homeAnchors: home?.sections.map((s) => s.id) ?? [],
  });
}
