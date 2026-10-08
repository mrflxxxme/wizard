// Research service of a build (specs/agents/builder-v3.md §3 C8; D77 (15)): web_search over Yandex Search API,
// read_page and discover_docs over the public web by D46, with per-build limits, a cache and a call journal.
// Without YANDEX_SEARCH_API_KEY and YANDEX_FOLDER_ID search is off and only known addresses are read.
// Live network only with WIZARD_RESEARCH_MODE=live; otherwise recorded answers (builder-v3.md §4).
import { createHash, randomUUID } from "node:crypto";
import { PLACEHOLDER_RE, scrub } from "@wizard/pii";
import { DocIndex, type DocIndexEntry, discoverDocs, originOf } from "./discover.js";
import {
  assertPublicHost,
  bareHost,
  decodeText,
  type Fetched,
  fetchPublic,
  guardedTransport,
  parseHttpUrl,
  systemResolver,
} from "./net.js";
import { cutMarkdown, htmlToMarkdown, PAGE_MAX_CHARS } from "./page.js";
import { ALLOW_ALL, DISALLOW_ALL, ROBOTS_MAX_BYTES, type Robots, robotsFromStatus } from "./robots.js";
import { MemoryResearchStore, RESEARCH_TTL_MS, type ResearchStore } from "./store.js";
import {
  type PageResult,
  type ResearchCall,
  type ResearchContext,
  ResearchError,
  type ResearchErrorCode,
  type ResearchFetch,
  type ResearchLimits,
  type ResearchLog,
  type ResearchMode,
  type ResearchTool,
  type ResearchUsage,
  type Resolver,
  type SearchHit,
  type SearchResult,
} from "./types.js";
import {
  decodeRawData,
  parseYandexXml,
  SEARCH_FOLDER_ENV,
  SEARCH_KEY_ENV,
  SEARCH_QUERY_MAX,
  SEARCH_REGION_RU,
  SEARCH_RUB_PER_REQUEST,
  searchHttpError,
  YANDEX_SEARCH_ENDPOINT,
  yandexSearchBody,
} from "./yandex.js";

/** Limits of one build: ≈ 30 searches (D77 (15), backlog V3-05), page reads and domains for documentation. */
export const RESEARCH_LIMITS: ResearchLimits = { searches: 30, pages: 60, discover: 10 };
/** Page download cap (bytes after decompression) and deadline of all hops. */
export const PAGE_MAX_BYTES = 2 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 15_000;
export const SEARCH_TIMEOUT_MS = 15_000;
export const DOC_TIMEOUT_MS = 10_000;
export const ROBOTS_TIMEOUT_MS = 8_000;
/** Env switching research to the live network (anything else: recorded answers only). */
export const RESEARCH_MODE_ENV = "WIZARD_RESEARCH_MODE";

type Env = Readonly<Record<string, string | undefined>>;

export interface ResearchStatus {
  mode: ResearchMode;
  /** web_search is available (key and folder are set). */
  search: boolean;
  /** Why search is off (Russian), null when it is on. */
  reasonRu: string | null;
}

/** Search availability by the env: both YANDEX_SEARCH_API_KEY and YANDEX_FOLDER_ID are needed. */
export function searchStatus(env: Env): { search: boolean; reasonRu: string | null } {
  const missing = [SEARCH_KEY_ENV, SEARCH_FOLDER_ENV].filter((k) => !env[k]?.trim());
  if (missing.length === 0) return { search: true, reasonRu: null };
  return {
    search: false,
    reasonRu: `Веб-поиск выключен: не задан ${missing.join(" и ")}. Работаю только с известными адресами — читаю страницы и документацию по ссылкам из брифа и разговора.`,
  };
}

/** live only when WIZARD_RESEARCH_MODE=live: search spends the founder's Yandex Cloud balance. */
export function researchMode(env: Env): ResearchMode {
  return env[RESEARCH_MODE_ENV] === "live" ? "live" : "fixture";
}

export interface ResearchOptions {
  /** Default process.env: YANDEX_SEARCH_API_KEY, YANDEX_FOLDER_ID, WIZARD_RESEARCH_MODE. */
  env?: Env;
  mode?: ResearchMode;
  /** Pages and documentation. Default: live — guardedTransport; fixture — refuses (FIXTURE_MISSING). */
  fetch?: ResearchFetch;
  /** Search requests. Default: `fetch` when given, else live — globalThis.fetch. */
  searchFetch?: ResearchFetch;
  /** Default: live — system DNS; fixture — every name is a public documentation address. */
  resolve?: Resolver;
  store?: ResearchStore;
  log?: ResearchLog;
  limits?: Partial<ResearchLimits>;
  context?: ResearchContext;
  clock?: () => number;
  newId?: () => string;
  /** Deadlines, ms (defaults: PAGE_TIMEOUT_MS, SEARCH_TIMEOUT_MS, DOC_TIMEOUT_MS, ROBOTS_TIMEOUT_MS). */
  timeoutsMs?: Partial<{ page: number; search: number; docs: number; robots: number }>;
}

export interface SearchOptions {
  /** Yandex region id (lr), default 225 (Russia). */
  region?: string;
  page?: number;
}

export interface Research {
  readonly status: ResearchStatus;
  readonly limits: ResearchLimits;
  readonly docs: DocIndex;
  search(query: string, opts?: SearchOptions): Promise<SearchResult>;
  readPage(url: string): Promise<PageResult>;
  discover(domain: string): Promise<DocIndexEntry>;
  usage(): ResearchUsage;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const fixtureFetch: ResearchFetch = async () => {
  throw new ResearchError(
    "FIXTURE_MISSING",
    "Режим фикстур: живые запросы выключены (WIZARD_RESEARCH_MODE=live).",
  );
};
/** Fixture mode: names resolve to a TEST-NET-3 address (public by the check, never dialed). */
const fixtureResolver: Resolver = async () => ["203.0.113.10"];

const PAGE_ACCEPT =
  "text/html,application/xhtml+xml;q=0.9,text/markdown;q=0.9,text/plain;q=0.8,application/json;q=0.7,*/*;q=0.1";

function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function asResearchError(e: unknown): ResearchError {
  if (e instanceof ResearchError) return e;
  const name = (e as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError")
    return new ResearchError("TIMEOUT", "Сервис не ответил вовремя.");
  return new ResearchError("NETWORK", "Не удалось выполнить запрос.");
}

/** Query for the search engine: personal data removed (placeholders dropped), spaces collapsed, ≤ 400 characters. */
export function searchQueryText(query: string): {
  text: string;
  scrubbed: boolean;
  counts: Record<string, number>;
} {
  const s = scrub(query);
  const text = s.text
    .replace(PLACEHOLDER_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_QUERY_MAX)
    .trim();
  const counts = s.counts as Record<string, number>;
  return { text, scrubbed: Object.keys(counts).length > 0, counts };
}

/** Research of one build. */
export function createResearch(o: ResearchOptions = {}): Research {
  const env = o.env ?? process.env;
  const mode = o.mode ?? researchMode(env);
  const resolve = o.resolve ?? (mode === "live" ? systemResolver : fixtureResolver);
  const fetchPage = o.fetch ?? (mode === "live" ? guardedTransport(resolve) : fixtureFetch);
  const fetchSearch = o.searchFetch ?? o.fetch ?? (mode === "live" ? globalThis.fetch : fixtureFetch);
  const store = o.store ?? new MemoryResearchStore();
  const docs = new DocIndex(store);
  const limits: ResearchLimits = { ...RESEARCH_LIMITS, ...o.limits };
  const clock = o.clock ?? Date.now;
  const newId = o.newId ?? randomUUID;
  const ctx = o.context ?? {};
  const timeouts = {
    page: PAGE_TIMEOUT_MS,
    search: SEARCH_TIMEOUT_MS,
    docs: DOC_TIMEOUT_MS,
    robots: ROBOTS_TIMEOUT_MS,
    ...o.timeoutsMs,
  };
  const avail = searchStatus(env);
  const status: ResearchStatus = { mode, ...avail };
  const key = env[SEARCH_KEY_ENV]?.trim() ?? "";
  const folderId = env[SEARCH_FOLDER_ENV]?.trim() ?? "";
  const used: ResearchUsage = { searches: 0, pages: 0, discover: 0, cacheHits: 0, refused: 0, costRub: 0 };
  const robotsByOrigin = new Map<string, Promise<Robots>>();

  interface Entry {
    tool: ResearchTool;
    requestHash: string;
    host: string | null;
    started: number;
    scrubbed?: boolean;
    counts?: Record<string, number>;
  }
  const journal = async (
    e: Entry,
    st: ResearchCall["status"],
    extra: { errorCode?: ResearchErrorCode | null; costRub?: number; results?: number } = {},
  ) => {
    if (st === "refused") used.refused++;
    if (st === "cached") used.cacheHits++;
    const call: ResearchCall = {
      id: newId(),
      createdAt: new Date(clock()).toISOString(),
      runId: ctx.runId ?? null,
      orgId: ctx.orgId ?? null,
      systemId: ctx.systemId ?? null,
      tool: e.tool,
      status: st,
      errorCode: extra.errorCode ?? null,
      costRub: extra.costRub ?? 0,
      latencyMs: Math.max(0, clock() - e.started),
      mode,
      requestHash: e.requestHash,
      host: e.host,
      results: extra.results ?? 0,
      scrubbed: e.scrubbed ?? false,
      piiCategoriesCount: e.counts ?? {},
    };
    try {
      await o.log?.write(call);
    } catch {
      // The journal never breaks a build; platform-api alerts on its own sink failures.
    }
  };
  const refuse = async (e: Entry, code: ResearchErrorCode, message: string): Promise<never> => {
    await journal(e, "refused", { errorCode: code });
    throw new ResearchError(code, message);
  };

  const robotsFor = (origin: string): Promise<Robots> => {
    let p = robotsByOrigin.get(origin);
    if (!p) {
      p = (async () => {
        const cacheKey = `robots:${origin}`;
        const hit = (await store.get(cacheKey)) as { status: number; text: string } | null;
        if (hit) return robotsFromStatus(hit.status, hit.text);
        try {
          const f = await fetchPublic(`${origin}/robots.txt`, {
            fetch: fetchPage,
            resolve,
            maxBytes: ROBOTS_MAX_BYTES,
            timeoutMs: timeouts.robots,
            accept: "text/plain",
          });
          const text = f.status < 300 ? decodeText(f.body, f.contentType) : "";
          await store.set(cacheKey, { status: f.status, text }, RESEARCH_TTL_MS.robots);
          return robotsFromStatus(f.status, text);
        } catch (e) {
          // Recorded answers without robots.txt: nothing forbids. Live: unreachable means "all disallowed" (RFC 9309).
          if (e instanceof ResearchError && e.code === "FIXTURE_MISSING") return ALLOW_ALL;
          return DISALLOW_ALL;
        }
      })();
      robotsByOrigin.set(origin, p);
    }
    return p;
  };
  const checkRobots = async (u: URL) => {
    const robots = await robotsFor(u.origin);
    if (!robots.allows(`${u.pathname}${u.search}`)) {
      throw new ResearchError("ROBOTS_DISALLOWED", "Сайт запретил роботам читать эту страницу (robots.txt).");
    }
  };

  return {
    status,
    limits,
    docs,

    async search(query, so = {}) {
      const started = clock();
      const q = searchQueryText(query);
      const region = so.region ?? SEARCH_REGION_RU;
      const page = so.page ?? 0;
      const e: Entry = {
        tool: "web_search",
        requestHash: sha256(`${q.text.toLowerCase()}|${region}|${page}`),
        host: "searchapi",
        started,
        scrubbed: q.scrubbed,
        counts: q.counts,
      };
      if (!status.search) return refuse(e, "SEARCH_DISABLED", status.reasonRu ?? "Веб-поиск выключен.");
      if (q.text.length < 2) {
        return refuse(
          e,
          "QUERY_EMPTY",
          "Запрос пуст после удаления персональных данных — уточните тему поиска.",
        );
      }
      const cacheKey = `search:${e.requestHash}`;
      const hit = (await store.get(cacheKey)) as {
        query: string;
        hits: SearchHit[];
        found: number | null;
      } | null;
      if (hit) {
        await journal(e, "cached", { results: hit.hits.length });
        return { ...hit, cached: true, remaining: limits.searches - used.searches };
      }
      if (used.searches >= limits.searches) {
        return refuse(
          e,
          "SEARCH_LIMIT",
          `Лимит поиска на сборку исчерпан (${limits.searches} запросов). Используйте найденное или читайте известные адреса.`,
        );
      }
      used.searches++;
      let cost = 0;
      try {
        const res = await fetchSearch(YANDEX_SEARCH_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Api-Key ${key}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(yandexSearchBody({ queryText: q.text, folderId, region, page })),
          signal: AbortSignal.timeout(timeouts.search),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          throw searchHttpError(res.status);
        }
        cost = SEARCH_RUB_PER_REQUEST;
        used.costRub += cost;
        const parsed = parseYandexXml(decodeRawData(await res.json()));
        if (parsed.errorCode !== null && parsed.errorCode !== 15) {
          throw new ResearchError("SEARCH_FAILED", `Поиск вернул ошибку ${parsed.errorCode}.`);
        }
        const result = {
          query: q.text,
          hits: parsed.hits,
          found: parsed.found ?? (parsed.errorCode === 15 ? 0 : null),
        };
        await store.set(cacheKey, result, RESEARCH_TTL_MS.search);
        await journal(e, "ok", { costRub: cost, results: result.hits.length });
        return { ...result, cached: false, remaining: limits.searches - used.searches };
      } catch (err) {
        const re = asResearchError(err);
        await journal(e, "error", { errorCode: re.code, costRub: cost });
        throw re;
      }
    },

    async readPage(raw) {
      const started = clock();
      let url: URL;
      try {
        url = parseHttpUrl(raw);
      } catch (err) {
        const re = asResearchError(err);
        return refuse(
          { tool: "read_page", requestHash: sha256(raw), host: null, started },
          re.code,
          re.message,
        );
      }
      const e: Entry = { tool: "read_page", requestHash: sha256(url.href), host: bareHost(url), started };
      const cacheKey = `page:${e.requestHash}`;
      const hit = (await store.get(cacheKey)) as Omit<PageResult, "cached"> | null;
      if (hit) {
        await journal(e, "cached", { results: hit.markdown.length });
        return { ...hit, cached: true };
      }
      try {
        await assertPublicHost(url, resolve);
      } catch (err) {
        const re = asResearchError(err);
        return refuse(e, re.code, re.message);
      }
      if (used.pages >= limits.pages) {
        return refuse(e, "PAGE_LIMIT", `Лимит чтения страниц на сборку исчерпан (${limits.pages}).`);
      }
      used.pages++;
      try {
        const f: Fetched = await fetchPublic(url.href, {
          fetch: fetchPage,
          resolve,
          maxBytes: PAGE_MAX_BYTES,
          timeoutMs: timeouts.page,
          accept: PAGE_ACCEPT,
          beforeHop: checkRobots,
        });
        if (f.status >= 400)
          throw new ResearchError("HTTP_ERROR", `Страница ответила кодом ${f.status}.`, f.status);
        const type = mediaType(f.contentType);
        const text = decodeText(f.body, f.contentType);
        let title: string;
        let markdown: string;
        let truncated: boolean;
        if (
          type === "text/html" ||
          type === "application/xhtml+xml" ||
          (type === "" && /<html\b/i.test(text))
        ) {
          const page = await htmlToMarkdown(text, f.url, PAGE_MAX_CHARS);
          ({ title, markdown, truncated } = page);
        } else if (
          type.startsWith("text/") ||
          /[/+](json|xml)$/.test(type) ||
          type === "application/x-yaml"
        ) {
          const cut = cutMarkdown(text.trim(), PAGE_MAX_CHARS);
          title = new URL(f.url).pathname.split("/").filter(Boolean).at(-1) ?? bareHost(new URL(f.url));
          markdown = cut.text;
          truncated = cut.truncated;
        } else {
          throw new ResearchError(
            "UNSUPPORTED_TYPE",
            `Этот тип файла (${type || "неизвестный"}) не читаем: нужна HTML-страница или текст.`,
          );
        }
        const result: Omit<PageResult, "cached"> = {
          url: url.href,
          finalUrl: f.url,
          title,
          markdown,
          contentType: type,
          bytes: f.body.byteLength,
          truncated,
        };
        await store.set(cacheKey, result, RESEARCH_TTL_MS.page);
        await journal(e, "ok", { results: markdown.length });
        return { ...result, cached: false };
      } catch (err) {
        const re = asResearchError(err);
        await journal(e, re.code === "ROBOTS_DISALLOWED" ? "refused" : "error", { errorCode: re.code });
        throw re;
      }
    },

    async discover(domain) {
      const started = clock();
      let origin: string;
      try {
        origin = originOf(domain);
      } catch (err) {
        const re = asResearchError(err);
        return refuse(
          { tool: "discover_docs", requestHash: sha256(domain), host: null, started },
          re.code,
          re.message,
        );
      }
      const e: Entry = {
        tool: "discover_docs",
        requestHash: sha256(origin),
        host: bareHost(new URL(origin)),
        started,
      };
      const hit = await docs.get(origin);
      if (hit) {
        await journal(e, "cached", { results: hit.sources.filter((s) => s.found).length });
        return hit;
      }
      try {
        await assertPublicHost(new URL(origin), resolve);
      } catch (err) {
        const re = asResearchError(err);
        return refuse(e, re.code, re.message);
      }
      if (used.discover >= limits.discover) {
        return refuse(
          e,
          "DISCOVER_LIMIT",
          `Лимит поиска документации на сборку исчерпан (${limits.discover} сайтов).`,
        );
      }
      used.discover++;
      try {
        const robots = await robotsFor(origin);
        const found = await discoverDocs(origin, {
          sitemaps: robots.sitemaps,
          now: clock,
          fetchDoc: async (u, maxBytes, accept) => {
            const f = await fetchPublic(u, {
              fetch: fetchPage,
              resolve,
              maxBytes,
              timeoutMs: timeouts.docs,
              accept,
              beforeHop: checkRobots,
            });
            return {
              url: f.url,
              status: f.status,
              contentType: f.contentType,
              text: decodeText(f.body, f.contentType),
            };
          },
        });
        await docs.put(found);
        await journal(e, "ok", { results: found.entry.sources.filter((s) => s.found).length });
        return found.entry;
      } catch (err) {
        const re = asResearchError(err);
        await journal(e, "error", { errorCode: re.code });
        throw re;
      }
    },

    usage() {
      return { ...used, costRub: Math.round(used.costRub * 1000) / 1000 };
    },
  };
}
