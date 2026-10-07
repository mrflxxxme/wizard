// @wizard/agents/builder: specs/agents/builder.yaml — runBuild(host, {card, cap, mode}) and its tools.

/** B2-38 stock client: queries from the niche and the photo style, Pexels and Pixabay, fixtures without the network. */
export {
  createStockClient,
  STOCK_HOSTS,
  STOCK_LICENSES,
  STOCK_PROVIDERS,
  STOCK_SECRET_REFS,
  StockCache,
  type StockClient,
  type StockClientOptions,
  StockError,
  type StockHit,
  type StockProvider,
} from "../stock/client.js";
export {
  FIXTURE_KEYS,
  fixtureImage,
  fixtureStockFetch,
  recordingStockFetch,
  STOCK_FIXTURES_DIR,
} from "../stock/fixtures.js";
export {
  NICHE_TERMS,
  nicheTerms,
  STYLE_TERMS,
  type StockQuery,
  stockQuery,
  styleTerms,
} from "../stock/query.js";
export { raiseStep, upperBoundCredits } from "./budget.js";
export {
  answerFromCard,
  DEFAULT_LIMITS,
  ESCALATION_OPTIONS,
  POINT_EDIT_MAX_STEPS,
  RETRY_EXTRA_STEPS,
  runBuild,
} from "./builder.js";
export { abbreviate, BuilderContext, MAX_CHARS, MIN_CHARS, outline } from "./context.js";
export { humanDiff, humanDiffFiles, OP_TEMPLATES } from "./diff.js";
export { cardDigest, HIDDEN_MASK, maskSpec, OPERATOR_MASK, specDigest } from "./digest.js";
export {
  CAPABILITY_IDS,
  type CapabilityCard,
  capabilityDoc,
  capabilityToc,
  SDK_TOPICS,
  sdkDocs,
  UI_KIT_COMPONENTS,
  uiKitDocs,
} from "./docs.js";
export {
  createMemoryHost,
  executeBuild,
  type MemoryHost,
  type MemoryHostOptions,
  type MemoryRevision,
  type RecordedEvent,
} from "./memory-host.js";
export { STATIC_PROMPT } from "./prompt.js";
export {
  builderTools,
  EXTRA_BUILDER_TOOLS,
  MAX_FILE_BYTES,
  type PlanStep,
  planStepSchema,
  submitPlanTool,
  type ToolEnv,
  WRITE_PATH_RE,
} from "./tools.js";
export type * from "./types.js";
/** B2-23: custom code of the plan's custom parts on top of the compiled draft, within the limits; failures isolated. */
export {
  buildCustom,
  type CustomInput,
  type CustomPartResult,
  type CustomStageResult,
  customFixText,
  customInputSchema,
  customIssues,
  customMessages,
  customReplacementRu,
  implicated,
  mergeCustom,
  runCustomStage,
  selectCustomSlots,
} from "./v2/custom.js";
/** Builder v2 (B2-21, builder.yaml#v2): an approved system plan in stages with checkpoints and stage budgets. */
export {
  brandAccent,
  type DesignInput,
  designInputSchema,
  designIssues,
  designMessages,
  mergeDesign,
  runDesignStage,
} from "./v2/design.js";
/**
 * Design direction (B2-37): theme layouts, checks (themeLint, contrast), polish, fallback by niche, palette from the
 * accent, the direction view and the diversity metric over directions.
 */
export {
  accentProblems,
  type DesignDirection,
  type DesignVoice,
  DISPLAY_ONLY_FONTS,
  type DirectionDiversity,
  type DirectionPalette,
  designDirection,
  designLintIssues,
  directionDistance,
  directionDiversity,
  directionKey,
  directionPalette,
  fallbackDesign,
  keeps,
  polishDirection,
  themeLayouts,
  themeRhythm,
  themeVoice,
  VOICE_LABELS,
} from "./v2/direction.js";
/** B2-38 photos stage: stock pictures for the landing slots (no models), copies in the platform photo library. */
export { PHOTOS_TIME_BUDGET_MS, type PhotoHost, type PhotosOutcome, runPhotosStage } from "./v2/photos.js";
export { buildBlockers, OWNER_INPUT_CHECKS, runBuildV2, withOwnerFields } from "./v2/run.js";
export { DEFAULT_V2_BUDGETS, remainingSec, STAGE_ETA_SEC, STAGE_LABELS } from "./v2/stages.js";
export {
  mergeTexts,
  runTextsStage,
  type TextsInput,
  textsInputSchema,
  textsIssues,
  textsMessages,
} from "./v2/texts.js";
export {
  type CheckpointStore,
  type CustomStageFn,
  type StageCheckpoint,
  type StageMetric,
  V2_STAGES,
  type V2Budgets,
  type V2FailureCode,
  type V2GateLevel,
  type V2Host,
  type V2Outcome,
  type V2Params,
  type V2Stage,
} from "./v2/types.js";
export { StageBudgetError, StageWallet } from "./v2/wallet.js";
