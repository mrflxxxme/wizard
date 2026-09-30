// @wizard/sdk/host — execution contracts implemented by apps/runtime (and by @wizard/sdk/testing).
export { isFunctionDef, type RegisteredFunction } from "../define.js";
export { checkShape, checkValue, type FieldIssue, validateArgs } from "../validators.js";
export {
  CallMeter,
  createDbFacade,
  type DbAdapter,
  DEFAULT_LIMITS,
  type Limits,
  type RawDoc,
  type RawListQuery,
  type RawPage,
  type RawWhere,
} from "./db.js";
export {
  type CallOptionsHost,
  type CallResult,
  createFunctionHost,
  type FunctionHost,
  type FunctionHostOptions,
  isSerializationFailure,
  type ScheduledJob,
  type SchedulerAdapter,
  SYSTEM_USER,
  type TransactionRunner,
  type TxContext,
  type TxMode,
} from "./executor.js";
export { ERROR_HTTP_STATUS, type ErrorBody, toErrorResponse } from "./http.js";
export { entityIndexes, isRangeValue, resolveIndex, SYSTEM_FIELD_NAMES, uniqueFields } from "./indexes.js";
export {
  type AccessPolicy,
  type AccessSubject,
  compilePolicy,
  functionAllowsRole,
  type PermissionOp,
  type RowConstraint,
  resolveFilterValue,
  rowMatches,
  SYSTEM_ROLE,
  stripHidden,
} from "./permissions.js";
