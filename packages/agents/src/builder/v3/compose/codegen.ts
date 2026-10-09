// Files the composer writes into a v3 system: ui/design.css (the client's design system for Tailwind), the library
// patterns as ui/patterns/<id>.tsx (patternFiles), one page file per route under ui/pages/site that imports them,
// ui/seo.json for the build (title, description and og:image per route) and the site model ui/site.json.
import { type DesignSystemV3, designSystemCss } from "@wizard/ui-kit/v3/design";
import { type PatternMeta, patternById, patternFiles } from "@wizard/ui-kit/v3/patterns";
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
 * ui/design.css: the design system variables with the visitor's colour scheme (prefers-color-scheme picks the other
 * palette — nothing sets data-scheme on a public page), fonts from /_wizard/fonts and the document base colours.
 */
export function designCss(ds: DesignSystemV3): string {
  return [
    designSystemCss(ds, { fonts: true }).replaceAll(":root[data-scheme=auto]", ":root"),
    "html{background-color:var(--color-background);color:var(--color-foreground);font-family:var(--font-sans);}",
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

/**
 * Attributes of a section's pictures the owner may replace (V3-18, «Фото сайта»): the place's photo of the owner,
 * else the stock picture of the props (useSitePhotos of the headless hooks).
 */
function photoAttrs(s: SiteSection, patternOf: (id: string) => PatternMeta | undefined): string {
  const places = s.type === "signature" ? undefined : fitPhotos(patternOf(s.pattern), s.photos, s.props);
  if (!places) return "";
  const out: string[] = [];
  if (places.image) {
    const stock = s.props.image === undefined ? "undefined" : json(s.props.image);
    out.push(`image={photo.one(${json(places.image)}, ${stock})}`);
  }
  if (places.images) out.push(`images={photo.list(${json(places.images)}, ${json(s.props.images)})}`);
  if (places.items) out.push(`items={photo.items(${json(s.props.items)}, ${json(places.items)})}`);
  return out.length ? ` ${out.join(" ")}` : "";
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
  const photos = [...attrs.values()].some((a) => a !== "");
  const el = (s: SiteSection, indent: string) =>
    `${indent}<${sectionComponent(s)} {...${json(s.props)}}${attrs.get(s) ?? ""} />`;
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
    "  useEffect(() => {",
    "    const id = location.hash.slice(1);",
    "    if (id) document.getElementById(id)?.scrollIntoView();",
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
  const site = siteRules(model, (id) => patternById(id) ?? library.find((p) => p.id === id));
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
