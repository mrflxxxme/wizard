// Write/filter validation of the data API (runtime.yaml#data_api.writes, #data_api.query_params,
// #permissions.algorithm steps 4–6). Pure functions: no database access.
import {
  DEFAULT_MAX_LENGTH,
  type Entity,
  type Field,
  type FieldType,
  isFileFieldType,
  type LiteralType,
  literalProblem,
} from "@wizard/appspec";
import { WizardError } from "@wizard/sdk";
import { type AccessPolicy, disallowedValues, SYSTEM_FIELD_NAMES } from "@wizard/sdk/host";
import type { FilterCond } from "./access.js";

export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

const SYSTEM = new Set<string>(SYSTEM_FIELD_NAMES);
const STRINGY = new Set<FieldType>([
  "string",
  "text",
  "email",
  "phone",
  "url",
  "enum",
  "file",
  "image",
  "qr_token",
]);
const NUMERIC = new Set<FieldType>(["int", "decimal", "money"]);

export const SYSTEM_COLUMN_TYPES: Readonly<Record<string, LiteralType>> = {
  id: "uuid",
  created_at: "timestamptz",
  updated_at: "timestamptz",
  created_by: "uuid",
};

export function fieldsError(code: string, fields: FieldIssue[], message?: string): WizardError {
  return new WizardError(code, {
    ...(message ? { message } : {}),
    fields: fields.map((f) => ({ field: f.field, code: f.code, message: f.message })),
  });
}

/** Body of create/update as a plain object; `_consent` is split off (it is not a field). */
export function splitBody(body: unknown): { fields: Record<string, unknown>; consent: unknown } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WizardError("VALIDATION_FAILED", { message: "Ожидается объект" });
  }
  const { _consent, ...fields } = body as Record<string, unknown>;
  return { fields, consent: _consent };
}

/** Steps 5–6 and data_api.writes: unknown → UNKNOWN_FIELD, system/readonly/qr_token → FIELD_READONLY, hidden → FIELD_HIDDEN. */
export function checkWritableKeys(e: Entity, policy: AccessPolicy, fields: Record<string, unknown>): void {
  const unknown: FieldIssue[] = [];
  const hidden: FieldIssue[] = [];
  const readonly: FieldIssue[] = [];
  for (const key of Object.keys(fields)) {
    const f = e.fields.find((x) => x.name === key);
    if (SYSTEM.has(key))
      readonly.push({ field: key, code: "FIELD_READONLY", message: "Поле нельзя изменить" });
    else if (!f) unknown.push({ field: key, code: "UNKNOWN_FIELD", message: "Такого поля нет" });
    else if (policy.hidden.has(key))
      hidden.push({ field: key, code: "FIELD_HIDDEN", message: "Поле недоступно" });
    else if (policy.readonly.has(key) || f.type === "qr_token")
      readonly.push({ field: key, code: "FIELD_READONLY", message: "Поле нельзя изменить" });
  }
  if (unknown.length) throw fieldsError("UNKNOWN_FIELD", unknown);
  if (hidden.length) throw fieldsError("FIELD_HIDDEN", hidden);
  if (readonly.length) throw fieldsError("FIELD_READONLY", readonly);
}

/**
 * V3-18: Permission.allowedValues (e.g. a visitor sets only «cancelled» on his booking) → 422 FIELD_READONLY with
 * VALUE_NOT_ALLOWED. An update checks it once the row is found, so a foreign row still answers 404.
 */
export function checkAllowedValues(policy: AccessPolicy, fields: Record<string, unknown>): void {
  const bad = disallowedValues(policy, fields);
  if (bad.length)
    throw fieldsError(
      "FIELD_READONLY",
      bad.map((field) => ({ field, code: "VALUE_NOT_ALLOWED", message: "Это значение установить нельзя" })),
    );
}

function isMoney(v: number): boolean {
  const cents = v * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6;
}

/** Why a value cannot be stored in the field (Russian message), or undefined. `null` is checked by the caller. */
export function valueProblem(f: Field, v: unknown): string | undefined {
  switch (f.type) {
    case "enum":
      if (typeof v !== "string" || !(f.enum ?? []).some((o) => o.value === v))
        return "Выберите значение из списка";
      return undefined;
    case "int":
    case "decimal":
    case "money": {
      const p = literalProblem(v, f.type);
      if (p) return p;
      const n = v as number;
      if (f.type === "money" && !isMoney(n)) return "Не больше двух знаков после запятой";
      if (f.min !== undefined && n < f.min) return `Значение не меньше ${f.min}`;
      if (f.max !== undefined && n > f.max) return `Значение не больше ${f.max}`;
      return undefined;
    }
    default: {
      const p = literalProblem(v, f.type);
      if (p) return p;
      const max = f.maxLength ?? DEFAULT_MAX_LENGTH[f.type];
      if (typeof v === "string" && max !== undefined && [...v].length > max)
        return `Не длиннее ${max} символов`;
      return undefined;
    }
  }
}

/** Type/format/range checks; on create also `required` (fields absent without default). */
export function checkValues(e: Entity, fields: Record<string, unknown>, mode: "create" | "update"): void {
  const issues: FieldIssue[] = [];
  for (const f of e.fields) {
    const has = Object.hasOwn(fields, f.name) && fields[f.name] !== undefined;
    if (!has) {
      if (mode === "create" && f.required && f.default === undefined && f.type !== "qr_token")
        issues.push({ field: f.name, code: "REQUIRED", message: "Обязательное поле" });
      continue;
    }
    const v = fields[f.name];
    if (v === null) {
      if (f.required) issues.push({ field: f.name, code: "REQUIRED", message: "Обязательное поле" });
      continue;
    }
    const p = valueProblem(f, v);
    if (p) issues.push({ field: f.name, code: "INVALID", message: p });
  }
  if (issues.length) throw fieldsError("VALIDATION_FAILED", issues);
}

/** Spec type of a column (system columns included), or undefined for unknown names. */
export function columnType(e: Entity, name: string): LiteralType | undefined {
  return SYSTEM_COLUMN_TYPES[name] ?? e.fields.find((f) => f.name === name)?.type;
}

/** Visible column for filter/sort: unknown → UNKNOWN_FIELD, hidden → FIELD_HIDDEN. */
export function checkVisibleColumn(e: Entity, policy: AccessPolicy, name: string): LiteralType {
  const t = columnType(e, name);
  if (!t)
    throw fieldsError("UNKNOWN_FIELD", [{ field: name, code: "UNKNOWN_FIELD", message: "Такого поля нет" }]);
  if (policy.hidden.has(name))
    throw fieldsError("FIELD_HIDDEN", [{ field: name, code: "FIELD_HIDDEN", message: "Поле недоступно" }]);
  return t;
}

function badFilter(field: string, message: string): WizardError {
  return fieldsError("VALIDATION_FAILED", [{ field, code: "INVALID_FILTER", message }]);
}

/** Converts a query-string value to the column type (numbers, booleans; formats checked). */
export function coerceFilterValue(field: string, type: LiteralType, raw: string): unknown {
  if (type === "int" || type === "decimal" || type === "money") {
    const n = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(n)) throw badFilter(field, "Ожидается число");
    return n;
  }
  if (type === "bool") {
    if (raw !== "true" && raw !== "false") throw badFilter(field, "Ожидается true или false");
    return raw === "true";
  }
  if (type === "json") throw badFilter(field, "Фильтр по этому полю недоступен");
  const lit: LiteralType = type === "enum" || type === "qr_token" || isFileFieldType(type) ? "string" : type;
  const p = literalProblem(raw, lit);
  if (p) throw badFilter(field, p);
  return raw;
}

export interface CheckedFilter {
  field: string;
  op: FilterCond["op"];
  /** null → IS NULL / IS NOT NULL; array for `in`. */
  value: unknown;
}

export function checkFilters(
  e: Entity,
  policy: AccessPolicy,
  filter: readonly FilterCond[],
): CheckedFilter[] {
  return filter.map((c) => {
    const type = checkVisibleColumn(e, policy, c.field);
    if (c.value === null) {
      if (c.op !== "eq" && c.op !== "ne") throw badFilter(c.field, "null допустим только для eq и ne");
      return { field: c.field, op: c.op, value: null };
    }
    if (c.op === "contains") {
      if (!STRINGY.has(type as FieldType) || typeof c.value !== "string")
        throw badFilter(c.field, "contains — только для текстовых полей");
      return { field: c.field, op: c.op, value: c.value };
    }
    if (c.op === "in") {
      const list = typeof c.value === "string" ? c.value.split(",") : [...c.value];
      if (list.length === 0 || list.length > 100) throw badFilter(c.field, "От 1 до 100 значений");
      return { field: c.field, op: c.op, value: list.map((v) => coerceFilterValue(c.field, type, v)) };
    }
    if (typeof c.value !== "string") throw badFilter(c.field, "Ожидается одно значение");
    if ((c.op === "lt" || c.op === "lte" || c.op === "gt" || c.op === "gte") && type === "bool")
      throw badFilter(c.field, "Сравнение недоступно для этого поля");
    return { field: c.field, op: c.op, value: coerceFilterValue(c.field, type, c.value) };
  });
}

export const isNumericType = (t: FieldType): boolean => NUMERIC.has(t);

/** Field types the `q` search matches (runtime.yaml#data_api.query_params.q): text-like, phone digits, int equality. */
const SEARCH_TYPES = new Set<FieldType>(["string", "text", "email", "phone", "url", "int"]);
/** Longest `q` accepted. */
export const SEARCH_MAX = 100;

/** Fields of the `q` search: the entity's search types the role reads (hidden fields never match — no PII probing). */
export function searchColumns(e: Entity, policy: AccessPolicy): { name: string; type: FieldType }[] {
  return e.fields
    .filter((f) => SEARCH_TYPES.has(f.type) && !policy.hidden.has(f.name))
    .map((f) => ({ name: f.name, type: f.type }));
}

/** Digits of a phone-like query (≥ 3; 8/7 + 10 digits → the 10 national digits), else null. */
export function phoneDigits(q: string): string | null {
  if (!/^[+\d\s()-]+$/.test(q)) return null;
  const d = q.replace(/\D/g, "");
  if (d.length < 3) return null;
  return d.length === 11 && (d[0] === "7" || d[0] === "8") ? d.slice(1) : d;
}

/** An integer query («1042», «№1042», «#1042») as a number, else null. */
export function intQuery(q: string): number | null {
  const m = /^[#№]?\s*(\d{1,15})$/.exec(q);
  return m ? Number(m[1]) : null;
}
