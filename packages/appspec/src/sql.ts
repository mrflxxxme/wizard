// The ONLY place where names and values from an AppSpec become SQL text
// (specs/appspec/ops.yaml#migrations.sql_values, L3-01). Identifiers go through quoteIdent, values through
// sqlLiteral(value, type), which validates the value against its type before escaping it. Nothing else in the
// package may interpolate spec data into SQL.
import type { FieldType } from "./schema.js";

/** Column types a literal can be encoded for: AppSpec field types plus system column types. */
export type LiteralType = FieldType | "uuid" | "timestamptz";

/** Postgres NAMEDATALEN - 1: longer identifiers are silently truncated (and may then collide). */
export const MAX_IDENT_BYTES = 63;

const TEXT_TYPES: ReadonlySet<LiteralType> = new Set(["string", "text", "enum", "file", "qr_token"]);
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const NUMBER_RE = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

/** Format checks for string-like types (same patterns as the generated CHECK constraints). */
export const FORMAT_RE: Partial<Record<FieldType, string>> = {
  email: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
  phone: "^\\+[1-9][0-9]{6,14}$",
  url: "^https?://[^\\s]+$",
};

export class SqlValueError extends Error {
  override name = "SqlValueError";
}

function textProblem(value: string): string | undefined {
  if (value.includes("\0")) return "Значение содержит нулевой символ (NUL)";
  if (LONE_SURROGATE_RE.test(value)) return "Значение содержит некорректный символ Юникода";
  return undefined;
}

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function jsonProblem(value: unknown, depth = 0): string | undefined {
  if (depth > 64) return "Слишком глубокая вложенность JSON";
  if (value === null || typeof value === "boolean") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? undefined : "Число должно быть конечным";
  if (typeof value === "string") return textProblem(value);
  if (Array.isArray(value)) {
    for (const v of value) {
      const p = jsonProblem(v, depth + 1);
      if (p) return p;
    }
    return undefined;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [k, v] of Object.entries(value)) {
      const p = textProblem(k) ?? jsonProblem(v, depth + 1);
      if (p) return p;
    }
    return undefined;
  }
  return "Значение не является JSON";
}

/**
 * Why `value` cannot be stored as a literal of `type` (message in Russian), or undefined when it can.
 * Validators use it to reject a spec before any SQL is generated; sqlLiteral throws on the same condition.
 */
export function literalProblem(value: unknown, type: LiteralType): string | undefined {
  switch (type) {
    case "int":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? undefined
        : "Ожидается целое число (в пределах ±2^53)";
    case "decimal":
    case "money":
      return typeof value === "number" && Number.isFinite(value) && NUMBER_RE.test(String(value))
        ? undefined
        : "Ожидается конечное число";
    case "bool":
      return typeof value === "boolean" ? undefined : "Ожидается true или false";
    case "date": {
      if (typeof value !== "string") return "Ожидается дата ГГГГ-ММ-ДД";
      const m = DATE_RE.exec(value);
      return m && validDate(Number(m[1]), Number(m[2]), Number(m[3]))
        ? undefined
        : "Ожидается дата ГГГГ-ММ-ДД";
    }
    case "datetime":
    case "timestamptz": {
      if (typeof value !== "string") return "Ожидается дата и время ISO 8601 с часовым поясом";
      const m = DATETIME_RE.exec(value);
      const d = m ? DATE_RE.exec(m[1] as string) : null;
      return m && d && validDate(Number(d[1]), Number(d[2]), Number(d[3])) && !Number.isNaN(Date.parse(value))
        ? undefined
        : "Ожидается дата и время ISO 8601 с часовым поясом";
    }
    case "ref":
    case "uuid":
      return typeof value === "string" && UUID_RE.test(value) ? undefined : "Ожидается UUID";
    case "json":
      return value === undefined ? "Значение не является JSON" : jsonProblem(value);
    default: {
      if (typeof value !== "string") return "Ожидается строка";
      const p = textProblem(value);
      if (p) return p;
      const fmt = FORMAT_RE[type as FieldType];
      if (fmt && !new RegExp(fmt).test(value)) return `Значение не соответствует формату «${type}»`;
      if (!TEXT_TYPES.has(type) && !fmt) return `Неизвестный тип «${type}»`;
      return undefined;
    }
  }
}

/** Standard-conforming string constant: `'` doubled, nothing else special (backslashes are literal). */
function stringConst(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function numberConst(n: number): string {
  const s = String(n);
  return n < 0 ? `(${s})` : s;
}

/**
 * Encodes `value` as a SQL constant of `type`, validating it first (throws SqlValueError otherwise).
 * Output is a single constant expression: a number, TRUE/FALSE, or a standard string constant with an explicit
 * cast for non-text types. Requires standard_conforming_strings=on (toDDL/toRLS set it LOCAL); never emits
 * E'' strings or dollar quoting.
 */
export function sqlLiteral(value: unknown, type: LiteralType): string {
  const problem = literalProblem(value, type);
  if (problem) throw new SqlValueError(`${problem}: ${type}`);
  switch (type) {
    case "int":
    case "decimal":
    case "money":
      return numberConst(value as number);
    case "bool":
      return value ? "TRUE" : "FALSE";
    case "date":
      return `${stringConst(value as string)}::date`;
    case "datetime":
    case "timestamptz":
      return `${stringConst(value as string)}::timestamptz`;
    case "ref":
    case "uuid":
      return `${stringConst((value as string).toLowerCase())}::uuid`;
    case "json":
      return `${stringConst(JSON.stringify(value))}::jsonb`;
    default:
      return stringConst(value as string);
  }
}

/** A text constant for SQL-side names and settings (schema names, setting keys, role names). */
export function textLiteral(value: string): string {
  return sqlLiteral(value, "text");
}

/**
 * Quoted identifier. Rejects what Postgres would reject or silently alter: empty names, NUL, invalid Unicode and
 * names over 63 bytes (Postgres truncates them, so two different names could collide).
 */
export function quoteIdent(name: string): string {
  if (typeof name !== "string" || name.length === 0) throw new SqlValueError("empty SQL identifier");
  const p = textProblem(name);
  if (p) throw new SqlValueError(`invalid SQL identifier: ${p}`);
  if (Buffer.byteLength(name, "utf8") > MAX_IDENT_BYTES)
    throw new SqlValueError(`SQL identifier longer than ${MAX_IDENT_BYTES} bytes: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Dollar-quoted body with a tag that does not occur in it, so the body can never terminate the quote early.
 * Only for bodies built by this package from constants and encoded literals.
 */
export function dollarQuote(body: string, tag = "wz"): string {
  let t = tag;
  for (let i = 0; body.includes(`$${t}$`); i++) t = `${tag}${i}`;
  return `$${t}$${body}$${t}$`;
}
