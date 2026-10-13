// What the owner sees when something went wrong on the canvas (V4-11): plain Russian without codes, and the one action
// the server supports for that failure — repeat the build, fix it (POST /fix after failed checks), top up the balance —
// or none when pressing again cannot help (an invalid plan, the day's model limit).
import { canvas } from "../../i18n/ru/canvas.js";
import { ru } from "../../i18n/ru.js";

export type FailureAction = "retry" | "fix" | "billing" | null;

const FIX = new Set(["GATES_FAILED", "SMOKE_FAILED", "CONSECUTIVE_ERRORS"]);
const BILLING = new Set(["INSUFFICIENT_CREDITS", "BUILDS_LIMIT", "PLAN_LIMIT", "EDITS_LIMIT"]);
const NONE = new Set(["PLAN_INVALID", "LLM_BUDGET_EXHAUSTED"]);
/** A code, a stack frame or an English error: not words for the owner. */
const TECHNICAL = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bat [\w.]+ \(|Error:|\bundefined\b|\bnull\b/;

/** The action a failure of the build offers. */
export function failureAction(code: string): FailureAction {
  if (NONE.has(code)) return null;
  if (BILLING.has(code)) return "billing";
  if (FIX.has(code)) return "fix";
  return "retry";
}

/** Plain words of a failure: ours by its code, else the server's when they are words, else the generic line. */
export function failureText(code: string, message: string | null | undefined, generic: string): string {
  const own = canvas.failed.reasons[code];
  if (own) return own;
  const m = message?.trim();
  return m && !TECHNICAL.test(m) ? m : generic;
}

/** Plain words of a request's error: the server's when they are words (they say more), else ours by the code. */
export function errorWords(code: string | null, message: string | null | undefined): string {
  return failureText("", message, canvas.failed.reasons[code ?? ""] ?? ru.errors.generic);
}

/** Whether an error of a request is about money (the canvas offers «Пополнить баланс» next to it). */
export const isBillingError = (code: string | null): boolean => code !== null && BILLING.has(code);
