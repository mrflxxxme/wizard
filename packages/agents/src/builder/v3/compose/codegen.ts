// Files the composer writes into a v3 system: ui/design.css (the client's design system for Tailwind), the library
// patterns as ui/patterns/<id>.tsx (patternFiles), one page file per route under ui/pages/site that imports them,
// ui/seo.json for the build (title, description and og:image per route) and the site model ui/site.json.
import { type DesignSystemV3, designSystemCss } from "@wizard/ui-kit/v3/design";
import { type PatternMeta, patternById, patternFiles } from "@wizard/ui-kit/v3/patterns";
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

/** The page file: header, the sections inside <main> with their anchors, footer. */
export function pageSource(page: SitePage): string {
  const seen = new Set<string>();
  const imports: string[] = [];
  for (const s of page.sections) {
    const name = sectionComponent(s);
    if (seen.has(name)) continue;
    seen.add(name);
    imports.push(`import ${name} from ${json(importOf(s))};`);
  }
  const el = (s: SiteSection, indent: string) => `${indent}<${sectionComponent(s)} {...${json(s.props)}} />`;
  const header = page.sections.filter((s) => s.type === "header");
  const footer = page.sections.filter((s) => s.type === "footer");
  const body = page.sections.filter((s) => s.type !== "header" && s.type !== "footer");
  return [
    `// Page «${page.title}» (${page.route}) of the public site, written by the page composer v3 (V3-12).`,
    `// Sections: ${page.sections.map((s) => (s.pattern === "signature" ? `${s.id} (signature)` : s.pattern)).join(", ")}.`,
    ...imports,
    "",
    `export default function ${page.component}Page() {`,
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

/** ui/seo.json: the site name and per-route title, description and image. */
export function seoJson(site: SiteModel, siteName: string): string {
  const pages: Record<string, SitePage["seo"]> = {};
  for (const p of site.pages) pages[p.route] = p.seo;
  return `${JSON.stringify({ version: 1, site: siteName, pages }, null, 2)}\n`;
}

/**
 * Every file of the composed site; files of an earlier composition no page uses any more are deleted (null). Library
 * patterns are copied with patternFiles; `library` adds patterns outside the ui-kit registry (tests).
 */
export function siteFiles(
  site: SiteModel,
  siteName: string,
  design: DesignSystemV3,
  current: ReadonlyMap<string, string>,
  signatures: ReadonlyMap<string, string> = new Map(),
  library: readonly PatternMeta[] = [],
): Map<string, string | null> {
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
  for (const p of site.pages) out.set(p.file, pageSource(p));
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
