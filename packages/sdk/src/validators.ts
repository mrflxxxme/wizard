// Argument validators `v` (sdk.md §5). Validators are plain descriptors; `checkValue` enforces them at
// runtime (the host validates args before running a handler → 422 VALIDATION_FAILED).
import type { ArgsShape, EntityName, Id, InferArgs, PaginationOpts, Validator } from "./sdk.js";

export type ValidatorSpec =
  | { kind: "string" | "email" | "phone" | "date" | "datetime"; min?: number; max?: number; pattern?: RegExp }
  | { kind: "int" | "number" | "money"; min?: number; max?: number }
  | { kind: "boolean" | "pagination" }
  | { kind: "id"; entity: string }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "array"; item: RuntimeValidator; max?: number }
  | { kind: "object"; shape: ArgsShape }
  | { kind: "optional" | "nullable"; inner: RuntimeValidator };

/** Implementation shape behind the public `Validator<T>` interface. */
export type RuntimeValidator = Validator<unknown> & { readonly spec: ValidatorSpec };

function make<T>(spec: ValidatorSpec, isOptional = false): Validator<T> {
  const r: RuntimeValidator = { kind: spec.kind, isOptional, spec };
  return r as Validator<T>;
}

const rt = (x: Validator<unknown>) => x as RuntimeValidator;

export const v = {
  string: (o: { min?: number; max?: number; pattern?: RegExp } = {}) =>
    make<string>({ kind: "string", ...o }),
  int: (o: { min?: number; max?: number } = {}) => make<number>({ kind: "int", ...o }),
  number: (o: { min?: number; max?: number } = {}) => make<number>({ kind: "number", ...o }),
  money: (o: { min?: number; max?: number } = {}) => make<number>({ kind: "money", ...o }),
  boolean: () => make<boolean>({ kind: "boolean" }),
  date: () => make<string>({ kind: "date" }),
  datetime: () => make<string>({ kind: "datetime" }),
  email: () => make<string>({ kind: "email" }),
  phone: () => make<string>({ kind: "phone" }),
  id: <E extends EntityName | "users">(entity: E) => make<Id<E>>({ kind: "id", entity }),
  literal: <const T extends string | number | boolean>(value: T) => make<T>({ kind: "literal", value }),
  enum: <const T extends readonly [string, ...string[]]>(...values: T) =>
    make<T[number]>({ kind: "enum", values }),
  array: <T>(item: Validator<T>, o: { max?: number } = {}) =>
    make<T[]>({ kind: "array", item: rt(item), ...o }),
  object: <S extends ArgsShape>(shape: S) => make<InferArgs<S>>({ kind: "object", shape }),
  optional: <T>(inner: Validator<T>) => make<T | undefined>({ kind: "optional", inner: rt(inner) }, true),
  nullable: <T>(inner: Validator<T>) =>
    make<T | null>({ kind: "nullable", inner: rt(inner) }, inner.isOptional),
  pagination: () => make<PaginationOpts>({ kind: "pagination" }),
};

export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9()\-\s]{7,20}$/;
// Ids are uuid in Postgres; the test host uses the same format.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function issue(field: string, code: string, message: string): FieldIssue {
  return { field, code, message };
}

function checkRange(n: number, path: string, s: { min?: number; max?: number }, out: FieldIssue[]) {
  if (s.min !== undefined && n < s.min) out.push(issue(path, "too_small", `Значение не меньше ${s.min}`));
  if (s.max !== undefined && n > s.max) out.push(issue(path, "too_big", `Значение не больше ${s.max}`));
}

function checkLength(str: string, path: string, s: { min?: number; max?: number }, out: FieldIssue[]) {
  const len = [...str].length;
  if (s.min !== undefined && len < s.min) out.push(issue(path, "too_short", `Минимум символов: ${s.min}`));
  if (s.max !== undefined && len > s.max) out.push(issue(path, "too_long", `Максимум символов: ${s.max}`));
}

/** Validates `value` against a validator, appending issues (field path, code, Russian message) to `out`. */
export function checkValue(
  validator: Validator<unknown>,
  value: unknown,
  path: string,
  out: FieldIssue[],
): void {
  const s = rt(validator).spec;
  if (value === undefined) {
    if (s.kind === "optional") return;
    if (s.kind === "nullable" && s.inner.isOptional) return;
    out.push(issue(path, "required", "Обязательное поле"));
    return;
  }
  switch (s.kind) {
    case "optional":
      checkValue(s.inner, value, path, out);
      return;
    case "nullable":
      if (value !== null) checkValue(s.inner, value, path, out);
      return;
    case "string":
    case "email":
    case "phone":
    case "date":
    case "datetime": {
      if (typeof value !== "string") {
        out.push(issue(path, "type", "Ожидается строка"));
        return;
      }
      if (s.kind === "string") {
        checkLength(value, path, s, out);
        if (s.pattern && !new RegExp(s.pattern.source, s.pattern.flags.replace("g", "")).test(value)) {
          out.push(issue(path, "pattern", "Неверный формат"));
        }
      } else if (s.kind === "email" && (!EMAIL_RE.test(value) || value.length > 254)) {
        out.push(issue(path, "email", "Неверный email"));
      } else if (s.kind === "phone" && !PHONE_RE.test(value)) {
        out.push(issue(path, "phone", "Неверный номер телефона"));
      } else if (s.kind === "date" && (!DATE_RE.test(value) || Number.isNaN(Date.parse(value)))) {
        out.push(issue(path, "date", "Ожидается дата ГГГГ-ММ-ДД"));
      } else if (s.kind === "datetime" && (!DATETIME_RE.test(value) || Number.isNaN(Date.parse(value)))) {
        out.push(issue(path, "datetime", "Ожидается дата и время ISO 8601"));
      }
      return;
    }
    case "int":
    case "number":
    case "money": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        out.push(issue(path, "type", "Ожидается число"));
        return;
      }
      if (s.kind === "int" && !Number.isInteger(value)) out.push(issue(path, "int", "Ожидается целое число"));
      if (s.kind === "money" && Math.round(value * 100) !== value * 100) {
        out.push(issue(path, "money", "Не больше 2 знаков после запятой"));
      }
      checkRange(value, path, s, out);
      return;
    }
    case "boolean":
      if (typeof value !== "boolean") out.push(issue(path, "type", "Ожидается да/нет"));
      return;
    case "id":
      if (typeof value !== "string" || !ID_RE.test(value))
        out.push(issue(path, "id", "Неверный идентификатор"));
      return;
    case "literal":
      if (value !== s.value) out.push(issue(path, "literal", "Недопустимое значение"));
      return;
    case "enum":
      if (typeof value !== "string" || !s.values.includes(value)) {
        out.push(issue(path, "enum", "Недопустимое значение"));
      }
      return;
    case "array": {
      if (!Array.isArray(value)) {
        out.push(issue(path, "type", "Ожидается список"));
        return;
      }
      if (s.max !== undefined && value.length > s.max) {
        out.push(issue(path, "too_big", `Не больше ${s.max} элементов`));
      }
      value.forEach((item, i) => {
        checkValue(s.item, item, `${path}[${i}]`, out);
      });
      return;
    }
    case "object":
      checkShape(s.shape, value, path, out);
      return;
    case "pagination": {
      const p = value as Partial<PaginationOpts>;
      if (typeof value !== "object" || value === null) {
        out.push(issue(path, "type", "Ожидается объект"));
        return;
      }
      if (p.cursor !== null && typeof p.cursor !== "string")
        out.push(issue(`${path}.cursor`, "type", "Неверный курсор"));
      if (typeof p.numItems !== "number" || !Number.isInteger(p.numItems) || p.numItems < 1) {
        out.push(issue(`${path}.numItems`, "type", "Ожидается целое число ≥ 1"));
      }
      return;
    }
  }
}

/** Validates an object against an args shape: unknown keys are rejected. */
export function checkShape(shape: ArgsShape, value: unknown, path: string, out: FieldIssue[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    out.push(issue(path, "type", "Ожидается объект"));
    return;
  }
  const obj = value as Record<string, unknown>;
  const prefix = path ? `${path}.` : "";
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(shape, key)) out.push(issue(`${prefix}${key}`, "unknown", "Такого поля нет"));
  }
  for (const [key, validator] of Object.entries(shape))
    checkValue(validator, obj[key], `${prefix}${key}`, out);
}

/** Validates function args; returns issues (empty = valid). */
export function validateArgs(shape: ArgsShape, args: unknown): FieldIssue[] {
  const out: FieldIssue[] = [];
  checkShape(shape, args ?? {}, "", out);
  return out;
}
