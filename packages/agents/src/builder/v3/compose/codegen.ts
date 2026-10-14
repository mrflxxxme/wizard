// Files the composer writes into a v3 system: ui/design.css (the client's design system for Tailwind), the library
// patterns as ui/patterns/<id>.tsx (patternFiles), one page file per route under ui/pages/site that imports them,
// ui/seo.json for the build (title, description and og:image per route) and the site model ui/site.json.
import { type DesignSystemV3, designSystemCss } from "@wizard/ui-kit/v3/design";
import { PATTERNS, type PatternMeta, patternById, patternFiles } from "@wizard/ui-kit/v3/patterns";
import { photoGrade, photoGradeCss } from "../../../stock/grade.js";
import { fitPhotos, siteRules } from "./content.js";
import {
  SECTIONS_DIR,
  SITE_PAGES_DIR,
  SITE_PATH,
  type SiteModel,
  type SitePage,
  type SiteSection,
} from "./site.js";

/** The design system file of a v3 system (the build switches Tailwind on by it). */
export const DESIGN_CSS = "ui/design.css";
/** Per-route SEO the build puts into index.html and applies on navigation (@wizard/build seo.ts). */
export const SEO_JSON = "ui/seo.json";

/**
 * ui/design.css: the design system variables in the scheme of the chosen direction — the visitor's OS theme does not
 * switch a public site to the other palette (D79) — fonts from /_wizard/fonts and the document base colours.
 */
export function designCss(ds: DesignSystemV3): string {
  return [
    designSystemCss(ds, { fonts: true, autoScheme: false }),
    "html{background-color:var(--color-background);color:var(--color-foreground);font-family:var(--font-sans);}",
    // V4-10: one grade for every library photo of the site (the direction's treatment and accent).
    photoGradeCss(
      photoGrade({ treatment: ds.imagery.treatment, accent: ds.palette[ds.palette.scheme].accent }),
    ),
    "",
  ].join("\n");
}

const pascal = (id: string) => id.replace(/(^|-)([a-z0-9])/g, (_, _d, c: string) => c.toUpperCase());

/** Component name of a section in its page file. */
export function sectionComponent(s: SiteSection): string {
  if (s.type === "signature" && s.file) return pascal(s.file.replace(/^.*\//, "").replace(/\.tsx$/, ""));
  return pascal(s.pattern);
}

/** Import path of a section from a page file in ui/pages/site. */
function importOf(s: SiteSection): string {
  if (s.type === "signature" && s.file)
    return `../../sections/${s.file.slice(SECTIONS_DIR.length + 1).replace(/\.tsx$/, "")}`;
  return `../../patterns/${s.pattern}`;
}

const json = (v: unknown) => JSON.stringify(v);

const isPhoto = (v: unknown): boolean =>
  typeof v === "object" && v !== null && typeof (v as { src?: unknown }).src === "string";
/** A photo given as its address alone (`image: "/_wizard/photos/…"`, the alt in `imageAlt`): the page-by-sections hero. */
const isPhotoPath = (v: unknown): v is string =>
  typeof v === "string" && /^\/(?:_wizard\/photos|api\/files)\//.test(v);

/**
 * V4-06: a section the model wrote as code keeps the places of the owner's photos («Фото сайта») of the section it
 * replaced (same id), so the page still passes the owner's picture into its props (codePhotos).
 */
export function keepPhotoPlaces(before: SitePage, after: SitePage): SitePage {
  const was = new Map(before.sections.map((s) => [s.id, s.photos]));
  let changed = false;
  const sections = after.sections.map((s) => {
    const photos = was.get(s.id);
    if (s.type !== "signature" || s.photos || !photos) return s;
    changed = true;
    return { ...s, photos };
  });
  return changed ? { ...after, sections } : after;
}

/** A prop name the page file can set as a JSX attribute. */
const ATTR_RE = /^[A-Za-z_$][\w$]*$/;

/** The prop of a code section a picture place fills: a usual name first (`names`), else the first prop that fits. */
function propOf(
  props: Record<string, unknown>,
  names: readonly string[],
  fits: (v: unknown) => boolean,
): string | undefined {
  const keys = Object.keys(props).filter((k) => ATTR_RE.test(k) && fits(props[k]));
  return names.find((k) => keys.includes(k)) ?? keys[0];
}

/** A picture attribute of a section in its page file: the prop it sets and the expression of its value. */
interface PhotoAttr {
  key: string;
  expr: string;
}

/** The one picture of a place: {src, alt} as it is, the address alone with its alt (`<key>Alt`, else `alt`). */
function oneAttr(props: Record<string, unknown>, key: string, place: string): PhotoAttr {
  const v = props[key];
  if (!isPhotoPath(v))
    return { key, expr: `photo.one(${json(place)}, ${v === undefined ? "undefined" : json(v)})` };
  // The address alone: the owner's photo's address, the stock one otherwise (its alt stays in its own prop).
  const alt = [props[`${key}Alt`], props.alt].find((x): x is string => typeof x === "string") ?? "";
  return { key, expr: `photo.one(${json(place)}, ${json({ src: v, alt })}).src` };
}

/**
 * Places of a section written as code (V4-06): those of the section it replaced, set on the props that carry its
 * pictures whatever their name — the models write `photo` (+ `photoAlt`) as often as `image` (acceptance 14.10:
 * DeepSeek's hero `photo` kept its place, but the page never passed the owner's upload, GS-landing-2): one picture
 * {src, alt} or its address alone, a list [{src, alt}], `items` [{image}].
 */
function codePhotoAttrs(s: SiteSection): PhotoAttr[] {
  const p = s.photos;
  if (!p) return [];
  const out: PhotoAttr[] = [];
  const one = propOf(s.props, ["image", "photo"], (v) => isPhoto(v) || isPhotoPath(v));
  if (p.image && one) out.push(oneAttr(s.props, one, p.image));
  const list = propOf(
    s.props,
    ["images", "photos"],
    (v) => Array.isArray(v) && v.length > 0 && v.every(isPhoto),
  );
  if (p.images && list)
    out.push({ key: list, expr: `photo.list(${json(p.images)}, ${json(s.props[list])})` });
  if (
    p.items &&
    Array.isArray(s.props.items) &&
    s.props.items.some((i) => isPhoto((i as { image?: unknown } | null)?.image))
  )
    out.push({ key: "items", expr: `photo.items(${json(s.props.items)}, ${json(p.items)})` });
  return out;
}

/**
 * Attributes of a section's pictures the owner may replace (V3-18, «Фото сайта»): the place's photo of the owner,
 * else the stock picture of the props (useSitePhotos of the headless hooks).
 */
function photoAttrs(s: SiteSection, patternOf: (id: string) => PatternMeta | undefined): PhotoAttr[] {
  if (s.type === "signature") return codePhotoAttrs(s);
  const places = fitPhotos(patternOf(s.pattern), s.photos, s.props);
  if (!places) return [];
  const out: PhotoAttr[] = [];
  if (places.image) out.push(oneAttr(s.props, "image", places.image));
  if (places.images)
    out.push({ key: "images", expr: `photo.list(${json(places.images)}, ${json(s.props.images)})` });
  if (places.items)
    out.push({ key: "items", expr: `photo.items(${json(s.props.items)}, ${json(places.items)})` });
  return out;
}

/** The page file: header, the sections inside <main> with their anchors, footer. */
export function pageSource(
  page: SitePage,
  patternOf: (id: string) => PatternMeta | undefined = patternById,
): string {
  const seen = new Set<string>();
  const imports: string[] = [];
  for (const s of page.sections) {
    const name = sectionComponent(s);
    if (seen.has(name)) continue;
    seen.add(name);
    imports.push(`import ${name} from ${json(importOf(s))};`);
  }
  const attrs = new Map(page.sections.map((s) => [s, photoAttrs(s, patternOf)]));
  const photos = [...attrs.values()].some((a) => a.length > 0);
  // V4-24: the props a photo attribute sets (image, images, items, a code section's photo…) are not spread too — the
  // attribute wins anyway, and a second copy of the same photo address made the instant edit ambiguous (two literals,
  // one picture shown).
  const spread = (s: SiteSection) => {
    const set = new Set((attrs.get(s) ?? []).map((a) => a.key));
    return set.size ? Object.fromEntries(Object.entries(s.props).filter(([k]) => !set.has(k))) : s.props;
  };
  const el = (s: SiteSection, indent: string) =>
    `${indent}<${sectionComponent(s)} {...${json(spread(s))}}${(attrs.get(s) ?? []).map((a) => ` ${a.key}={${a.expr}}`).join("")} />`;
  const header = page.sections.filter((s) => s.type === "header");
  const footer = page.sections.filter((s) => s.type === "footer");
  const body = page.sections.filter((s) => s.type !== "header" && s.type !== "footer");
  return [
    `// Page «${page.title}» (${page.route}) of the public site, written by the page composer v3 (V3-12).`,
    `// Sections: ${page.sections.map((s) => (s.pattern === "signature" ? `${s.id} (signature)` : s.pattern)).join(", ")}.`,
    'import { useEffect } from "react";',
    ...(photos ? ['import { useSitePhotos } from "@wizard/ui-kit/v3/headless";'] : []),
    ...imports,
    "",
    `export default function ${page.component}Page() {`,
    // The owner's photos of the site («Фото сайта» of the cabinet) replace the stock ones of their places.
    ...(photos ? ["  const photo = useSitePhotos();"] : []),
    // The page renders after the load (the app waits for its spec), so the browser does not scroll to the anchor of
    // the address itself: a link «/#form» from another page opens at the form (GS-catalog-4, the first screen's action).
    // V3-18: sections above the anchor load their data after the first paint (the previews of home) — the page keeps
    // the anchor in view while they grow, until the visitor scrolls himself or 3 s pass.
    "  useEffect(() => {",
    "    const id = location.hash.slice(1);",
    "    const target = id ? document.getElementById(id) : null;",
    "    if (!target) return;",
    "    target.scrollIntoView();",
    "    const keep = new ResizeObserver(() => target.scrollIntoView());",
    "    keep.observe(document.body);",
    "    const stop = () => keep.disconnect();",
    "    const timer = setTimeout(stop, 3000);",
    '    for (const e of ["wheel", "touchstart", "keydown"]) addEventListener(e, stop, { once: true, passive: true });',
    "    return () => {",
    "      clearTimeout(timer);",
    "      stop();",
    '      for (const e of ["wheel", "touchstart", "keydown"]) removeEventListener(e, stop);',
    "    };",
    "  }, []);",
    "  return (",
    "    <>",
    ...header.map((s) => el(s, "      ")),
    '      <main id="main">',
    ...body.map((s) => `        <div id=${json(s.id)}>\n${el(s, "          ")}\n        </div>`),
    "      </main>",
    ...footer.map((s) => el(s, "      ")),
    "    </>",
    "  );",
    "}",
    "",
  ].join("\n");
}

/**
 * A source of entry pages for the runtime (V3-24): the route with :slug, the entity the public role reads and the
 * fields of its title, description and image — /sitemap.xml lists the published entries, the head of an entry page
 * carries its own title, description and Open Graph for crawlers.
 */
export interface SeoContentSource {
  route: string;
  entity: string;
  slug: string;
  title: string;
  /** Fields of the description, the first one filled wins. */
  description: string[];
  seoTitle?: string;
  image?: string;
}

type EntryFields = Partial<
  Record<"title" | "slug" | "excerpt" | "cover" | "seoTitle" | "seoDescription", string>
>;

/** The entry sources of the site: pages of one entry (article-*) and of a rubric (rubric-*). */
export function seoContent(site: SiteModel): SeoContentSource[] {
  const out: SeoContentSource[] = [];
  for (const p of site.pages) {
    if (!p.route.endsWith("/:slug")) continue;
    const article = p.sections.find((s) => s.type === "article");
    const rubric = p.sections.find((s) => s.type === "rubric");
    if (article) {
      const props = article.props as { entity?: string; fields?: EntryFields };
      const f = props.fields ?? {};
      out.push({
        route: p.route,
        entity: props.entity ?? "article",
        slug: f.slug ?? "slug",
        title: f.title ?? "title",
        description: [f.seoDescription ?? "seo_description", f.excerpt ?? "excerpt"],
        seoTitle: f.seoTitle ?? "seo_title",
        image: f.cover ?? "cover",
      });
    } else if (rubric) {
      const r = (
        rubric.props as { rubrics?: { entity?: string; name?: string; slug?: string; description?: string } }
      ).rubrics;
      out.push({
        route: p.route,
        entity: r?.entity ?? "rubric",
        slug: r?.slug ?? "slug",
        title: r?.name ?? "name",
        description: [r?.description ?? "description"],
      });
    }
  }
  return out;
}

/** ui/seo.json: the site name, per-route title, description and image, and the entry sources (V3-24). */
export function seoJson(site: SiteModel, siteName: string): string {
  const pages: Record<string, SitePage["seo"]> = {};
  for (const p of site.pages) pages[p.route] = p.seo;
  const content = seoContent(site);
  return `${JSON.stringify({ version: 1, site: siteName, pages, ...(content.length ? { content } : {}) }, null, 2)}\n`;
}

/**
 * Every file of the composed site; files of an earlier composition no page uses any more are deleted (null). Library
 * patterns are copied with patternFiles; `library` adds patterns outside the ui-kit registry (tests). The site's
 * action rules (siteRules) apply first, whatever step changed the model — the skeleton, a model's page, the critic.
 */
export function siteFiles(
  model: SiteModel,
  siteName: string,
  design: DesignSystemV3,
  current: ReadonlyMap<string, string>,
  signatures: ReadonlyMap<string, string> = new Map(),
  library: readonly PatternMeta[] = [],
): Map<string, string | null> {
  const site = siteRules(model, (id) => patternById(id) ?? library.find((p) => p.id === id), [
    ...PATTERNS,
    ...library,
  ]);
  const out = new Map<string, string | null>();
  out.set(DESIGN_CSS, designCss(design));
  const ids = [
    ...new Set(
      site.pages.flatMap((p) => p.sections.filter((s) => s.type !== "signature").map((s) => s.pattern)),
    ),
  ];
  for (const [path, src] of patternFiles(ids.filter((id) => patternById(id)))) out.set(path, src);
  for (const id of ids) {
    const extra = patternById(id) ? undefined : library.find((p) => p.id === id);
    if (extra) out.set(extra.file, extra.source);
  }
  for (const p of site.pages)
    out.set(
      p.file,
      pageSource(p, (id) => patternById(id) ?? library.find((x) => x.id === id)),
    );
  const sectionFiles = new Set(
    site.pages.flatMap((p) => p.sections.flatMap((s) => (s.file ? [s.file] : []))),
  );
  for (const f of sectionFiles) {
    const src = signatures.get(f) ?? current.get(f);
    if (src !== undefined) out.set(f, src);
  }
  out.set(SEO_JSON, seoJson(site, siteName));
  out.set(SITE_PATH, `${JSON.stringify(site, null, 2)}\n`);
  for (const path of current.keys()) {
    const owned =
      path.startsWith("ui/patterns/") ||
      path.startsWith(`${SITE_PAGES_DIR}/`) ||
      path.startsWith(`${SECTIONS_DIR}/`);
    if (owned && !out.has(path)) out.set(path, null);
  }
  return out;
}
