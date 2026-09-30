export const PACKAGE = "@wizard/appspec";

/** diffSpecs(prev|null, next) → human changes {kind, text_ru, destructive?} for getRevisionDiff (M1-04). */
export { diffSpecs, type SpecChange, type SpecChangeKind } from "./diff.js";
export { ERROR_CODES, type OpsError, type OpsErrorCode, pointer } from "./errors.js";
/** Index model for `where`/`getBy` (sdk.md §2.4): usable indexes, unique fields, where → index resolution. */
export { entityIndexes, isRangeValue, resolveIndex, SYSTEM_FIELD_NAMES, uniqueFields } from "./indexes.js";
export {
  type DdlOptions,
  DEFAULT_MAX_LENGTH,
  describeStep,
  type MigrationPlan,
  type MigrationStep,
  type PlanOptions,
  planMigration,
  quoteLiteral,
  type StepKind,
  SYSTEM_ROLE,
  SYSTEM_TABLES,
  sqlType,
  toDDL,
  toRLS,
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
