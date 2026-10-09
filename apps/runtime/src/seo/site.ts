// Search engines on a system's public pages (V3-24 «Многостраничные сайты»; product.yaml#decisions.D77_v3 (12)): the
// runtime serves one index.html for every route (SPA), so what a crawler or a link preview reads is set here, on the
// server — /sitemap.xml with the public pages and the published entries of «Контент и блог», /robots.txt, and the head
// of each page: its title, description, Open Graph and canonical address from ui/seo.json of the bundle
// (client/assets/seo.json, @wizard/build SEO_ASSET) and, on an entry page (/blog/:slug), from the entry itself — read
// as the public role, so a draft is «not found» with noindex, never a title in a search result. A draft host is noindex as a
// whole (robots.txt disallows everything, X-Robots-Tag on every answer of this module).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { Hono } from "hono";
import type { Doc } from "../data/access.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { documentHeaders, escapeHtml, NO_CACHE } from "../preview/headers.js";
import type { LoadedSystem } from "../system.js";

/** ui/seo.json in the bundle (@wizard/build SEO_ASSET under client/). */
export const SEO_FILE = "client/assets/seo.json";
/** At most this many entries of one source in the sitemap (pages of 100 rows). */
export const SITEMAP_MAX_ENTRIES = 1000;

export interface SeoPage {
  title: string;
  description: string;
  image?: string;
}

/** Entry pages of a route with :slug: the entity the public role reads and the fields of the head. */
export interface ContentSource {
  route: string;
  /** The route without :slug («/blog/»). */
  prefix: string;
  entity: string;
  slug: string;
  title: string;
  description: string[];
  seoTitle?: string;
  image?: string;
}

export interface SystemSeo {
  /** Site name (ui/seo.json), else the app's name. */
  site: string;
  pages: Readonly<Record<string, SeoPage>>;
  content: readonly ContentSource[];
}

const ROUTE_RE = /^\/[a-z0-9/:_-]*$/;
const ENTRY_ROUTE_RE = /^(\/(?:[a-z0-9_-]+\/)+):slug$/;
const SAME_ORIGIN_RE = /^\/(?!\/)[^\s"'<>]*$/;
const IDENT_RE = /^[a-z][a-z0-9_]{0,39}$/;
const ONE_LINE = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\r\n]/.test(v);

/** An entry source checked against the spec: the route ends with /:slug, the entity and its fields exist. */
function checkedSource(spec: AppSpec, s: Readonly<Record<string, unknown>>): ContentSource | null {
  const route = typeof s.route === "string" ? s.route : "";
  const prefix = ENTRY_ROUTE_RE.exec(route)?.[1];
  const entity = spec.entities.find((e) => e.name === s.entity);
  if (!prefix || !entity) return null;
  const field = (name: unknown, types?: readonly string[]) =>
    typeof name === "string" &&
    IDENT_RE.test(name) &&
    entity.fields.some((f) => f.name === name && (!types || types.includes(f.type)))
      ? name
      : undefined;
  const slug = field(s.slug ?? "slug", ["string"]);
  const title = field(s.title ?? "title", ["string", "text"]);
  if (!slug || !title) return null;
  const description = (Array.isArray(s.description) ? s.description : [])
    .map((d) => field(d, ["string", "text"]))
    .filter((d): d is string => d !== undefined);
  const seoTitle = field(s.seoTitle, ["string"]);
  const image = field(s.image, ["image"]);
  return {
    route,
    prefix,
    entity: entity.name,
    slug,
    title,
    description,
    ...(seoTitle ? { seoTitle } : {}),
    ...(image ? { image } : {}),
  };
}

const pascal = (s: string) => s.replace(/(^|_)([a-z0-9])/g, (_, _u, c: string) => c.toUpperCase());

/**
 * Entry sources of a system without ui/seo.json sources (the v2 front): every public page /…/:slug shows the entity
 * the public role reads by a unique `slug` — the one its page file is named after (ContentArticle.tsx → article),
 * else the one named like the segment before :slug, else the only such entity; title — `title` or `name`.
 */
export function inferContentSources(spec: AppSpec): ContentSource[] {
  const role = spec.roles.find((r) => r.access === "public")?.name;
  if (!role) return [];
  const readable = spec.entities.filter(
    (e) =>
      spec.permissions.some((p) => p.role === role && p.entity === e.name && p.ops.includes("read")) &&
      e.fields.some((f) => f.name === "slug" && f.type === "string"),
  );
  const out: ContentSource[] = [];
  for (const p of spec.pages ?? []) {
    if (!p.roles.includes(role) || !ENTRY_ROUTE_RE.test(p.route)) continue;
    const base = p.file.replace(/^.*\//, "").replace(/\.tsx$/, "");
    const segment = p.route.split("/").at(-2) ?? "";
    const entity =
      readable.find((e) => base.endsWith(pascal(e.name))) ??
      readable.find((e) => e.name === segment || `${e.name}s` === segment) ??
      (readable.length === 1 ? readable[0] : undefined);
    if (!entity) continue;
    const has = (f: string) => entity.fields.some((x) => x.name === f);
    const image = entity.fields.find((f) => f.type === "image")?.name;
    const source = checkedSource(spec, {
      route: p.route,
      entity: entity.name,
      slug: "slug",
      title: has("title") ? "title" : "name",
      description: ["seo_description", "excerpt", "description"].filter(has),
      ...(has("seo_title") ? { seoTitle: "seo_title" } : {}),
      ...(image ? { image } : {}),
    });
    if (source && !out.some((x) => x.route === source.route)) out.push(source);
  }
  return out;
}

/**
 * ui/seo.json checked against the spec: pages with a valid route, title and description; entry sources whose entity
 * and fields exist (the image — an image field). Anything else is dropped, never trusted. Without sources in the file
 * (or without the file) they are inferred from the spec (inferContentSources).
 */
export function parseSystemSeo(text: string | null, spec: AppSpec): SystemSeo {
  const out: { site: string; pages: Record<string, SeoPage>; content: ContentSource[] } = {
    site: spec.app.name,
    pages: {},
    content: [],
  };
  let raw: unknown = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (ONE_LINE(o.site, 120)) out.site = o.site;
  if (o.pages && typeof o.pages === "object" && !Array.isArray(o.pages))
    for (const [route, v] of Object.entries(o.pages as Record<string, unknown>).slice(0, 80)) {
      const p = (v ?? {}) as Record<string, unknown>;
      if (!ROUTE_RE.test(route) || !ONE_LINE(p.title, 120) || !ONE_LINE(p.description, 300)) continue;
      out.pages[route] = {
        title: p.title,
        description: p.description,
        ...(typeof p.image === "string" && SAME_ORIGIN_RE.test(p.image) ? { image: p.image } : {}),
      };
    }
  if (Array.isArray(o.content))
    for (const v of o.content.slice(0, 20)) {
      const s = checkedSource(spec, (v ?? {}) as Record<string, unknown>);
      if (s) out.content.push(s);
    }
  else out.content.push(...inferContentSources(spec));
  return out;
}

const cache = new Map<string, Promise<SystemSeo>>();

/** The SEO of a loaded system (cached per artifact folder: a revision never changes). */
export function systemSeo(sys: LoadedSystem): Promise<SystemSeo> {
  if (!sys.artifactDir) return Promise.resolve(parseSystemSeo(null, sys.spec));
  const key = `${sys.artifactDir}|${sys.entry.specHash}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = readFile(join(sys.artifactDir, SEO_FILE), "utf8")
      .catch(() => null)
      .then((text) => parseSystemSeo(text, sys.spec));
    if (cache.size >= 256) cache.delete(cache.keys().next().value as string);
    cache.set(key, hit);
  }
  return hit;
}

/** Origin of the system as the visitor sees it. */
export const originOf = (c: RuntimeContext): string =>
  `${c.get("services").env.publicScheme}://${c.get("host")}`;

const isDraft = (sys: LoadedSystem) => sys.entry.env !== "prod";
const NOINDEX = { "X-Robots-Tag": "noindex, nofollow" } as const;

/** Public static routes of the spec: pages the public role opens (no parameters, no sign-in pages). */
export function publicRoutes(spec: AppSpec): string[] {
  const role = spec.roles.find((r) => r.access === "public")?.name;
  if (!role) return [];
  const routes = (spec.pages ?? [])
    .filter((p) => p.roles.includes(role) && !p.route.includes(":") && p.route !== "/login")
    .map((p) => p.route);
  return [...new Set(routes)].sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Rows of an entry source the public role reads (published only: the module's rowFilter and RLS). */
async function entries(sys: LoadedSystem, s: ContentSource, max: number, slug?: string): Promise<Doc[]> {
  const subject = sys.data.publicSubject();
  if (!subject) return [];
  const out: Doc[] = [];
  for (let page = 1; out.length < max; page++) {
    const r = await sys.data.list(subject, s.entity, {
      filter: slug === undefined ? [] : [{ field: s.slug, op: "eq", value: slug }],
      sort: [{ field: "updated_at", dir: "desc" }],
      page,
      limit: Math.min(100, max - out.length),
    });
    out.push(...r.items);
    if (!r.hasMore || r.items.length === 0) break;
  }
  return out;
}

const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch] ?? ch,
  );

/** /sitemap.xml: the public pages and the published entries of every source, with the date of their last change. */
export async function sitemapXml(sys: LoadedSystem, origin: string): Promise<string> {
  const seo = await systemSeo(sys);
  const urls: { loc: string; lastmod?: string }[] = [];
  const seen = new Set<string>();
  const add = (path: string, lastmod?: unknown) => {
    if (seen.has(path)) return;
    seen.add(path);
    const day =
      typeof lastmod === "string" && /^\d{4}-\d{2}-\d{2}/.test(lastmod) ? lastmod.slice(0, 10) : undefined;
    urls.push({ loc: `${origin}${path}`, ...(day ? { lastmod: day } : {}) });
  };
  const policy = sys.compliance.policyPage;
  for (const r of publicRoutes(sys.spec)) add(r);
  if (policy) add(policy);
  for (const s of seo.content) {
    const rows = await entries(sys, s, SITEMAP_MAX_ENTRIES).catch(() => [] as Doc[]);
    for (const row of rows) {
      const slug = text(row[s.slug]);
      if (slug) add(`${s.prefix}${encodeURIComponent(slug)}`, row.updated_at);
    }
  }
  const body = urls
    .map((u) => `<url><loc>${xml(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

/** /robots.txt: a draft is closed to robots; a published system opens its pages, closes the API and the cabinets. */
export function robotsTxt(sys: LoadedSystem, origin: string): string {
  if (isDraft(sys)) return "User-agent: *\nDisallow: /\n";
  const role = sys.spec.roles.find((r) => r.access === "public")?.name;
  const pages = sys.spec.pages ?? [];
  // Address prefixes of the public pages (entry pages too): a closed prefix never covers one of them.
  const open = pages.filter((p) => role && p.roles.includes(role)).map((p) => p.route.split("/:")[0] || "/");
  const closed = new Set(["/api/", "/_wizard/", "/login"]);
  for (const p of pages) {
    if (role && p.roles.includes(role)) continue;
    const base = p.route.split("/:")[0] || "/";
    if (base !== "/" && !open.some((o) => o === base || o.startsWith(`${base}/`))) closed.add(base);
  }
  return [
    "User-agent: *",
    ...[...closed].sort().map((r) => `Disallow: ${r}`),
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export interface RouteHead {
  title: string;
  description?: string;
  image?: string;
  /** Canonical address (absolute). */
  canonical?: string;
  noindex?: boolean;
  /** An entry page (og:type article). */
  entry?: boolean;
}

/**
 * The slug of `pathname` under an entry source's prefix (one segment): undefined — not an entry address of the source,
 * null — an address no entry can have (not decodable, too long).
 */
export function entrySlug(pathname: string, prefix: string): string | null | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return undefined;
  try {
    const slug = decodeURIComponent(rest);
    return slug.length <= 200 ? slug : null;
  } catch {
    return null;
  }
}

/**
 * The head of a page for crawlers: a static route of ui/seo.json, or an entry of a source read by its slug as the
 * public role (a missing or unpublished one — «Страница не найдена» with noindex, answered 200 like every route of
 * the SPA: the page itself says it). null — the route is not described (the document as the build wrote it).
 */
export async function routeHead(
  sys: LoadedSystem,
  pathname: string,
  origin: string,
): Promise<RouteHead | null> {
  const seo = await systemSeo(sys);
  const page = seo.pages[pathname];
  if (page)
    return {
      title: page.title,
      description: page.description,
      ...(page.image ? { image: `${origin}${page.image}` } : {}),
      canonical: `${origin}${pathname}`,
    };
  for (const s of seo.content) {
    const slug = entrySlug(pathname, s.prefix);
    if (slug === undefined) continue;
    const row = slug === null ? undefined : (await entries(sys, s, 1, slug))[0];
    const fallback = seo.pages[s.route];
    if (!row || slug === null)
      return { title: `Страница не найдена — ${seo.site}`.slice(0, 120), noindex: true };
    const name = text(row[s.title]) ?? fallback?.title ?? seo.site;
    const own = s.seoTitle ? text(row[s.seoTitle]) : null;
    const description =
      s.description.map((f) => text(row[f])).find((d) => d !== null) ?? fallback?.description;
    const image = s.image ? text(row[s.image]) : null;
    return {
      title: clip(oneLine(own ?? (name === seo.site ? name : `${name} — ${seo.site}`)), 120),
      ...(description ? { description: clip(oneLine(description), 300) } : {}),
      ...(image
        ? {
            image: image.startsWith("/")
              ? `${origin}${image}`
              : `${origin}/api/files/${encodeURIComponent(image)}/img/1600`,
          }
        : {}),
      canonical: `${origin}${s.prefix}${encodeURIComponent(slug)}`,
      entry: true,
    };
  }
  return null;
}

/** index.html with the head of the route: the build's title, description, Open Graph and canonical replaced. */
export function withRouteHead(html: string, head: RouteHead, site: string): string {
  const meta = (attr: "name" | "property", key: string, value: string) =>
    `<meta ${attr}="${key}" content="${escapeHtml(value)}">`;
  const tags = [
    `<title>${escapeHtml(head.title)}</title>`,
    ...(head.noindex ? [meta("name", "robots", "noindex")] : []),
    ...(head.description ? [meta("name", "description", head.description)] : []),
    meta("property", "og:type", head.entry ? "article" : "website"),
    meta("property", "og:locale", "ru_RU"),
    meta("property", "og:site_name", site),
    meta("property", "og:title", head.title),
    ...(head.description ? [meta("property", "og:description", head.description)] : []),
    ...(head.image ? [meta("property", "og:image", head.image)] : []),
    ...(head.canonical
      ? [
          meta("property", "og:url", head.canonical),
          `<link rel="canonical" href="${escapeHtml(head.canonical)}">`,
        ]
      : []),
  ];
  const cleaned = html
    .replace(/<title>[\s\S]*?<\/title>\n?/, "")
    .replace(/<meta (?:name="(?:description|robots)"|property="og:[a-z_:]+")[^>]*>\n?/g, "")
    .replace(/<link rel="canonical"[^>]*>\n?/g, "");
  const at = cleaned.indexOf("</head>");
  return at < 0 ? cleaned : `${cleaned.slice(0, at)}${tags.join("\n")}\n${cleaned.slice(at)}`;
}

/**
 * The document of a route: the bundle's index.html with the route's head (an entry page reads its entry), noindex
 * for a missing entry; a draft host answers noindex. Errors of the data read keep the document as built.
 */
export async function routeDocument(c: RuntimeContext, html: string): Promise<Response> {
  const sys = c.get("system");
  const pathname = new URL(c.req.url).pathname;
  const draft = isDraft(sys) ? NOINDEX : {};
  let head: RouteHead | null = null;
  try {
    head = await routeHead(sys, pathname, originOf(c));
  } catch {
    head = null;
  }
  if (!head) return c.body(html, 200, { ...documentHeaders(), ...draft });
  const site = (await systemSeo(sys)).site;
  return c.body(withRouteHead(html, head, site), 200, {
    ...documentHeaders(),
    ...draft,
    ...(head.noindex ? NOINDEX : {}),
  });
}

/** GET /sitemap.xml and /robots.txt of a system host (mounted before the static routes). */
export function siteSeoRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.get("/sitemap.xml", async (c) => {
    const sys = c.get("system");
    if (!sys.artifactDir) return notFoundPage();
    return c.body(await sitemapXml(sys, originOf(c)), 200, {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": NO_CACHE,
      ...(isDraft(sys) ? NOINDEX : {}),
    });
  });
  app.get("/robots.txt", (c) => {
    const sys = c.get("system");
    return c.body(robotsTxt(sys, originOf(c)), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": NO_CACHE,
      ...(isDraft(sys) ? NOINDEX : {}),
    });
  });
  return app;
}
