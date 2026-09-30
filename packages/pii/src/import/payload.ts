// SyntheticPayload (data-boundary.yaml#import.payload): the only form of an imported table allowed to reach T1.
// Built exclusively here: scrubbed headers/sheet names, value-free column profiles and ≤ 5 synthetic rows generated
// by @faker-js/faker (ru) from the profile. No real value is copied; every string passes detect() with 0 findings.
import { base, en, Faker, ru } from "@faker-js/faker";
import { detect } from "../detect.js";
import { isPlaceholder, type PiiKind } from "../types.js";
import { type ColumnProfile, type InferredType, profileSheet, type SheetProfile } from "./profile.js";
import type { Cell, Sheet, Table } from "./types.js";

declare const SYNTHETIC: unique symbol;

export interface SyntheticColumn {
  /** Header after scrub: a header with a finding (or empty/duplicate) becomes col_<n>. */
  header: string;
  inferredType: InferredType;
  pattern: string | null;
  checksumValidShare: number | null;
  nullShare: number;
  distinctRatio: number;
  avgLength: number;
  piiKindGuess: PiiKind | null;
  min?: number;
  max?: number;
  summary?: string;
}

export interface SyntheticSheet {
  /** Sheet name after scrub: with a finding → sheet_<n>. */
  name: string;
  columns: SyntheticColumn[];
  /** ≤ 5 rows, aligned with `columns`. */
  syntheticRows: Cell[][];
}

/** Branded: only buildMappingPayload() creates it (deep-frozen, registered). */
export type SyntheticPayload = { readonly sheets: readonly Readonly<SyntheticSheet>[] } & {
  readonly [SYNTHETIC]: true;
};

export interface MappingPayloadOptions {
  /** Faker seed (deterministic output in tests). */
  seed?: number;
  /** Synthetic rows per sheet, capped at 5. */
  rows?: number;
}

export const MAX_SYNTHETIC_ROWS = 5;

const issued = new WeakSet<object>();

/** True only for objects returned by buildMappingPayload() in this process. */
export function isSyntheticPayload(x: unknown): x is SyntheticPayload {
  return typeof x === "object" && x !== null && issued.has(x);
}

const PLACEHOLDER_STEM: Record<PiiKind, string> = {
  fio: "ФИО",
  phone: "ТЕЛЕФОН",
  email: "EMAIL",
  address: "АДРЕС",
  birthdate: "ДАТА_РОЖДЕНИЯ",
  passport: "ПАСПОРТ",
  snils: "СНИЛС",
  inn: "ИНН",
  card: "КАРТА",
  free_text: "ТЕКСТ",
  other: "ПДН",
};

const clean = (s: string) => detect(s).length === 0;

function syntheticValue(f: Faker, col: ColumnProfile, n: number): Cell {
  if (col.piiKindGuess) return `[${PLACEHOLDER_STEM[col.piiKindGuess]}_${n}]`;
  const lo = col.min ?? 1;
  const hi = col.max !== undefined && col.max > lo ? col.max : lo + 100;
  switch (col.inferredType) {
    case "empty":
      return null;
    case "integer":
      return f.number.int({ min: Math.ceil(lo), max: Math.floor(hi) });
    case "number":
      return f.number.float({ min: lo, max: hi, fractionDigits: 2 });
    case "boolean":
      return f.datatype.boolean();
    case "date":
      return f.date.between({ from: "2020-01-01", to: "2026-12-31" }).toISOString().slice(0, 10);
    case "datetime":
      return f.date.between({ from: "2020-01-01", to: "2026-12-31" }).toISOString().slice(0, 19);
    case "url":
      return f.internet.url();
    case "email":
      return `[EMAIL_${n}]`;
    case "phone":
      return `[ТЕЛЕФОН_${n}]`;
    case "free_text":
      return f.lorem.sentence({ min: 4, max: Math.min(30, Math.max(5, Math.round(col.avgLength / 7))) });
    default:
      if (col.pattern?.includes("#") && !/[БбXxL]/.test(col.pattern)) {
        return col.pattern.replace(/#/g, () => String(f.number.int(9)));
      }
      return col.avgLength > 20 ? f.commerce.productName() : f.commerce.department();
  }
}

function freeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
}

function realValues(sheet: Sheet, index: number): Set<string> {
  const out = new Set<string>();
  for (const r of sheet.rows) {
    const c = r[index];
    if (c !== null && c !== undefined) out.add(String(c).trim().toLowerCase());
  }
  return out;
}

function syntheticSheet(
  sheet: Sheet,
  profile: SheetProfile,
  sheetNo: number,
  f: Faker,
  rows: number,
): SyntheticSheet {
  const seen = new Set<string>();
  const columns = profile.columns.map((c, i): SyntheticColumn => {
    let header = c.header.trim();
    if (!header || !clean(header) || seen.has(header.toLowerCase())) header = `col_${i + 1}`;
    seen.add(header.toLowerCase());
    const pattern = c.pattern !== null && clean(c.pattern) ? c.pattern : null;
    const out: SyntheticColumn = {
      header,
      inferredType: c.inferredType,
      pattern,
      checksumValidShare: c.checksumValidShare,
      nullShare: c.nullShare,
      distinctRatio: c.distinctRatio,
      avgLength: c.avgLength,
      piiKindGuess: c.piiKindGuess,
    };
    if (c.min !== undefined) out.min = c.min;
    if (c.max !== undefined) out.max = c.max;
    if (c.summary !== undefined) out.summary = c.summary;
    return out;
  });
  const n = Math.min(rows, MAX_SYNTHETIC_ROWS, profile.rowCount);
  const reals = profile.columns.map((c) => realValues(sheet, c.index));
  const syntheticRows: Cell[][] = [];
  for (let r = 1; r <= n; r++) {
    syntheticRows.push(
      profile.columns.map((col, i) => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const v = syntheticValue(f, col, r);
          if (v === null || typeof v === "boolean") return v;
          const s = String(v);
          if (isPlaceholder(s)) return s;
          // Never a real value of this column, never anything the detector would flag.
          if (!reals[i]?.has(s.trim().toLowerCase()) && clean(s)) return v;
        }
        return `[${PLACEHOLDER_STEM.other}_${r}]`;
      }),
    );
  }
  const name = sheet.name.trim() && clean(sheet.name) ? sheet.name.trim() : `sheet_${sheetNo}`;
  return { name, columns, syntheticRows };
}

/** Every string of the payload must pass detect() with 0 findings (placeholders are not findings). */
function assertClean(payload: { sheets: SyntheticSheet[] }): void {
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (!isPlaceholder(v) && !clean(v)) throw new Error("synthetic payload failed DLP");
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk(payload);
}

/** The mapping request for import_mapping (data-boundary.yaml#import.payload); real values never enter it. */
export function buildMappingPayload(
  input: Table | Sheet | readonly Sheet[],
  opts: MappingPayloadOptions = {},
): SyntheticPayload {
  const sheets: readonly Sheet[] = Array.isArray(input)
    ? input
    : "sheets" in (input as Table)
      ? (input as Table).sheets
      : [input as Sheet];
  const f = new Faker({ locale: [ru, en, base] });
  f.seed(opts.seed ?? Math.floor(Math.random() * 2 ** 31));
  const rows = Math.max(0, Math.min(MAX_SYNTHETIC_ROWS, opts.rows ?? MAX_SYNTHETIC_ROWS));
  const payload = {
    sheets: sheets.map((s, i) => syntheticSheet(s, profileSheet(s), i + 1, f, rows)),
  };
  assertClean(payload);
  freeze(payload);
  issued.add(payload);
  return payload as unknown as SyntheticPayload;
}
