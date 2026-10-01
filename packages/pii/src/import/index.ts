// @wizard/pii/import — table import on the data boundary (data-boundary.yaml#import, L3-37).

/** buildMappingPayload(table) → SyntheticPayload: the only import data allowed to reach T1 (import_mapping). */
export {
  buildMappingPayload,
  isSyntheticPayload,
  MAX_SYNTHETIC_ROWS,
  type MappingPayloadOptions,
  type SyntheticColumn,
  type SyntheticPayload,
  type SyntheticSheet,
} from "./payload.js";
/** Value-free column profiles (type, pattern, shares, piiKindGuess, rounded min/max); raw headers included. */
export {
  type ColumnProfile,
  type InferredType,
  profileColumn,
  profileSheet,
  profileTable,
  type SheetProfile,
  shapeOf,
} from "./profile.js";
/** readTable(bytes, {filename, limits}) → Table: xlsx (cached values only, no formulas/external links/macros) or csv. */
export { type ReadTableOptions, readTable } from "./read.js";
/** Parsed table, cell values, limits (20 MB file, 100 MB unpacked, 1 M cells) and ImportError (413/400). */
export {
  type Cell,
  IMPORT_LIMITS,
  ImportError,
  type ImportErrorCode,
  type ImportLimits,
  type Sheet,
  type Table,
} from "./types.js";
/** writeXlsx(sheets, opts) — minimal xlsx writer for fixtures and tests. */
export { type FormulaCell, type WriteXlsxOptions, writeXlsx, type XlsxSheetInput } from "./xlsx-write.js";
