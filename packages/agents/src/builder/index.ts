// @wizard/agents/builder: specs/agents/builder.yaml — runBuild(host, {card, cap, mode}) and its tools.
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
