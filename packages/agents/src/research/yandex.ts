// Yandex Search API v2, synchronous web search (aistudio.yandex.ru/docs/ru/search-api/operations/web-search-sync,
// api-ref/WebSearch/search): POST JSON with `Authorization: Api-Key <key>` and folderId in the body; the answer is
// JSON {rawData: base64 of the XML result}. XML (yandexsearch → response → results → grouping → group → doc): every
// field is optional by the docs, so the parser tolerates missing ones; <error code="15"> means "nothing found".
import { ResearchError, type SearchHit } from "./types.js";

export const YANDEX_SEARCH_ENDPOINT = "https://searchapi.api.cloud.yandex.net/v2/web/search";
/** Env of the API key (Yandex AI Studio, role search-api.webSearch.user). */
export const SEARCH_KEY_ENV = "YANDEX_SEARCH_API_KEY";
/** Env of the Yandex Cloud folder id the requests are billed to. */
export const SEARCH_FOLDER_ENV = "YANDEX_FOLDER_ID";

/**
 * ₽ per synchronous request in the daytime: 488 ₽ per 1000 (night 366 ₽) — docs/research/2026-10-08-v3-research.md §7.
 * The day price is used for every request: the estimate never undercounts.
 */
export const SEARCH_RUB_PER_REQUEST = 0.488;
/** queryText limit of the API. */
export const SEARCH_QUERY_MAX = 400;
/** Results per request (groupsOnPage; one document per domain group). */
export const SEARCH_GROUPS_ON_PAGE = 10;
/** Region by default: Russia (lr 225). */
export const SEARCH_REGION_RU = "225";

export interface SearchRequest {
  queryText: string;
  folderId: string;
  /** Yandex region id (lr): 225 Russia, 213 Moscow, 43 Kazan, … */
  region?: string;
  /** Zero-based page. */
  page?: number;
}

/** Body of POST /v2/web/search (REST field names and enums of api-ref/WebSearch/search). */
export function yandexSearchBody(r: SearchRequest): Record<string, unknown> {
  return {
    query: {
      searchType: "SEARCH_TYPE_RU",
      queryText: r.queryText.slice(0, SEARCH_QUERY_MAX),
      familyMode: "FAMILY_MODE_MODERATE",
      page: String(r.page ?? 0),
      fixTypoMode: "FIX_TYPO_MODE_ON",
    },
    sortSpec: { sortMode: "SORT_MODE_BY_RELEVANCE", sortOrder: "SORT_ORDER_DESC" },
    groupSpec: {
      groupMode: "GROUP_MODE_DEEP",
      groupsOnPage: String(SEARCH_GROUPS_ON_PAGE),
      docsInGroup: "1",
    },
    maxPassages: "2",
    region: r.region ?? SEARCH_REGION_RU,
    l10n: "LOCALIZATION_RU",
    folderId: r.folderId,
    responseFormat: "FORMAT_XML",
  };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Text of an XML fragment: CDATA unwrapped, tags (<hlword>) dropped, entities decoded, spaces collapsed. */
function textOf(fragment: string | undefined): string {
  if (!fragment) return "";
  const noCdata = fragment.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return decodeEntities(noCdata.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml)?.[1];
}

export interface ParsedSearch {
  hits: SearchHit[];
  found: number | null;
  /** <error code> of the response; 15 = nothing found (not a failure). */
  errorCode: number | null;
}

/** Organic results of the XML answer. */
export function parseYandexXml(xml: string): ParsedSearch {
  const response = tag(xml, "response") ?? xml;
  const err = /<error\b[^>]*\bcode="(\d+)"/i.exec(response);
  const foundAll = /<found\b[^>]*priority="all"[^>]*>(\d+)<\/found>/i.exec(response)?.[1];
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const m of response.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/gi)) {
    const doc = m[1] as string;
    const url = textOf(tag(doc, "url"));
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    let domain = textOf(tag(doc, "domain"));
    if (!domain) {
      try {
        domain = new URL(url).hostname;
      } catch {
        domain = "";
      }
    }
    const passages = [...doc.matchAll(/<passage\b[^>]*>([\s\S]*?)<\/passage>/gi)].map((p) => textOf(p[1]));
    const snippet = (passages.filter(Boolean).join(" … ") || textOf(tag(doc, "headline"))).slice(0, 400);
    hits.push({ title: textOf(tag(doc, "title")) || domain, url, snippet, domain });
  }
  return {
    hits,
    found: foundAll === undefined ? null : Number(foundAll),
    errorCode: err ? Number(err[1]) : null,
  };
}

/** XML of the JSON answer {rawData: base64}. */
export function decodeRawData(json: unknown): string {
  const raw = (json as { rawData?: unknown } | null)?.rawData;
  if (typeof raw !== "string")
    throw new ResearchError("SEARCH_FAILED", "Поиск вернул ответ без результатов.");
  return Buffer.from(raw, "base64").toString("utf8");
}

/** HTTP status of a failed search → error (server messages are not passed on: they may name the folder). */
export function searchHttpError(status: number): ResearchError {
  if (status === 401 || status === 403) {
    return new ResearchError("SEARCH_AUTH", "Ключ поиска не подошёл — поиск временно недоступен.", status);
  }
  if (status === 429) {
    return new ResearchError("SEARCH_RATE_LIMIT", "Поиск перегружен запросами — попробуйте позже.", status);
  }
  return new ResearchError("SEARCH_FAILED", `Поиск не ответил (код ${status}).`, status);
}
