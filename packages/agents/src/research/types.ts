// Shared types of agent research (specs/agents/builder-v3.md §3 C8): errors, fetch signature, results, journal.

/** fetch as research uses it: a standard `fetch` fits (search), so does the guarded transport and a recorded one. */
export type ResearchFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** All A/AAAA addresses of a host. */
export type Resolver = (host: string) => Promise<string[]>;

/** live — real network (pages, and search when the key is set); fixture — recorded answers only, never the network. */
export type ResearchMode = "live" | "fixture";

export type ResearchTool = "web_search" | "read_page" | "discover_docs";

export type ResearchErrorCode =
  | "SEARCH_DISABLED"
  | "SEARCH_LIMIT"
  | "PAGE_LIMIT"
  | "DISCOVER_LIMIT"
  | "QUERY_EMPTY"
  | "URL_INVALID"
  | "SCHEME_FORBIDDEN"
  | "EGRESS_PRIVATE"
  | "DNS_FAILED"
  | "ROBOTS_DISALLOWED"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS"
  | "HTTP_ERROR"
  | "UNSUPPORTED_TYPE"
  | "SEARCH_AUTH"
  | "SEARCH_RATE_LIMIT"
  | "SEARCH_FAILED"
  | "FIXTURE_MISSING"
  | "NETWORK";

/** A refusal or failure of a research call; `message` is Russian (it reaches the model and may reach the owner). */
export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  /** HTTP status of the upstream answer, when there was one. */
  readonly status: number | null;
  constructor(code: ResearchErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
    this.status = status;
  }
}

/** One organic result of the search. */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface SearchResult {
  /** The query as it was sent: personal data removed (packages/pii scrub). */
  query: string;
  hits: SearchHit[];
  /** Total documents found as the engine reports it (null when absent). */
  found: number | null;
  cached: boolean;
  /** Paid searches left in this build. */
  remaining: number;
}

export interface PageResult {
  /** The requested address. */
  url: string;
  /** The address after redirects. */
  finalUrl: string;
  title: string;
  /** Main content as markdown (HTML pages through Readability + Turndown; text formats as they are). */
  markdown: string;
  contentType: string;
  /** Bytes downloaded (after decompression). */
  bytes: number;
  /** The markdown was cut at the size limit. */
  truncated: boolean;
  cached: boolean;
}

/** Limits of one build (D77 (15); builder-v3.md §3 C8). Cached answers are not counted. */
export interface ResearchLimits {
  /** Paid search requests (Yandex Search API). */
  searches: number;
  /** Page reads (read_page). */
  pages: number;
  /** Documentation discoveries (discover_docs), one per domain. */
  discover: number;
}

export interface ResearchUsage {
  searches: number;
  pages: number;
  discover: number;
  cacheHits: number;
  refused: number;
  /** Estimated search spend, ₽ (SEARCH_RUB_PER_REQUEST per answered request). */
  costRub: number;
}

/** Who the calls belong to (the same keys as platform.llm_calls). */
export interface ResearchContext {
  runId?: string | null;
  orgId?: string | null;
  systemId?: string | null;
}

/**
 * One journal row of a research call, shaped like platform.llm_calls (never query text or page content: a hash of
 * the request, the host and counts only).
 */
export interface ResearchCall {
  id: string;
  createdAt: string;
  runId: string | null;
  orgId: string | null;
  systemId: string | null;
  tool: ResearchTool;
  status: "ok" | "cached" | "error" | "refused";
  errorCode: ResearchErrorCode | null;
  costRub: number;
  latencyMs: number;
  mode: ResearchMode;
  /** sha256 of the normalized request (query + region + page, or the URL). */
  requestHash: string;
  /** Host of the page or domain; "searchapi" for search. */
  host: string | null;
  /** Hits, markdown characters or documentation sources found. */
  results: number;
  /** Personal data was removed from the query before sending. */
  scrubbed: boolean;
  piiCategoriesCount: Record<string, number>;
}

/** Journal of research calls; platform-api maps rows into platform.llm_calls (callType research, C7). */
export interface ResearchLog {
  write(call: ResearchCall): void | Promise<void>;
}
