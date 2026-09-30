// Column profiles without values (data-boundary.yaml#import.payload): the only view of an imported table that may
// leave the import process. Raw headers stay here; buildMappingPayload() scrubs them.
import { innOrgValid, innPersonValid, luhnValid, ogrnipValid, snilsValid } from "../checksums.js";
import { classifyFieldName } from "../classify.js";
import { detect } from "../detect.js";
import type { PiiKind } from "../types.js";
import type { Cell, Sheet, Table } from "./types.js";

export type InferredType =
  | "empty"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "email"
  | "phone"
  | "url"
  | "string"
  | "free_text";

export interface ColumnProfile {
  /** 0-based column position in the sheet. */
  index: number;
  /** Raw header as in the file (may contain personal data — never sent to T1 as is). */
  header: string;
  inferredType: InferredType;
  /** Shape of the most common value: # digit, Б/б Cyrillic, X/x Latin letter runs; null when not structured. */
  pattern: string | null;
  /** Share of values passing the checksum of an identifier of their length (INN, SNILS, OGRNIP, card); else null. */
  checksumValidShare: number | null;
  nullShare: number;
  distinct: number;
  distinctRatio: number;
  avgLength: number;
  piiKindGuess: PiiKind | null;
  /** Numeric columns only: min/max rounded outward to 2 significant digits. */
  min?: number;
  max?: number;
  /** free_text only: «free_text, средняя длина N». */
  summary?: string;
}

export interface SheetProfile {
  name: string;
  rowCount: number;
  columns: ColumnProfile[];
}

const SAMPLE = 500;
const share = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100) / 100);

const BOOL = new Set(["да", "нет", "true", "false", "yes", "no", "истина", "ложь", "+", "-"]);
const INT_RE = /^[-+]?\d{1,9}$/;
const NUM_RE = /^[-+]?\d{1,3}(?:[  ]?\d{3})*(?:[.,]\d+)?$|^[-+]?\d+(?:[.,]\d+)?$/;
const DATE_RE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}\.\d{4})$/;
const DATETIME_RE =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?|\d{1,2}\.\d{1,2}\.\d{4} \d{1,2}:\d{2}(?::\d{2})?)/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s()\-.]{7,}$/;
const URL_RE = /^https?:\/\/\S+$/i;

function typeOf(v: Cell): Exclude<InferredType, "empty" | "free_text"> {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number")
    return Number.isInteger(v) && Math.abs(v) < 1e9 ? "integer" : Number.isInteger(v) ? "string" : "number";
  const s = String(v).trim();
  if (BOOL.has(s.toLowerCase())) return "boolean";
  if (INT_RE.test(s) && !/^[-+]?0\d/.test(s)) return "integer";
  if (NUM_RE.test(s) && /[.,]/.test(s) && !/^0\d/.test(s)) return "number";
  if (DATETIME_RE.test(s)) return "datetime";
  if (DATE_RE.test(s)) return "date";
  if (EMAIL_RE.test(s)) return "email";
  if (URL_RE.test(s)) return "url";
  if (PHONE_RE.test(s)) {
    const digits = s.replace(/\D/g, "").length;
    if (digits >= 10 && digits <= 15) return "phone";
  }
  return "string";
}

/** Shape without content: digits → #, letter runs → one Б/б (Cyrillic), X/x (Latin), L (other scripts). */
export function shapeOf(s: string): string {
  return s
    .replace(/\d/g, "#")
    .replace(/[А-ЯЁ]/g, "Б")
    .replace(/[а-яё]/g, "б")
    .replace(/[A-Z]/g, "X")
    .replace(/[a-z]/g, "x")
    .replace(/(?![БбXx#])\p{L}/gu, "L")
    .replace(/([БбXxL])\1+/g, "$1");
}

function checksumShare(values: readonly string[]): number | null {
  const digits = values.map((v) => v.replace(/[\s-]/g, "")).filter((d) => /^\d+$/.test(d));
  const ids = digits.filter((d) => d.length >= 10 && d.length <= 19);
  if (values.length === 0 || ids.length < values.length / 2) return null;
  const valid = ids.filter((d) => {
    switch (d.length) {
      case 10:
        return innOrgValid(d);
      case 11:
        return snilsValid(d);
      case 12:
        return innPersonValid(d);
      case 15:
        return ogrnipValid(d) || luhnValid(d);
      default:
        return luhnValid(d);
    }
  }).length;
  return share(valid, values.length);
}

/** 2 significant digits, rounded away from the range (min down, max up). */
function roundOut(n: number, dir: "down" | "up"): number {
  if (n === 0) return 0;
  const mag = 10 ** Math.max(0, Math.floor(Math.log10(Math.abs(n))) - 1);
  const f = dir === "down" ? Math.floor : Math.ceil;
  return f(n / mag) * mag;
}

function numericValue(v: Cell): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[  ]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function guessPii(header: string, type: InferredType, sample: readonly string[]): PiiKind | null {
  const byKind = new Map<PiiKind, number>();
  let withPii = 0;
  for (const s of sample) {
    const kinds = new Set(detect(s).map((f) => f.piiKind));
    if (kinds.size) withPii++;
    for (const k of kinds) byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  if (type === "free_text")
    return withPii / Math.max(1, sample.length) >= 0.05 ? "free_text" : headerKind(header);
  const top = [...byKind.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] / Math.max(1, sample.length) >= 0.3) return top[0];
  if (type === "email") return "email";
  if (type === "phone") return "phone";
  return headerKind(header);
}

function headerKind(header: string): PiiKind | null {
  return header ? (classifyFieldName(header)?.piiKind ?? null) : null;
}

export function profileColumn(sheet: Sheet, index: number): ColumnProfile {
  const header = sheet.header[index] ?? "";
  const cells = sheet.rows.map((r) => r[index] ?? null);
  const present = cells.filter((c): c is Exclude<Cell, null> => c !== null && String(c).trim() !== "");
  const strings = present.map((c) => String(c).trim());
  const distinct = new Set(strings).size;
  const avgLength = strings.length
    ? Math.round(strings.reduce((a, s) => a + s.length, 0) / strings.length)
    : 0;
  const base = {
    index,
    header,
    nullShare: share(cells.length - present.length, cells.length),
    distinct,
    distinctRatio: share(distinct, strings.length),
    avgLength,
  };
  if (present.length === 0) {
    return {
      ...base,
      inferredType: "empty",
      pattern: null,
      checksumValidShare: null,
      piiKindGuess: headerKind(header),
    };
  }
  const counts = new Map<string, number>();
  for (const c of present) {
    const t = typeOf(c);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const [topType, topN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] as [InferredType, number];
  const words = strings.reduce((a, s) => a + s.split(/\s+/).length, 0) / strings.length;
  const numeric = (counts.get("integer") ?? 0) + (counts.get("number") ?? 0);
  let inferredType: InferredType = topN / present.length >= 0.9 ? topType : "string";
  if (numeric >= 0.9 * present.length) inferredType = counts.has("number") ? "number" : "integer";
  if (inferredType === "string" && (avgLength > 60 || words > 6)) inferredType = "free_text";

  const sample = strings.slice(0, SAMPLE);
  const profile: ColumnProfile = {
    ...base,
    inferredType,
    pattern: null,
    checksumValidShare: checksumShare(sample),
    piiKindGuess: guessPii(header, inferredType, sample),
  };
  if (inferredType !== "free_text" && avgLength <= 40) {
    const shapes = new Map<string, number>();
    for (const s of sample) {
      const sh = shapeOf(s);
      shapes.set(sh, (shapes.get(sh) ?? 0) + 1);
    }
    const [shape, n] = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0] as [string, number];
    if (n / sample.length >= 0.5 && shape.length <= 40) profile.pattern = shape;
  }
  if (inferredType === "integer" || inferredType === "number") {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const c of present) {
      const n = numericValue(c);
      if (n === null) continue;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    if (min <= max) {
      profile.min = roundOut(min, "down");
      profile.max = roundOut(max, "up");
    }
  }
  if (inferredType === "free_text") profile.summary = `free_text, средняя длина ${avgLength}`;
  return profile;
}

export function profileSheet(sheet: Sheet): SheetProfile {
  return {
    name: sheet.name,
    rowCount: sheet.rows.length,
    columns: sheet.header.map((_, i) => profileColumn(sheet, i)),
  };
}

export function profileTable(table: Table): SheetProfile[] {
  return table.sheets.map(profileSheet);
}
