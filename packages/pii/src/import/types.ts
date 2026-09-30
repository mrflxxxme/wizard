// Parsed tables and import limits (data-boundary.yaml#import, api.yaml#createImport, L3-37).

/** A cell value: xlsx keeps numbers and booleans, dates become ISO strings; csv yields strings. */
export type Cell = string | number | boolean | null;

export interface Sheet {
  name: string;
  /** First non-empty row; empty header cells are "". */
  header: string[];
  /** Data rows, padded with null to the header width. */
  rows: Cell[][];
}

export interface Table {
  format: "xlsx" | "csv";
  sheets: Sheet[];
}

export interface ImportLimits {
  /** Uploaded file size (api.yaml#createImport: ≤ 20 MB). */
  maxFileBytes: number;
  /** Total decompressed size of the xlsx parts that are read (≤ 100 MB). */
  maxUnpackedBytes: number;
  /** Cells across all sheets (≤ 1 000 000). */
  maxCells: number;
}

export const IMPORT_LIMITS: Readonly<ImportLimits> = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxUnpackedBytes: 100 * 1024 * 1024,
  maxCells: 1_000_000,
});

export type ImportErrorCode =
  | "FILE_TOO_LARGE"
  | "UNPACKED_TOO_LARGE"
  | "TOO_MANY_CELLS"
  | "UNSUPPORTED_FORMAT"
  | "BAD_FILE";

const SIZE_CODES: ReadonlySet<ImportErrorCode> = new Set([
  "FILE_TOO_LARGE",
  "UNPACKED_TOO_LARGE",
  "TOO_MANY_CELLS",
]);

/** Import failure; `httpStatus` is 413 for the size limits (api.yaml#createImport), 400 otherwise. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly httpStatus: 400 | 413;
  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.httpStatus = SIZE_CODES.has(code) ? 413 : 400;
  }
}

export const tooManyCells = (limit: number): ImportError =>
  new ImportError("TOO_MANY_CELLS", `В таблице больше ${limit.toLocaleString("ru-RU")} ячеек.`);

export const badFile = (): ImportError =>
  new ImportError(
    "BAD_FILE",
    "Не удалось прочитать файл. Сохраните его как .xlsx или .csv и загрузите снова.",
  );
