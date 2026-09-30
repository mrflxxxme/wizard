// Check results → GateReport entries (specs/quality/gates.yaml#report).
import type { CheckDef } from "./catalog.js";
import type { Check, CheckStatus, GateSummary } from "./types.js";

export interface Finding {
  message_ru: string;
  file?: string;
  line?: number;
  path?: string;
  evidence?: string;
  fixHint?: string;
  /** Overrides the check's failing status (e.g. "warn" for a soft limit of a blocker check). */
  status?: CheckStatus;
}

export type CheckOutcome =
  | { kind: "findings"; findings: Finding[] }
  | { kind: "skip"; reason_ru: string }
  | { kind: "error"; reason_ru: string; evidence?: string };

/** Report entries per check id are capped; the tail is summarised in one entry. */
export const MAX_ENTRIES_PER_CHECK = 25;

export function clip(s: string, n: number): string {
  const chars = [...s];
  return chars.length > n ? `${chars.slice(0, n - 1).join("")}…` : s;
}

function entry(def: CheckDef, status: CheckStatus, message_ru: string, extra: Partial<Check> = {}): Check {
  const c: Check = { id: def.id, status, severity: def.severity, message_ru: clip(message_ru, 300) };
  if (extra.file !== undefined) c.file = extra.file;
  if (extra.line !== undefined) c.line = extra.line;
  if (extra.path !== undefined) c.path = extra.path;
  if (extra.evidence !== undefined) c.evidence = clip(extra.evidence, 500);
  if (extra.fixHint !== undefined) c.fixHint = clip(extra.fixHint, 300);
  return c;
}

export function toChecks(def: CheckDef, outcome: CheckOutcome): Check[] {
  if (outcome.kind === "skip") return [entry(def, "skip", outcome.reason_ru)];
  if (outcome.kind === "error") {
    return [
      entry(def, "error", `Не удалось проверить: ${outcome.reason_ru}`, {
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      }),
    ];
  }
  const failStatus: CheckStatus = def.severity === "warning" ? "warn" : "fail";
  const findings = outcome.findings;
  if (findings.length === 0) return [entry(def, "pass", def.title_ru)];
  const out = findings
    .slice(0, MAX_ENTRIES_PER_CHECK)
    .map((f) => entry(def, f.status ?? failStatus, f.message_ru, f));
  const rest = findings.slice(MAX_ENTRIES_PER_CHECK);
  if (rest.length) {
    const st = rest.some((f) => (f.status ?? failStatus) === "fail")
      ? "fail"
      : (rest[0]?.status ?? failStatus);
    out.push(entry(def, st, `И ещё ${rest.length} замечаний этой проверки`));
  }
  return out;
}

export function summarize(checks: readonly Check[]): GateSummary {
  const s: GateSummary = { pass: 0, fail: 0, warn: 0, skip: 0, error: 0 };
  for (const c of checks) s[c.status]++;
  return s;
}

export function isPassed(checks: readonly Check[]): boolean {
  return !checks.some((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"));
}
