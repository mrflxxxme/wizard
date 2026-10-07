export const PACKAGE = "@wizard/appspec";

/** aiAction input/output shape (M3-02): resolveAiAction → entity, source and target fields; aiTargetFields per entity. */
export {
  AI_EXTRACT_TYPES,
  AI_GENERATE_TYPES,
  AI_INPUT_TYPES,
  AI_INSTRUCTION_MAX,
  type AiActionProblem,
  aiTargetFields,
  type ResolvedAiAction,
  resolveAiAction,
} from "./ai-actions.js";
/** diffSpecs(prev|null, next) → human changes {kind, text_ru, destructive?} for getRevisionDiff (M1-04). */
export { diffSpecs, type SpecChange, type SpecChangeKind } from "./diff.js";
export { ERROR_CODES, type OpsError, type OpsErrorCode, pointer } from "./errors.js";
/** Index model for `where`/`getBy` (sdk.md §2.4): usable indexes, unique fields, where → index resolution. */
export { entityIndexes, isRangeValue, resolveIndex, SYSTEM_FIELD_NAMES, uniqueFields } from "./indexes.js";
/**
 * M2-72 destructive changes in prod: destructiveChanges(plan) — what the owner confirms; destructiveCountSql — affected
 * rows on the live schema; toDDL(..., {archive}) — removed data goes to archiveSchemaName(schema), undo restores it.
 */
export {
  type ArchiveOptions,
  archiveSchemaName,
  archiveTableName,
  archiveTables,
  type DdlOptions,
  DEFAULT_MAX_LENGTH,
  type DestructiveChange,
  type DestructiveKind,
  describeStep,
  destructiveChanges,
  destructiveCountSql,
  dropSystemRoleDDL,
  type MigrationPlan,
  type MigrationStep,
  type PlanOptions,
  planMigration,
  quoteLiteral,
  type StepKind,
  SYSTEM_INDEXES,
  SYSTEM_ROLE,
  SYSTEM_TABLES,
  type SystemIndex,
  type SystemRoleOptions,
  sqlType,
  systemIndexDDL,
  systemRoleName,
  toDDL,
  toRLS,
  toSystemRoleDDL,
} from "./migrate.js";
/** B2-10 plan errors: PlanError {code, path, message_ru} with the closed PLAN_ERROR_CODES set. */
export { PLAN_ERROR_CODES, type PlanError, type PlanErrorCode } from "./modules/errors.js";
/** B2-10 closed vocabulary of business goals: GOALS {id, label}, goalIdSchema, goalLabel(id). */
export { GOAL_IDS, GOALS, type GoalId, goalIdSchema, goalLabel } from "./modules/goals.js";
/** B2-10 module manifests (specs/modules/modules.yaml#manifest): schema, parameters, conditions, catalog check. */
export {
  type CatalogResult,
  type Condition,
  conditionSchema,
  EXTRA_FIELD_TYPES,
  evalCondition,
  extraFieldSchema,
  type GoalScenario,
  goalScenarioSchema,
  goalsOf,
  METRIC_UNITS,
  type ModuleFragments,
  type ModuleManifest,
  type ModuleMetric,
  metricSchema,
  moduleManifestSchema,
  PARAM_TYPES,
  type ParamSpec,
  paramSpecSchema,
  paramsSchema,
  paramValueSchema,
  resolveParams,
  SCENARIO_ACTORS,
  SCENARIO_EXPECT_KINDS,
  validateModuleCatalog,
} from "./modules/manifest.js";
/** B2-10 SystemPlan: schema, D76 custom limits and validateSystemPlan(plan, catalog) → Russian errors. */
export {
  CUSTOM_LIMITS,
  DESIGN_PINS,
  DESIGN_RHYTHMS,
  DESIGN_VOICES,
  MAX_PLAN_GOALS,
  MAX_PLAN_PHOTOS,
  type ModuleCatalog,
  OUT_OF_SCOPE_CATEGORIES,
  type PlanPhoto,
  type PlanSection,
  planPhotoSchema,
  SECTION_BANDS,
  STOCK_PROVIDERS,
  type SystemPlan,
  systemPlanSchema,
  type ValidatePlanOptions,
  type ValidatePlanResult,
  validateSystemPlan,
} from "./modules/plan.js";
/** B2-10 landing section library (draft until B2-35): types, layout variants, content keys. */
export { SECTION_CATALOG, type SectionTypeSpec } from "./modules/sections.js";
export {
  type ApplyOpsFailure,
  type ApplyOpsOptions,
  type ApplyOpsResult,
  type ApplyOpsSuccess,
  applyOps,
  DESTRUCTIVE_OPS,
  emptySpec,
  type IdempotencyStore,
  LruIdempotencyStore,
  MAX_BATCH,
  OP_NAMES,
  type Op,
  type OpName,
  OWNER_ONLY_COMPLIANCE_FIELDS,
  opSchema,
  type Revision,
} from "./ops.js";
/**
 * ПДн-like field names (abuse.yaml#patterns.pii_field_names, B2-46): piiNameReason(field, subject) is the one criterion
 * of G2-PII-02 and of module extra fields; unicodeRx/normalizeText/splitIdent/firstMatch are abuse.yaml matching.
 */
export {
  fieldPiiCategory,
  firstMatch,
  isPiiSubject,
  normalizeText,
  PII_NAME_PATTERNS,
  type PiiNameReason,
  piiKindFor,
  piiNameReason,
  splitIdent,
  unicodeRx,
} from "./pii-names.js";
export { isReservedName, RESERVED_NAMES, SQL_KEYWORDS, SYSTEM_FIELDS, USERS_ENTITY } from "./reserved.js";
export * from "./schema.js";
export { MAX_INDEX_FIELDS, ROW_FILTER_USER_ATTRS, type ValidateOptions } from "./semantic.js";
export {
  dollarQuote,
  type LiteralType,
  literalProblem,
  MAX_IDENT_BYTES,
  quoteIdent,
  SqlValueError,
  sqlLiteral,
  textLiteral,
} from "./sql.js";
/** `_generated/wizard.d.ts` generator (sdk.md §4); @wizard/sdk/codegen re-exports it (L2-17). */
export { type GenerateTypesOptions, generateTypes } from "./types-gen.js";
