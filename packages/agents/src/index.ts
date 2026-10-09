// @wizard/agents public API: shared text rules and the development-request contract; agents live in subpaths
// (./orchestrator, ./builder, ./qa, ./host, ./core).
export const PACKAGE = "@wizard/agents";

/** Honest capability gaps: categories, host contract, report_capability_gap tool and the owner-facing answer. */
export {
  type CapabilityGap,
  capabilityGapSchema,
  DEVELOPMENT_REQUEST_CATEGORIES,
  type DevelopmentRequestCategory,
  type DevelopmentRequestInput,
  type GapToolOptions,
  gapMessage,
  gapOutOfScope,
  gapsPromptSection,
  PLATFORM_CAN,
  PLATFORM_LIMITS,
  type RecordDevelopmentRequest,
  reportCapabilityGapTool,
  SUPPORT_BUTTON,
} from "./gaps.js";
/** Integrations harness (V3-20): documentation → contract → typed client → mock and contract tests → key check; full API at ./integrations. */
export {
  checkContractKey,
  contractFromDocs,
  contractFromOpenApi,
  type IntegrationContract,
  integrationCode,
  integrationsHook,
  mockTransport,
  runContractTests,
} from "./integrations/index.js";
/** Agent research (V3-05, builder-v3.md C8): web_search (Yandex Search API), read_page, discover_docs; limits, cache, journal. */
export {
  createResearch,
  type DocIndexEntry,
  MemoryResearchLog,
  MemoryResearchStore,
  type PageResult,
  RESEARCH_LIMITS,
  type Research,
  type ResearchCall,
  ResearchError,
  type ResearchLog,
  type ResearchOptions,
  type ResearchStore,
  researchTools,
  SEARCH_RUB_PER_REQUEST,
  type SearchResult,
  searchStatus,
} from "./research/index.js";
/** Shared rules for text written for people (D48, D49): chat — to the owner, system — inside client systems. */
export { type TextRulesKind, textRules, textRulesSection } from "./text-rules.js";
