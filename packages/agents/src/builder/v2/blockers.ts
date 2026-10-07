// Which gate findings fail a build of the builder v2 (builder.yaml#v2.stages.gates) — shared by the gates stage and the
// custom-code stage (B2-23).
import type { GateReport } from "@wizard/gates";

/**
 * G2 checks only the owner can satisfy (operator of personal data — owner-only compliance fields, filled before the
 * publication; publish runs its own G2 and refuses without them, specPublishBlockers): they stay in the report but do
 * not fail the build (builder.yaml#v2.stages.gates).
 */
export const OWNER_INPUT_CHECKS: ReadonlySet<string> = new Set(["G2-PII-06"]);

/** Blockers that fail the build: failed or errored blocker checks, except the owner-input ones of G2. */
export function buildBlockers(r: GateReport): GateReport["checks"] {
  return r.checks.filter(
    (c) =>
      c.severity === "blocker" &&
      (c.status === "fail" || c.status === "error") &&
      !(r.level === "G2" && OWNER_INPUT_CHECKS.has(c.id)),
  );
}
