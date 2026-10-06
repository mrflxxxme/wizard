export const PACKAGE = "@wizard/llm";

export { BALANCE_BLOCK_MS, CircuitBreaker } from "./circuit.js";
export { LlmError, type LlmErrorCode } from "./errors.js";
export {
  briefHash,
  type CanonicalInput,
  type CanonicalTool,
  canonicalRequest,
  type FixtureLine,
  type FixtureRequest,
  FixtureStore,
  type FixtureSuite,
  loadAllowedBriefHashes,
  requestKey,
  schemaHash,
  stableStringify,
  withoutAttachmentBytes,
} from "./fixtures.js";
/** import_mapping call over a SyntheticPayload only (data-boundary.yaml#import); mapping per api.yaml#ImportColumnMapping. */
export {
  IMPORT_MAPPING_TOOL,
  type ImportColumnMapping,
  type ImportEntityRef,
  type ImportMappingInput,
  type ImportMappingOutput,
  importMappingMessages,
  routeImportMapping,
} from "./import-mapping.js";
/** Org policy changes: PolicyBus/orgPolicyBus (in-process pub/sub), PolicyCache (TTL ≤ 10 s), forbidsT1. */
export {
  createPolicyCache,
  forbidsT1,
  orgPolicyBus,
  POLICY_CACHE_TTL_MS,
  PolicyBus,
  type PolicyCache,
  type PolicyCacheOptions,
  type PolicyChange,
  type PolicyListener,
} from "./org-policy.js";
export {
  assertNoTokens,
  assertTierAllowed,
  containsTokens,
  type Dlp,
  decideTier,
  hasAttachments,
  isCallType,
  type PolicyDecision,
  t1Forbidden,
} from "./policy.js";
export { isBalanceError, type LiveErrorCode, transformBody } from "./providers.js";
export {
  BUILD_TIER_ENV,
  buildDefaultTierFromEnv,
  buildModelLabel,
  createRegistry,
  DEFAULT_BUILD_TIER,
  getModel,
  HIGH_REASONING,
  MODELS,
  type ModelDef,
  PII_FORBIDDEN_FOR_T1,
  PROVIDERS,
  type ProviderDef,
  type ProviderId,
  policyVersion,
  type Registry,
  ROUTES,
  type RouteDef,
  RU_BUILD_LABEL,
} from "./registry.js";
export {
  createRouter,
  type FixtureOptions,
  type ProviderDegraded,
  type Router,
  type RouterOptions,
  route,
} from "./router.js";
/** Runtime AI actions (runtime.yaml#ai_actions, M3-02): T0-only extract/generate over one record; plain-text output. */
export {
  FILL_FIELDS_TOOL_NAME,
  fillFieldsTool,
  GENERATE_MAX_CHARS,
  normalizeAiValue,
  type RuntimeAiAction,
  type RuntimeAiField,
  type RuntimeAiInput,
  type RuntimeAiOutput,
  type RuntimeAiValue,
  routeRuntimeAi,
  runtimeAiCallType,
  runtimeAiMessages,
  toPlainText,
} from "./runtime-ai.js";
export {
  CALL_TYPES,
  type CallType,
  type LlmAttachment,
  type LlmEvent,
  type LlmMessage,
  type LlmMode,
  type LlmResult,
  type LlmTool,
  type LlmUsage,
  type OrgPolicy,
  type PiiCounts,
  ROUTE_REASONS,
  type RouteContext,
  type RouteInput,
  type RouteOutput,
  type RouteReason,
  type RuntimeAiCallType,
  type Tier,
  type ToolCall,
  type UsageRecord,
  type UsageSink,
} from "./types.js";
export { costRub, creditsMilli, JsonlUsageSink, MemoryUsageSink } from "./usage.js";
