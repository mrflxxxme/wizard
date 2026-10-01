// load_rows (workflows.yaml#import_table): real values go into app_<key>_draft without any LLM, in batches of 1000,
// as the migrator role with the system role context (like seed_draft). Fully qualified names, parameters only.
import {
  type AppSpec,
  DEFAULT_MAX_LENGTH,
  type Field,
  type LiteralType,
  literalProblem,
  quoteIdent,
  sqlType,
  systemRoleName,
} from "@wizard/appspec";
import type { ImportColumnMapping } from "@wizard/llm";
import type { SyntheticPayload, Table } from "@wizard/pii/import";
import type postgres from "postgres";

export const LOAD_BATCH = 1000;
const MAX_PARAMS = 60_000;

/** Field types a table cell can be loaded into (ref/file/json/qr_token are not importable). */
export const IMPORTABLE: ReadonlySet<string> = new Set([
  "string",
  "text",
  "int",
  "decimal",
  "money",
  "bool",
  "date",
  "datetime",
  "enum",
  "email",
  "phone",
  "url",
]);

type Value = string | number | boolean | null;

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const n = Number(v.replace(/[\s ₽]/g, "").replace(",", "."));
  return v.trim() !== "" && Number.isFinite(n) ? n : null;
}

function toDate(v: unknown, withTime: boolean): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?$/.exec(s);
  const iso = ru
    ? `${ru[3]}-${ru[2]?.padStart(2, "0")}-${ru[1]?.padStart(2, "0")}${ru[4] ? `T${ru[4]}` : ""}`
    : s;
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?/.test(iso) || Number.isNaN(Date.parse(iso)))
    return null;
  if (!withTime) return iso.slice(0, 10);
  // Spreadsheet date-times carry no zone: Moscow time.
  const t = iso.replace(" ", "T");
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : `${t.length === 10 ? `${t}T00:00:00` : t}+03:00`;
}

/** +7 999 123-45-67 / 8 (999) … / 9991234567 → E.164; anything else stays as typed (the format check decides). */
function toPhone(v: unknown): string {
  const s = String(v).trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return `+${digits}`;
  if (digits.length === 11 && (digits.startsWith("8") || digits.startsWith("7")))
    return `+7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith("9")) return `+7${digits}`;
  return s;
}

/** The value only if the column constraints of its type accept it (format, text rules). */
function checked(field: Field, v: Value): Value {
  return v === null || literalProblem(v, field.type as LiteralType) === undefined ? v : null;
}

/** Cell → value for the field type; null when it does not convert. */
export function convertCell(field: Field, v: unknown): Value {
  if (v === null || v === undefined || v === "") return null;
  return checked(field, rawConvert(field, v));
}

function rawConvert(field: Field, v: unknown): Value {
  switch (field.type) {
    case "int": {
      const n = toNumber(v);
      return n !== null && Number.isInteger(n) ? n : null;
    }
    case "decimal":
    case "money":
      return toNumber(v);
    case "bool": {
      if (typeof v === "boolean") return v;
      const s = String(v).trim().toLowerCase();
      if (["да", "true", "1", "yes", "+", "истина"].includes(s)) return true;
      if (["нет", "false", "0", "no", "-", "ложь"].includes(s)) return false;
      return null;
    }
    case "date":
      return toDate(v, false);
    case "datetime":
      return toDate(v, true);
    case "phone":
      return toPhone(v);
    case "enum": {
      const s = String(v).trim().toLowerCase();
      const opt = field.enum?.find((o) => o.value.toLowerCase() === s || o.label.toLowerCase() === s);
      return opt?.value ?? null;
    }
    default: {
      const s = String(v).trim();
      const max = field.maxLength ?? DEFAULT_MAX_LENGTH[field.type];
      return max !== undefined && s.length > max ? s.slice(0, max) : s;
    }
  }
}

export interface LoadInput {
  /** app_<key>_draft */
  schema: string;
  spec: AppSpec;
  table: Table;
  /** The payload the mapping refers to (sheet and column names after scrub). */
  payload: SyntheticPayload;
  /** Confirmed mapping; only action=map to an existing field is loaded. */
  mapping: readonly ImportColumnMapping[];
  migratorRole?: string;
}

export interface LoadResult {
  rowsImported: number;
  /** Rows not inserted because a required field was empty or did not convert. */
  rowsSkipped: number;
  byEntity: Record<string, number>;
}

interface Target {
  sheet: number;
  entity: string;
  columns: { index: number; field: Field }[];
}

function targets(i: LoadInput): Target[] {
  const out = new Map<string, Target>();
  for (const m of i.mapping) {
    if (m.action !== "map" || !m.entity || !m.field) continue;
    const s = i.payload.sheets.findIndex((x) => x.name === m.sheet);
    const c = s < 0 ? -1 : (i.payload.sheets[s]?.columns.findIndex((x) => x.header === m.column) ?? -1);
    const entity = i.spec.entities.find((e) => e.name === m.entity);
    const field = entity?.fields.find((f) => f.name === m.field);
    if (c < 0 || !entity || !field || !IMPORTABLE.has(field.type)) continue;
    const key = `${s}:${entity.name}`;
    let t = out.get(key);
    if (!t) {
      t = { sheet: s, entity: entity.name, columns: [] };
      out.set(key, t);
    }
    if (!t.columns.some((x) => x.field.name === field.name)) t.columns.push({ index: c, field });
  }
  return [...out.values()];
}

interface Batch {
  sql: string;
  values: Value[];
}

/** The inserts of a load and their counts, without touching the database (a replay reuses the counts). */
export function planLoad(i: LoadInput): { result: LoadResult; batches: Batch[] } {
  const result: LoadResult = { rowsImported: 0, rowsSkipped: 0, byEntity: {} };
  const batches: Batch[] = [];
  for (const t of targets(i)) {
    const entity = i.spec.entities.find((e) => e.name === t.entity);
    const sheet = i.table.sheets[t.sheet];
    if (!entity || !sheet) continue;
    const rows: Value[][] = [];
    for (const r of sheet.rows) {
      const values = t.columns.map((c) => convertCell(c.field, r[c.index]));
      if (values.every((v) => v === null)) continue;
      if (t.columns.some((c, k) => c.field.required === true && values[k] === null)) {
        result.rowsSkipped++;
        continue;
      }
      rows.push(values);
    }
    const cols = t.columns.map((c) => quoteIdent(c.field.name)).join(", ");
    const casts = t.columns.map((c) => sqlType(c.field.type));
    const perBatch = Math.max(1, Math.min(LOAD_BATCH, Math.floor(MAX_PARAMS / t.columns.length)));
    const target = `${quoteIdent(i.schema)}.${quoteIdent(entity.name)}`;
    for (let b = 0; b < rows.length; b += perBatch) {
      const batch = rows.slice(b, b + perBatch);
      let n = 0;
      const tuples = batch.map((row) => `(${row.map((_, k) => `$${++n}::${casts[k]}`).join(", ")})`);
      batches.push({
        sql: `insert into ${target} (${cols}) values ${tuples.join(", ")}`,
        values: batch.flat(),
      });
    }
    result.rowsImported += rows.length;
    result.byEntity[entity.name] = (result.byEntity[entity.name] ?? 0) + rows.length;
  }
  return { result, batches };
}

/**
 * Inserts the rows in one transaction. `before` runs first in the same transaction under the platform role (the run
 * marks its import done there, so a repeated load_rows after a crash sees it and does not insert twice).
 */
export async function loadRows(
  pg: postgres.Sql,
  i: LoadInput,
  o: { before?: (tx: postgres.TransactionSql, r: LoadResult) => Promise<void> } = {},
): Promise<LoadResult> {
  const { result, batches } = planLoad(i);
  await pg.begin(async (tx) => {
    await o.before?.(tx, result);
    // Rows are written as the target schema's system DB role (FORCE RLS; isolation.yaml#db_access, L3-20).
    await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(systemRoleName(i.schema))}`);
    for (const b of batches) await tx.unsafe(b.sql, b.values as never[]);
  });
  return result;
}
