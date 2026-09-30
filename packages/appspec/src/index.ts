export const PACKAGE = "@wizard/appspec";

export { ERROR_CODES, type OpsError, type OpsErrorCode, pointer } from "./errors.js";
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
export { ROW_FILTER_USER_ATTRS, type ValidateOptions } from "./semantic.js";
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
export { generateTypes } from "./types-gen.js";
