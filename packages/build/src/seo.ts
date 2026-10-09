// SEO of the public pages of v3 systems (V3-12): ui/seo.json, written by the page composer, gives the site name and per
// route the title, the description and the og:image (a same-origin photo). The runtime serves one index.html for every
// route (SPA fallback), so the document carries the home page's tags — what crawlers and link previews read — and the
// client entry sets the tags of the current route on start and on every navigation. A system without ui/seo.json
// builds exactly as before.

/** The file of the per-route SEO in a system. */
export const SEO_PATH = "ui/seo.json";

export interface SeoPage {
  title: string;
  description: string;
  /** Same-origin path of the page's first screen photo (og:image). */
  image?: string;
}

export interface SiteSeo {
  /** Name of the site: the title of pages without their own SEO. */
  site: string;
  /** Route of AppSpec.pages → its tags. */
  pages: Record<string, SeoPage>;
}

const ROUTE_RE = /^\/[a-z0-9/:_-]*$/;
const SAME_ORIGIN_RE = /^\/(?!\/)[^\s"'<>]*$/;
const LIMITS = { site: 120, title: 120, description: 300, routes: 80 } as const;

const str = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\n\r]/.test(v);

/** Parses and checks ui/seo.json: an error (Russian) names the first wrong place. */
export function parseSeo(text: string): { ok: true; seo: SiteSeo } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `не JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "ожидается объект" };
  const o = raw as Record<string, unknown>;
  if (!str(o.site, LIMITS.site)) return { ok: false, error: `site — строка до ${LIMITS.site} знаков` };
  if (!o.pages || typeof o.pages !== "object" || Array.isArray(o.pages))
    return { ok: false, error: "pages — объект «маршрут → теги»" };
  const entries = Object.entries(o.pages as Record<string, unknown>);
  if (entries.length > LIMITS.routes) return { ok: false, error: `не больше ${LIMITS.routes} страниц` };
  const pages: Record<string, SeoPage> = {};
  for (const [route, v] of entries) {
    if (!ROUTE_RE.test(route)) return { ok: false, error: `маршрут «${route.slice(0, 80)}» некорректен` };
    const p = (v ?? {}) as Record<string, unknown>;
    if (!str(p.title, LIMITS.title))
      return { ok: false, error: `${route}: title — строка до ${LIMITS.title} знаков` };
    if (!str(p.description, LIMITS.description))
      return { ok: false, error: `${route}: description — строка до ${LIMITS.description} знаков` };
    if (p.image !== undefined && !(typeof p.image === "string" && SAME_ORIGIN_RE.test(p.image)))
      return { ok: false, error: `${route}: image — путь на домене системы (/…)` };
    pages[route] = {
      title: p.title,
      description: p.description,
      ...(typeof p.image === "string" ? { image: p.image } : {}),
    };
  }
  return { ok: true, seo: { site: o.site, pages } };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** The document title of a route. */
export function seoTitle(seo: SiteSeo, route = "/"): string {
  return seo.pages[route]?.title ?? seo.site;
}

/** <meta> tags of a route for <head>: description and Open Graph (og:image only with a photo). */
export function seoHeadTags(seo: SiteSeo, route = "/"): string[] {
  const p = seo.pages[route];
  const meta = (attr: "name" | "property", key: string, value: string) =>
    `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  return [
    ...(p ? [meta("name", "description", p.description)] : []),
    meta("property", "og:type", "website"),
    meta("property", "og:locale", "ru_RU"),
    meta("property", "og:site_name", seo.site),
    meta("property", "og:title", p?.title ?? seo.site),
    ...(p ? [meta("property", "og:description", p.description)] : []),
    ...(p?.image ? [meta("property", "og:image", p.image)] : []),
  ];
}

/**
 * Code of the client entry: `__wzSeo(route)` sets the title and the tags of a matched route (null — the site name
 * only). The App calls it in an effect on the path.
 */
export function seoClientCode(seo: SiteSeo): string {
  return [
    `const __wzSeoData = ${JSON.stringify(seo)};`,
    "function __wzSeo(route) {",
    "  const p = (route && __wzSeoData.pages[route]) || null;",
    "  document.title = p ? p.title : __wzSeoData.site;",
    "  const set = (attr, key, value) => {",
    '    let el = [...document.head.querySelectorAll("meta")].find((m) => m.getAttribute(attr) === key);',
    "    if (value == null) { if (el) el.remove(); return; }",
    '    if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); document.head.append(el); }',
    '    el.setAttribute("content", value);',
    "  };",
    '  set("name", "description", p ? p.description : null);',
    '  set("property", "og:title", p ? p.title : __wzSeoData.site);',
    '  set("property", "og:description", p ? p.description : null);',
    '  set("property", "og:image", p && p.image ? new URL(p.image, location.origin).href : null);',
    "}",
  ].join("\n");
}
