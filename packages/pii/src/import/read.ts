// readTable(): xlsx or csv → Table, within ImportLimits (api.yaml#createImport, L3-37).
import { readCsv } from "./csv.js";
import { IMPORT_LIMITS, ImportError, type ImportLimits, type Table } from "./types.js";
import { readXlsx } from "./xlsx.js";
import { isZip } from "./zip.js";

export interface ReadTableOptions {
  /** Used only to refuse legacy formats early and to name a csv sheet. */
  filename?: string;
  limits?: Partial<ImportLimits>;
}

export function readTable(bytes: Uint8Array, opts: ReadTableOptions = {}): Table {
  const limits: ImportLimits = { ...IMPORT_LIMITS, ...opts.limits };
  if (bytes.length > limits.maxFileBytes) {
    throw new ImportError("FILE_TOO_LARGE", "Файл больше 20 МБ.");
  }
  const name = opts.filename?.toLowerCase() ?? "";
  // OLE compound file (.xls) and other binary formats are not supported.
  if ((bytes[0] === 0xd0 && bytes[1] === 0xcf) || /\.(?:xls|xlsb|ods|numbers)$/.test(name)) {
    throw new ImportError("UNSUPPORTED_FORMAT", "Поддерживаются только файлы .xlsx и .csv.");
  }
  if (isZip(bytes)) return { format: "xlsx", sheets: readXlsx(bytes, limits) };
  const base = opts.filename?.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return { format: "csv", sheets: readCsv(bytes, limits, base || "Лист1") };
}
