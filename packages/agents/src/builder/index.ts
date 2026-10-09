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
  RECORDED_PROVIDERS,
  recordedFile,
  recordingStockFetch,
  STOCK_FIXTURES_DIR,
  sanitizeStockAnswer,
  scrubSecrets,
} from "../stock/fixtures.js";
/** B2-43 photo library filled from CI: its index and the stock client of WIZARD_STOCK_MODE=library (no network). */
export {
  CATALOG_NICHES,
  createLibraryStockClient,
  emptyLibraryIndex,
  LIBRARY_INDEX_TTL_MS,
  LIBRARY_INDEX_VERSION,
  LIBRARY_MAX_ENTRIES,
  LIBRARY_SLOT_KINDS,
  type LibraryEntry,
  type LibraryIndex,
  type LibraryStockClient,
  libraryCap,
  libraryCount,
  librarySearch,
  librarySeedQueries,
  mergeLibraryIndex,
  parseLibraryIndex,
  planSeedQueries,
  querySubject,
  type SeedQuery,
  serializeLibraryIndex,
} from "../stock/library.js";
export {
  GENERIC_TERMS,
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
export {
  fitsSlot,
  PHOTOS_TIME_BUDGET_MS,
  type PhotoHost,
  type PhotosOutcome,
  runPhotosStage,
} from "./v2/photos.js";
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
/** V3-07 art director: three candidate directions by code; the model picks one via submit_art_direction, or fallback. */
export {
  ACCENT_USES,
  ART_DIRECTION_CALL_TYPE,
  type ArtDirection,
  type ArtDirectionAnswer,
  type ArtDirectionCandidate,
  type ArtDirectionChoice,
  type ArtDirectorInput,
  artDirectionCandidates,
  artDirectionIssues,
  artDirectionMessages,
  artDirectionSchema,
  runArtDirector,
} from "./v3/art-director.js";
/**
 * V3-12 page composer (builder-v3.md C6): createPageComposer() → PageComposer {skeleton — the public site from library
 * patterns without a model; scenario — page_compose and ≤ 2 signature sections, checked by the anti-slop linter and
 * G0}; lintPage/copyIssues — the anti-slop linter; withSitePages — the spec with the composed pages.
 */
export {
  COMPOSE_CALL_TYPES,
  type CopyIssue,
  copyIssues,
  createPageComposer,
  lintPage,
  type PageComposerOptions,
  type PageLintCode,
  type PageLintIssue,
  readSite,
  SITE_PATH,
  type SiteModel,
  type SitePage,
  withSitePages,
} from "./v3/compose/index.js";
/** V3-11/V3-12 seam (builder-v3.md C6): the harness calls a PageComposer; the page writer implements it. */
export type {
  PageComposer,
  SystemFiles,
  V3BuildContext,
  V3ComposeResult,
  V3PagePlan,
} from "./v3/contract.js";
/**
 * V3-13 visual critic (builder-v3.md C6 stage `critic`): createCriticHook({inspect}) — deterministic browser checks
 * (CRITIC_CHECKS_SCRIPT: contrast, overflow, fonts, CLS, touch, names, headings) and fixes by code first, then ≤ 3
 * critic_visual cycles on screenshots 390/768/1440 by the catalog C rubric with closed edits (applyEdit), each re-checked.
 */
export * from "./v3/critic/index.js";
/** V3-09 «Три направления»: three first screens with the client's texts, refinement by words, references → principles. */
export * from "./v3/directions/index.js";
/**
 * V3-11 build harness (builder-v3.md C6): runBuildV3(host, params) — brief → design → backend → skeleton (preview) →
 * scenarios one by one with a browser check → critic/template_gate/techreview hooks → gates; checkpoints, wallet, clock.
 */
export {
  type BackendBuilt,
  type BackendResult,
  compileBackend,
  DESIGN_CSS_FILE,
  designCss,
} from "./v3/harness/backend.js";
export {
  featureList,
  featureTitle,
  goalScenariosFor,
  MAX_GOAL_SCENARIOS,
  type V3Feature,
} from "./v3/harness/features.js";
export { type BriefPlan, briefNiche, briefPlan, briefText } from "./v3/harness/plan.js";
export { briefAnswers, mergeAnswers, optionLabel, questionText } from "./v3/harness/questions.js";
export {
  DEFAULT_V3_BUDGETS,
  spendLine,
  V3_BUILD_LIMITS,
  V3_STAGE_ETA_SEC,
  V3_STAGE_LABELS,
} from "./v3/harness/stages.js";
export {
  type ScenarioCheckInput,
  type ScenarioCheckResult,
  V3_HOOK_STAGES,
  V3_STAGES,
  type V3BriefVersion,
  type V3Budgets,
  type V3BuildQuestion,
  type V3Checkpoint,
  type V3CheckpointStore,
  type V3FailureCode,
  type V3GateLevel,
  type V3HookResult,
  type V3HookStage,
  type V3Host,
  type V3Limits,
  type V3Outcome,
  type V3Params,
  type V3QuestionAnswer,
  type V3ReadyNotice,
  type V3ScenarioState,
  type V3Stage,
  type V3StageHook,
  type V3StageMetric,
  type V3StopReason,
} from "./v3/harness/types.js";
export { milliRub, V3BudgetError, V3Wallet } from "./v3/harness/wallet.js";
export { runBuildV3, stopMessage } from "./v3/run.js";
/**
 * V3-15 techreview (builder-v3.md C6 stage 7, D77 (10)): createTechreview(deps) — the hook of stage techreview: the
 * deterministic part first (G0 and the static G2 on the uncommitted system, the migration dry run, RLS, ПДн, integration
 * contracts, module chains, performance and accessibility), then a reviewer of another model family (submit_techreview,
 * a closed set of findings), ≤ 2 rounds of safe fixes; blockers → the system is not published.
 */
export * from "./v3/techreview/index.js";
