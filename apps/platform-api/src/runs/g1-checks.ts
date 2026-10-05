// QA scenarios of a passed G1 (db.yaml#g1_checks). A card AC without inline steps is checked by a scenario the QA agent
// generates during the build (qa_generate); G1 cannot derive it from the spec. The publish G1 of a later revision that
// was never gated (e.g. a compliance edit, workflows.yaml#workflows.publish.steps.gate_G1_prod) reuses the scenarios of
// the nearest earlier revision whose G1 passed, per AC, only while the AC id and text are unchanged (key acId +
// sha256(text), as qa.yaml#checks.determinism). An AC whose text changed gets no stale scenario: G1-AC-COVER fails.
// Scenarios are synthetic (qa.yaml#seed: QA never sees records or secret values); nothing else is stored.
import { createHash } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import type { QaCheck } from "@wizard/gates";
import { type Db, json } from "../db/index.js";
import type { TxCtx } from "./events.js";

/** One stored QA check with the AC it covers. */
export interface StoredG1Check {
  acId: string;
  /** sha256(hex) of the AC text at the revision whose G1 passed. */
  textSha256: string;
  check: QaCheck;
}

/** Earlier revisions looked at for reusable scenarios (newest first). */
const MAX_ANCESTORS = 50;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Ac = NonNullable<AppSpec["acceptance"]>[number];

/** An AC G1 checks only through a QA scenario: scenario/constraint without inline steps in the spec. */
const needsQaScenario = (ac: Ac): boolean => ac.check.type !== "permission" && !ac.check.steps?.length;

/** The QA checks worth keeping: G1 scenarios bound to an AC of `spec` that has no inline steps. */
export function storedG1Checks(spec: AppSpec, checks: readonly QaCheck[]): StoredG1Check[] {
  const acs = new Map((spec.acceptance ?? []).filter(needsQaScenario).map((a) => [a.id, a]));
  const out: StoredG1Check[] = [];
  for (const c of checks) {
    const ac = c.acId !== undefined ? acs.get(c.acId) : undefined;
    if (!ac || c.level !== "G1" || !c.scenario || c.kind === "permission") continue;
    out.push({ acId: ac.id, textSha256: sha256(ac.text), check: structuredClone(c) });
  }
  return out;
}

/** Keeps the QA scenarios of a passed G1 on `revision` (one row per revision; a later passed G1 replaces it). */
export async function saveG1Checks(
  t: TxCtx,
  a: { systemId: string; revision: number; runId: string; spec: AppSpec; checks: readonly QaCheck[] },
): Promise<void> {
  const stored = storedG1Checks(a.spec, a.checks);
  if (stored.length === 0) return;
  await t.trx
    .insertInto("platform.g1_checks")
    .values({ system_id: a.systemId, revision: a.revision, run_id: a.runId, checks: json(stored) })
    .onConflict((oc) =>
      oc.columns(["system_id", "revision"]).doUpdateSet({ run_id: a.runId, checks: json(stored) }),
    )
    .execute();
}

/**
 * QA checks for the ACs of `spec` (revision `revision`) without inline steps: per AC, the scenarios of the nearest
 * revision ≤ `revision` with a passed G1 whose AC id, type and text match. ACs with no match get nothing.
 */
export async function inheritedG1Checks(
  db: Db,
  systemId: string,
  revision: number,
  spec: AppSpec,
): Promise<{ checks: QaCheck[]; fromRevision: Record<string, number> }> {
  const need = new Map<string, Ac>();
  for (const ac of spec.acceptance ?? []) if (needsQaScenario(ac)) need.set(ac.id, ac);
  const checks: QaCheck[] = [];
  const fromRevision: Record<string, number> = {};
  if (need.size === 0) return { checks, fromRevision };
  const rows = await db
    .selectFrom("platform.g1_checks")
    .select(["revision", "checks"])
    .where("system_id", "=", systemId)
    .where("revision", "<=", revision)
    .orderBy("revision", "desc")
    .limit(MAX_ANCESTORS)
    .execute();
  for (const row of rows) {
    const stored = Array.isArray(row.checks) ? (row.checks as StoredG1Check[]) : [];
    for (const [acId, ac] of need) {
      const sha = sha256(ac.text);
      const milestone = ac.check.milestone ?? "M0";
      const mine = stored.filter(
        (s) => s.acId === acId && s.textSha256 === sha && s.check?.kind === ac.check.type && s.check.scenario,
      );
      if (mine.length === 0) continue;
      for (const s of mine)
        checks.push({
          ...s.check,
          acId,
          milestone,
          ...(s.check.scenario ? { scenario: { ...s.check.scenario, acId, milestone } } : {}),
        });
      fromRevision[acId] = row.revision;
      need.delete(acId);
    }
    if (need.size === 0) break;
  }
  return { checks, fromRevision };
}
