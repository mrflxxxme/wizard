// Documentation of a domain (D77 (15); docs/research/2026-10-08-v3-research.md §7): llms.txt (llmstxt.org),
// openapi.json / swagger.json, /.well-known/api-catalog (RFC 9727), sitemap.xml (robots.txt Sitemap: lines first).
// The result goes into the documentation index (DocIndex) with a cache; raw OpenAPI and llms.txt are kept beside it.
import { createHash } from "node:crypto";
import type { ResearchStore } from "./store.js";
import { RESEARCH_TTL_MS } from "./store.js";
import { ResearchError, type ResearchErrorCode } from "./types.js";

export type DocSourceKind = "llms_txt" | "openapi" | "swagger" | "api_catalog" | "sitemap";

export interface DocSource {
  kind: DocSourceKind;
  url: string;
  found: boolean;
  /** HTTP status; null when the request failed before an answer. */
  status: number | null;
  bytes: number;
  errorCode: ResearchErrorCode | null;
}

export interface LlmsLink {
  title: string;
  url: string;
  note: string;
}

export interface LlmsTxt {
  title: string;
  summary: string;
  sections: { title: string; links: LlmsLink[] }[];
}

export interface ApiOperation {
  method: string;
  path: string;
  operationId: string | null;
  summary: string;
}

export interface OpenApiSummary {
  url: string;
  /** "openapi 3.1.0" or "swagger 2.0". */
  spec: string;
  title: string;
  version: string;
  servers: string[];
  operations: ApiOperation[];
  truncated: boolean;
  sha256: string;
}

export interface SitemapSummary {
  url: string;
  urls: string[];
  /** Child sitemaps of a sitemap index (not fetched). */
  sitemaps: string[];
  truncated: boolean;
}

export interface DocIndexEntry {
  /** https://host of the domain. */
  origin: string;
  fetchedAt: string;
  sources: DocSource[];
  llmsTxt: LlmsTxt | null;
  openapi: OpenApiSummary | null;
  apiCatalog: { links: { rel: string; href: string }[] } | null;
  sitemap: SitemapSummary | null;
}

/** Caps of one discovery. */
export const DOC_LIMITS = {
  llmsBytes: 512 * 1024,
  specBytes: 5 * 1024 * 1024,
  sitemapBytes: 5 * 1024 * 1024,
  operations: 500,
  sitemapUrls: 500,
  llmsLinks: 300,
} as const;

/** Paths probed on every domain (sitemap: robots.txt Sitemap: first, else /sitemap.xml). */
export const DOC_PATHS: Readonly<Record<Exclude<DocSourceKind, "sitemap">, string>> = {
  llms_txt: "/llms.txt",
  openapi: "/openapi.json",
  swagger: "/swagger.json",
  api_catalog: "/.well-known/api-catalog",
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const looksLikeHtml = (text: string, contentType: string) =>
  /html/i.test(contentType) || /^\s*<(!doctype|html|head|body)\b/i.test(text);

/** https origin of a domain or URL ("yookassa.ru", "https://yookassa.ru/developers" → https://yookassa.ru). */
export function originOf(domain: string): string {
  const raw = domain.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new ResearchError("URL_INVALID", "Нужен домен вида example.ru или адрес сайта.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ResearchError("SCHEME_FORBIDDEN", "Документацию ищем только на сайтах http и https.");
  }
  return url.origin;
}

/** llms.txt (llmstxt.org): H1 title, blockquote summary, H2 sections of `- [title](url): note` links. */
export function parseLlmsTxt(text: string, base: string): LlmsTxt | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const first = lines.find((l) => l.trim() !== "");
  if (!first || !/^#\s+\S/.test(first.trim())) return null;
  const title = first.trim().replace(/^#\s+/, "");
  const summary: string[] = [];
  const sections: LlmsTxt["sections"] = [];
  let current: LlmsTxt["sections"][number] | null = null;
  let links = 0;
  for (const raw of lines.slice(lines.indexOf(first) + 1)) {
    const line = raw.trim();
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      current = { title: (h2[1] as string).trim(), links: [] };
      sections.push(current);
      continue;
    }
    if (current === null && line.startsWith(">")) {
      summary.push(line.replace(/^>\s?/, ""));
      continue;
    }
    const link = /^[-*]\s*\[([^\]]+)\]\(([^)\s]+)\)\s*(?::\s*(.*))?$/.exec(line);
    if (link && links < DOC_LIMITS.llmsLinks) {
      let url: string;
      try {
        url = new URL(link[2] as string, base).href;
      } catch {
        continue;
      }
      if (current === null) {
        current = { title: "", links: [] };
        sections.push(current);
      }
      current.links.push({ title: (link[1] as string).trim(), url, note: (link[3] ?? "").trim() });
      links++;
    }
  }
  return { title, summary: summary.join(" ").trim(), sections };
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

/** OpenAPI 3.x or Swagger 2.0 JSON → title, servers and the list of operations; null when it is neither. */
export function summarizeOpenApi(text: string, url: string): OpenApiSummary | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object") return null;
  const openapi = typeof doc.openapi === "string" ? doc.openapi : null;
  const swagger = typeof doc.swagger === "string" ? doc.swagger : null;
  if (openapi === null && swagger === null) return null;
  const info = (doc.info ?? {}) as { title?: unknown; version?: unknown };
  const servers: string[] = [];
  if (Array.isArray(doc.servers)) {
    for (const s of doc.servers as { url?: unknown }[]) if (typeof s?.url === "string") servers.push(s.url);
  } else if (typeof doc.host === "string") {
    const schemes = Array.isArray(doc.schemes) ? (doc.schemes as string[]) : ["https"];
    const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
    for (const sc of schemes) servers.push(`${sc}://${doc.host}${basePath}`);
  }
  const operations: ApiOperation[] = [];
  let truncated = false;
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [path, item] of Object.entries(paths)) {
    if (item === null || typeof item !== "object") continue;
    for (const m of METHODS) {
      const op = item[m] as { operationId?: unknown; summary?: unknown; description?: unknown } | undefined;
      if (!op || typeof op !== "object") continue;
      if (operations.length >= DOC_LIMITS.operations) {
        truncated = true;
        break;
      }
      const summary = typeof op.summary === "string" ? op.summary : "";
      operations.push({
        method: m.toUpperCase(),
        path,
        operationId: typeof op.operationId === "string" ? op.operationId : null,
        summary: (summary || (typeof op.description === "string" ? op.description : "")).slice(0, 200),
      });
    }
  }
  return {
    url,
    spec: openapi !== null ? `openapi ${openapi}` : `swagger ${swagger}`,
    title: typeof info.title === "string" ? info.title : "",
    version: typeof info.version === "string" ? info.version : "",
    servers,
    operations,
    truncated,
    sha256: sha256(text),
  };
}

const locs = (xml: string, parent: string) =>
  [...xml.matchAll(new RegExp(`<${parent}\\b[^>]*>[\\s\\S]*?<loc>\\s*([^<\\s]+)\\s*</loc>`, "gi"))].map((m) =>
    (m[1] as string).replace(/&amp;/g, "&"),
  );

/** sitemap.xml: page URLs of a urlset or child sitemaps of a sitemapindex; null when it is neither. */
export function parseSitemap(xml: string, url: string): SitemapSummary | null {
  const isIndex = /<sitemapindex\b/i.test(xml);
  if (!isIndex && !/<urlset\b/i.test(xml)) return null;
  const all = isIndex ? locs(xml, "sitemap") : locs(xml, "url");
  const cap = DOC_LIMITS.sitemapUrls;
  return {
    url,
    urls: isIndex ? [] : all.slice(0, cap),
    sitemaps: isIndex ? all.slice(0, cap) : [],
    truncated: all.length > cap,
  };
}

/** /.well-known/api-catalog (RFC 9727, application/linkset+json) → links by relation. */
export function parseApiCatalog(
  text: string,
  base: string,
): { links: { rel: string; href: string }[] } | null {
  let doc: { linkset?: unknown };
  try {
    doc = JSON.parse(text) as { linkset?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(doc?.linkset)) return null;
  const links: { rel: string; href: string }[] = [];
  for (const ctx of doc.linkset as Record<string, unknown>[]) {
    if (ctx === null || typeof ctx !== "object") continue;
    for (const [rel, targets] of Object.entries(ctx)) {
      if (rel === "anchor" || !Array.isArray(targets)) continue;
      for (const t of targets as { href?: unknown }[]) {
        if (typeof t?.href !== "string") continue;
        try {
          links.push({ rel, href: new URL(t.href, base).href });
        } catch {
          // A broken href is skipped.
        }
      }
    }
  }
  return { links: links.slice(0, 200) };
}

/** What discovery needs from research: a GET of a public URL with robots.txt applied. */
export type DocFetch = (
  url: string,
  maxBytes: number,
  accept: string,
) => Promise<{ url: string; status: number; contentType: string; text: string }>;

export interface DiscoverDeps {
  fetchDoc: DocFetch;
  /** Sitemap: lines of the domain's robots.txt. */
  sitemaps: string[];
  now: () => number;
}

export interface Discovered {
  entry: DocIndexEntry;
  /** Raw texts by URL (OpenAPI, llms.txt) for DocIndex.raw. */
  raw: Record<string, string>;
}

/** Probes the documentation paths of `origin` in parallel and builds the index entry. */
export async function discoverDocs(origin: string, deps: DiscoverDeps): Promise<Discovered> {
  const raw: Record<string, string> = {};
  const sources: DocSource[] = [];
  const get = async (kind: DocSourceKind, url: string, maxBytes: number, accept: string) => {
    try {
      const r = await deps.fetchDoc(url, maxBytes, accept);
      return { kind, url: r.url, status: r.status, contentType: r.contentType, text: r.text, error: null };
    } catch (e) {
      const code = e instanceof ResearchError ? e.code : "NETWORK";
      return { kind, url, status: null, contentType: "", text: "", error: code as ResearchErrorCode };
    }
  };
  const sitemapUrl = deps.sitemaps[0] ?? `${origin}/sitemap.xml`;
  const [llms, openapi, swagger, catalog, sitemap] = await Promise.all([
    get(
      "llms_txt",
      origin + DOC_PATHS.llms_txt,
      DOC_LIMITS.llmsBytes,
      "text/plain, text/markdown;q=0.9, */*;q=0.1",
    ),
    get("openapi", origin + DOC_PATHS.openapi, DOC_LIMITS.specBytes, "application/json, */*;q=0.1"),
    get("swagger", origin + DOC_PATHS.swagger, DOC_LIMITS.specBytes, "application/json, */*;q=0.1"),
    get(
      "api_catalog",
      origin + DOC_PATHS.api_catalog,
      DOC_LIMITS.llmsBytes,
      "application/linkset+json, application/json;q=0.9",
    ),
    get("sitemap", sitemapUrl, DOC_LIMITS.sitemapBytes, "application/xml, text/xml;q=0.9, */*;q=0.1"),
  ]);
  const ok = (r: { status: number | null; contentType: string; text: string }) =>
    r.status !== null && r.status >= 200 && r.status < 300 && !looksLikeHtml(r.text, r.contentType);
  const source = (r: typeof llms, found: boolean): DocSource => ({
    kind: r.kind,
    url: r.url,
    found,
    status: r.status,
    bytes: Buffer.byteLength(r.text),
    errorCode: r.error,
  });

  const llmsTxt = ok(llms) ? parseLlmsTxt(llms.text, llms.url) : null;
  sources.push(source(llms, llmsTxt !== null));
  if (llmsTxt) raw[llms.url] = llms.text;

  let spec: OpenApiSummary | null = null;
  for (const r of [openapi, swagger]) {
    const s = ok(r) ? summarizeOpenApi(r.text, r.url) : null;
    sources.push(source(r, s !== null));
    if (s && spec === null) {
      spec = s;
      raw[r.url] = r.text;
    }
  }
  const apiCatalog = ok(catalog) ? parseApiCatalog(catalog.text, catalog.url) : null;
  sources.push(source(catalog, apiCatalog !== null));
  const map = ok(sitemap) ? parseSitemap(sitemap.text, sitemap.url) : null;
  sources.push(source(sitemap, map !== null));

  // No spec at the usual paths: one more try at a JSON description the catalog or llms.txt points to.
  if (spec === null) {
    const hinted =
      apiCatalog?.links.find((l) => l.rel === "service-desc")?.href ??
      llmsTxt?.sections.flatMap((s) => s.links).find((l) => /(openapi|swagger)[^/]*\.json$/i.test(l.url))
        ?.url;
    if (hinted) {
      const r = await get("openapi", hinted, DOC_LIMITS.specBytes, "application/json, */*;q=0.1");
      spec = ok(r) ? summarizeOpenApi(r.text, r.url) : null;
      sources.push(source(r, spec !== null));
      if (spec) raw[r.url] = r.text;
    }
  }
  return {
    entry: {
      origin,
      fetchedAt: new Date(deps.now()).toISOString(),
      sources,
      llmsTxt,
      openapi: spec,
      apiCatalog,
      sitemap: map,
    },
    raw,
  };
}

/** Documentation index over a ResearchStore: one entry per origin plus the raw documents. */
export class DocIndex {
  constructor(
    private readonly store: ResearchStore,
    private readonly ttlMs: number = RESEARCH_TTL_MS.docs,
  ) {}

  async get(origin: string): Promise<DocIndexEntry | null> {
    return (await this.store.get(`docs:${origin}`)) as DocIndexEntry | null;
  }

  async put(d: Discovered): Promise<void> {
    await this.store.set(`docs:${d.entry.origin}`, d.entry, this.ttlMs);
    for (const [url, text] of Object.entries(d.raw)) await this.store.set(`docraw:${url}`, text, this.ttlMs);
  }

  /** Raw text of a found document (OpenAPI JSON, llms.txt) by its URL. */
  async raw(url: string): Promise<string | null> {
    const v = await this.store.get(`docraw:${url}`);
    return typeof v === "string" ? v : null;
  }
}

/** Compact view of an entry for the model: found sources, links and operations matching `topic` (≤ caps). */
export function docsView(
  entry: DocIndexEntry,
  topic?: string,
  caps = { links: 40, operations: 60, urls: 30 },
) {
  const words = (topic ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 3);
  const match = (...texts: (string | null)[]) =>
    words.length === 0 || words.some((w) => texts.some((t) => (t ?? "").toLowerCase().includes(w)));
  return {
    origin: entry.origin,
    found: entry.sources.filter((s) => s.found).map((s) => ({ kind: s.kind, url: s.url })),
    llmsTxt: entry.llmsTxt && {
      title: entry.llmsTxt.title,
      summary: entry.llmsTxt.summary,
      links: entry.llmsTxt.sections
        .flatMap((s) => s.links.map((l) => ({ section: s.title, ...l })))
        .filter((l) => match(l.title, l.url, l.note, l.section))
        .slice(0, caps.links),
    },
    openapi: entry.openapi && {
      url: entry.openapi.url,
      spec: entry.openapi.spec,
      title: entry.openapi.title,
      version: entry.openapi.version,
      servers: entry.openapi.servers,
      operationsTotal: entry.openapi.operations.length,
      operations: entry.openapi.operations
        .filter((o) => match(o.path, o.operationId, o.summary))
        .slice(0, caps.operations),
    },
    apiCatalog: entry.apiCatalog,
    sitemap: entry.sitemap && {
      url: entry.sitemap.url,
      urlsTotal: entry.sitemap.urls.length,
      urls: entry.sitemap.urls.filter((u) => match(u)).slice(0, caps.urls),
      sitemaps: entry.sitemap.sitemaps.slice(0, caps.urls),
    },
  };
}
