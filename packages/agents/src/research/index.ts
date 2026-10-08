// @wizard/agents research (V3-05, builder-v3.md §3 C8): tools web_search, read_page, discover_docs.
export {
  type ApiOperation,
  DOC_LIMITS,
  DOC_PATHS,
  DocIndex,
  type DocIndexEntry,
  type DocSource,
  type DocSourceKind,
  docsView,
  type LlmsTxt,
  type OpenApiSummary,
  originOf,
  parseApiCatalog,
  parseLlmsTxt,
  parseSitemap,
  type SitemapSummary,
  summarizeOpenApi,
} from "./discover.js";
export {
  guardedTransport,
  isPrivateAddress,
  parseHttpUrl,
  RESEARCH_BOT,
  RESEARCH_USER_AGENT,
  systemResolver,
} from "./net.js";
export { htmlToMarkdown, PAGE_MAX_CHARS } from "./page.js";
export {
  exchangeKey,
  maskSecrets,
  type RecordedExchange,
  recordedFetch,
  recordingFetch,
} from "./recorded.js";
export {
  createResearch,
  PAGE_MAX_BYTES,
  RESEARCH_LIMITS,
  RESEARCH_MODE_ENV,
  type Research,
  type ResearchOptions,
  type ResearchStatus,
  researchMode,
  type SearchOptions,
  searchQueryText,
  searchStatus,
} from "./research.js";
export { parseRobots, type Robots } from "./robots.js";
export { MemoryResearchLog, MemoryResearchStore, RESEARCH_TTL_MS, type ResearchStore } from "./store.js";
export { READ_PAGE_DEFAULT_CHARS, researchTools } from "./tools.js";
export {
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
export {
  parseYandexXml,
  SEARCH_FOLDER_ENV,
  SEARCH_KEY_ENV,
  SEARCH_RUB_PER_REQUEST,
  YANDEX_SEARCH_ENDPOINT,
  yandexSearchBody,
} from "./yandex.js";
