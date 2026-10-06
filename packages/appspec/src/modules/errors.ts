// Errors of module manifests and system plans (specs/modules/modules.yaml#validation): same shape as OpsError,
// own closed set of codes. Messages are Russian: the plan screen and the planner model read them as is.
import type { z } from "zod";
import { fromZodIssues, pointer } from "../errors.js";

export const PLAN_ERROR_CODES = [
  "SCHEMA_INVALID",
  "UNKNOWN_MODULE",
  "DUPLICATE_MODULE",
  "PARAMS_INVALID",
  "MISSING_REQUIRED_MODULE",
  "REQUIRED_PARAMS_MISMATCH",
  "MODULE_CONFLICT",
  "TOO_MANY_GOALS",
  "DUPLICATE_GOAL",
  "GOAL_NOT_COVERED",
  "GOAL_NOT_IN_PLAN",
  "CUSTOM_LIMIT_EXCEEDED",
  "UNKNOWN_SECTION",
  "UNKNOWN_VARIANT",
  "SECTION_CONTENT_INVALID",
  "SECTION_ORDER",
  "SECTION_REQUIRED",
  "SECTION_NEEDS_MODULE",
  "LANDING_MISMATCH",
  "UNKNOWN_THEME",
  "UNKNOWN_FONT",
  "MODULE_NOT_READY",
  "CATALOG_INVALID",
] as const;

export type PlanErrorCode = (typeof PLAN_ERROR_CODES)[number];

export interface PlanError {
  code: PlanErrorCode;
  /** JSON Pointer (RFC 6901) into the plan (or into the catalog for CATALOG_INVALID). */
  path: string;
  /** Human-readable message in Russian. */
  message_ru: string;
  allowed?: string[];
  hint?: string;
}

export function planErr(
  code: PlanErrorCode,
  path: readonly PropertyKey[],
  message: string,
  extra: { allowed?: readonly string[]; hint?: string } = {},
): PlanError {
  const e: PlanError = { code, path: pointer(path), message_ru: message };
  if (extra.allowed) e.allowed = [...extra.allowed];
  if (extra.hint) e.hint = extra.hint;
  return e;
}

/** Zod issues → PlanError[]: Russian messages from the AppSpec converter; `planCode` in custom issue params wins. */
export function planErrorsFromZod(
  issues: readonly z.core.$ZodIssue[],
  base: readonly PropertyKey[] = [],
  fallback: PlanErrorCode = "SCHEMA_INVALID",
): PlanError[] {
  return issues.flatMap((issue) => {
    const custom =
      issue.code === "custom"
        ? (issue.params as { planCode?: PlanErrorCode } | undefined)?.planCode
        : undefined;
    const tooManyGoals =
      issue.code === "too_big" &&
      issue.origin === "array" &&
      issue.path.length === 1 &&
      issue.path[0] === "goals";
    return fromZodIssues([issue], base).map((e) => {
      const out: PlanError = { ...e, code: custom ?? (tooManyGoals ? "TOO_MANY_GOALS" : fallback) };
      if (tooManyGoals) out.message_ru = "Целей больше трёх: выберите 1–3 главные цели бизнеса";
      return out;
    });
  });
}
