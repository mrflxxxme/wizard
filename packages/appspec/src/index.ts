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
  SYSTEM_ROLE,
  SYSTEM_TABLES,
  type SystemRoleOptions,
  sqlType,
  systemRoleName,
  toDDL,
  toRLS,
  toSystemRoleDDL,
} from "./migrate.js";
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
