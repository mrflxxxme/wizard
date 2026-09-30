// Structured errors for AppSpec validation and operations (specs/appspec/ops.yaml#apply.error_shape).
import type { z } from "zod";

export const ERROR_CODES = [
  "VERSION_CONFLICT",
  "SCHEMA_INVALID",
  "UNKNOWN_ENTITY",
  "UNKNOWN_FIELD",
  "UNKNOWN_ROLE",
  "DUPLICATE_NAME",
  "RESERVED_NAME",
  "REF_TARGET_MISSING",
  "PII_CATEGORY_FORBIDDEN",
  "DESTRUCTIVE_IN_PROD",
  "BATCH_TOO_LARGE",
  "LIMIT_EXCEEDED",
  "INVALID_ROW_FILTER",
] as const;

export type OpsErrorCode = (typeof ERROR_CODES)[number];

export interface OpsError {
  code: OpsErrorCode;
  /** JSON Pointer (RFC 6901) into the spec, or into the batch (`/ops/<i>/...`) for per-op errors. */
  path: string;
  /** Human-readable message in Russian. */
  message: string;
  /** Permitted values, when the error is "value not in a known set". */
  allowed?: string[];
  hint?: string;
}

export type PathSegment = string | number;

export function pointer(segments: readonly PropertyKey[]): string {
  if (segments.length === 0) return "";
  return `/${segments.map((s) => String(s).replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

export function err(
  code: OpsErrorCode,
  path: readonly PropertyKey[] | string,
  message: string,
  extra: { allowed?: readonly string[]; hint?: string } = {},
): OpsError {
  const e: OpsError = { code, path: typeof path === "string" ? path : pointer(path), message };
  if (extra.allowed) e.allowed = [...extra.allowed];
  if (extra.hint) e.hint = extra.hint;
  return e;
}

const TYPE_RU: Record<string, string> = {
  string: "строка",
  number: "число",
  int: "целое число",
  boolean: "логическое значение",
  object: "объект",
  record: "объект",
  array: "массив",
  undefined: "отсутствует",
  null: "null",
};

function ru(t: unknown): string {
  return TYPE_RU[String(t)] ?? String(t);
}

// Top-level array limits map to LIMIT_EXCEEDED instead of SCHEMA_INVALID (ops.yaml#semantic_rules «Лимиты»).
const LIMIT_PATHS = [
  /^\/entities$/,
  /^\/entities\/\d+\/fields$/,
  /^\/pages$/,
  /^\/functions$/,
  /^\/workflows$/,
  /^\/roles$/,
];

/** Converts zod issues to OpsError[]; `base` is prefixed to every path. */
export function fromZodIssues(issues: readonly z.core.$ZodIssue[], base: readonly PropertyKey[] = []): OpsError[] {
  const out: OpsError[] = [];
  for (const issue of issues) {
    const segs = [...base, ...issue.path];
    const path = pointer(segs);
    switch (issue.code) {
      case "invalid_type":
        out.push(
          err(
            "SCHEMA_INVALID",
            path,
            issue.input === undefined
              ? "Обязательное свойство отсутствует"
              : `Неверный тип: ожидается ${ru(issue.expected)}`,
          ),
        );
        break;
      case "unrecognized_keys":
        for (const key of issue.keys) {
          out.push(
            err("SCHEMA_INVALID", pointer([...segs, key]), `Неизвестное свойство «${key}»`, {
              hint: "Удалите свойство: схема AppSpec не допускает дополнительных ключей здесь",
            }),
          );
        }
        break;
      case "invalid_value":
        out.push(
          err("SCHEMA_INVALID", path, "Недопустимое значение", {
            allowed: issue.values.map((v) => String(v)),
          }),
        );
        break;
      case "invalid_union": {
        const { note, options: opts } = issue as { note?: string; options?: unknown[] };
        if (note === "No matching discriminator" && Array.isArray(opts)) {
          out.push(
            err("SCHEMA_INVALID", path, "Неизвестный тип операции", { allowed: opts.map((o) => String(o)) }),
          );
        } else {
          // Union of literals (e.g. theme.radius): collect allowed values when all branches are literals.
          const values = issue.errors.flatMap((branch) =>
            branch.flatMap((b) => (b.code === "invalid_value" ? b.values.map((v) => String(v)) : [])),
          );
          out.push(
            err(
              "SCHEMA_INVALID",
              path,
              "Значение не подходит ни под один допустимый вариант",
              values.length ? { allowed: values } : {},
            ),
          );
        }
        break;
      }
      case "too_big": {
        const isLimit = issue.origin === "array" && LIMIT_PATHS.some((re) => re.test(path));
        const what = issue.origin === "string" ? "символов" : issue.origin === "array" ? "элементов" : "";
        out.push(
          err(
            isLimit ? "LIMIT_EXCEEDED" : "SCHEMA_INVALID",
            path,
            what
              ? `Слишком много ${what}: максимум ${String(issue.maximum)}`
              : `Значение больше допустимого максимума ${String(issue.maximum)}`,
          ),
        );
        break;
      }
      case "too_small": {
        const what = issue.origin === "string" ? "символов" : issue.origin === "array" ? "элементов" : "";
        out.push(
          err(
            "SCHEMA_INVALID",
            path,
            what
              ? `Слишком мало ${what}: минимум ${String(issue.minimum)}`
              : `Значение меньше допустимого минимума ${String(issue.minimum)}`,
          ),
        );
        break;
      }
      case "invalid_format":
        out.push(
          err(
            "SCHEMA_INVALID",
            path,
            "Строка не соответствует формату",
            issue.format === "regex" && issue.pattern ? { hint: `Шаблон: ${issue.pattern}` } : {},
          ),
        );
        break;
      default:
        out.push(err("SCHEMA_INVALID", path, issue.message));
    }
  }
  return out;
}
