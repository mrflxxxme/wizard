export const PACKAGE = "@wizard/llm";

export { CircuitBreaker } from "./circuit.js";
export { LlmError, type LlmErrorCode } from "./errors.js";
export {
  briefHash,
  type CanonicalInput,
  canonicalRequest,
  type FixtureLine,
  type FixtureRequest,
  FixtureStore,
  type FixtureSuite,
  loadAllowedBriefHashes,
  requestKey,
  schemaHash,
  stableStringify,
} from "./fixtures.js";
export { assertNoTokens, type Dlp, decideTier, isCallType, type PolicyDecision } from "./policy.js";
export { transformBody } from "./providers.js";
export {
  createRegistry,
  DEFAULT_BUILD_TIER,
  getModel,
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
} from "./registry.js";
export { createRouter, type FixtureOptions, type Router, type RouterOptions, route } from "./router.js";
export {
  CALL_TYPES,
  type CallType,
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
  type Tier,
  type ToolCall,
  type UsageRecord,
  type UsageSink,
} from "./types.js";
export { costRub, creditsMilli, JsonlUsageSink, MemoryUsageSink } from "./usage.js";
