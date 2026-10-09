// Gates in the PR (V3-31): the state of G0, G1, G2 and the techreview of a revision as GitHub check runs / GitLab commit
// statuses — from platform.gate_reports of the revision (the latest report per level) and the techreview checkpoint of
// the build that left it; a gate still running is pending, one that never ran for the revision is neutral. Imports run
// G0 → G1 → G2 themselves over the candidate (the run engine's gate executor) before a revision is created.
import { type Kysely, sql } from "kysely";
import type { DB } from "../db/index.js";
import { ACTIVE_STATUSES } from "../runs/queue.js";
import type { GateReport } from "../runs/types.js";
import type { CheckState } from "./providers/types.js";
import { GATE_NAMES, syncRu } from "./texts.js";

export type GateKey = "G0" | "G1" | "G2" | "techreview";
export const GATE_KEYS: readonly GateKey[] = ["G0", "G1", "G2", "techreview"];

export interface GateStatus {
  key: GateKey;
  name: string;
  state: CheckState;
  title: string;
  summary: string;
}

interface ReportRow {
  level: "G0" | "G1" | "G2";
  passed: boolean;
  report: GateReport;
}

/** Failed checks of a report as one line (first message and the count of the others). */
export function failedLine(report: Pick<GateReport, "checks">): { title: string; summary: string } {
  const failed = (report.checks ?? []).filter((c) => c.status === "fail" || c.status === "error");
  const first = failed[0]?.message_ru ?? "проверка не пройдена";
  return {
    title: syncRu.gate.failed(first, failed.length - 1),
    summary: failed
      .slice(0, 20)
      .map((c) => `- ${c.id}: ${c.message_ru}${c.file ? ` (${c.file}${c.line ? `:${c.line}` : ""})` : ""}`)
      .join("\n"),
  };
}

/** Is a build or publish of the system in flight (its gates may still report)? */
async function gatesInFlight(db: Kysely<DB>, systemId: string): Promise<boolean> {
  const { rows } = await sql<{ id: string }>`
    select r.id from platform.runs as r
     where r.system_id = ${systemId} and r.kind in ('build','publish') and r.status in (${sql.join([...ACTIVE_STATUSES])})
     limit 1`.execute(db);
  return rows.length > 0;
}

/** The techreview of the v3 build that left `revision` as the draft: null — none for this revision. */
async function techreviewOf(db: Kysely<DB>, systemId: string, revision: number): Promise<string[] | null> {
  const { rows } = await sql<{
    blockers: unknown;
    tr_run: string | null;
    draft_run: string | null;
    draft_rev: string | null;
  }>`
    select t.checkpoint -> 'data' -> 'blockers' as blockers,
           t.checkpoint ->> 'runId' as tr_run,
           d.checkpoint ->> 'runId' as draft_run,
           d.checkpoint -> 'data' ->> 'revision' as draft_rev
      from platform.system_build_checkpoints as t
      join platform.system_build_checkpoints as d on d.system_id = t.system_id and d.key = 'draft'
     where t.system_id = ${systemId} and t.key = 'techreview'`.execute(db);
  const r = rows[0];
  if (!r?.tr_run || r.tr_run !== r.draft_run || Number(r.draft_rev) !== revision) return null;
  return Array.isArray(r.blockers) ? r.blockers.filter((b): b is string => typeof b === "string") : [];
}

/** G0, G1, G2 and the techreview of a revision for the PR. */
export async function revisionGateStatuses(
  db: Kysely<DB>,
  systemId: string,
  revision: number,
): Promise<GateStatus[]> {
  const { rows } = await sql<ReportRow>`
    select distinct on (g.level) g.level, g.passed, g.report
      from platform.gate_reports as g
     where g.system_id = ${systemId} and g.revision = ${revision}
     order by g.level, g.created_at desc`.execute(db);
  const inFlight = await gatesInFlight(db, systemId);
  const out: GateStatus[] = [];
  for (const level of ["G0", "G1", "G2"] as const) {
    const r = rows.find((x) => x.level === level);
    if (r?.passed)
      out.push({
        key: level,
        name: GATE_NAMES[level],
        state: "success",
        title: syncRu.gate.passed((r.report.checks ?? []).filter((c) => c.status === "pass").length),
        summary: "",
      });
    else if (r) out.push({ key: level, name: GATE_NAMES[level], state: "failure", ...failedLine(r.report) });
    else
      out.push({
        key: level,
        name: GATE_NAMES[level],
        state: inFlight ? "pending" : "neutral",
        title: inFlight ? syncRu.gate.pendingRun : syncRu.gate.notRun,
        summary: "",
      });
  }
  const tr = await techreviewOf(db, systemId, revision);
  out.push(
    tr === null
      ? {
          key: "techreview",
          name: GATE_NAMES.techreview,
          state: inFlight ? "pending" : "neutral",
          title: inFlight ? syncRu.gate.pendingRun : syncRu.gate.techNone,
          summary: "",
        }
      : tr.length
        ? {
            key: "techreview",
            name: GATE_NAMES.techreview,
            state: "failure",
            title: syncRu.gate.techBlocked(tr[0] as string),
            summary: tr.map((b) => `- ${b}`).join("\n"),
          }
        : {
            key: "techreview",
            name: GATE_NAMES.techreview,
            state: "success",
            title: syncRu.gate.techPassed,
            summary: "",
          },
  );
  return out;
}

/** Green for the auto-merge: G0, G1 and G2 passed, the techreview did not block. */
export function allGreen(s: readonly GateStatus[]): boolean {
  return s.every((g) =>
    g.key === "techreview" ? g.state === "success" || g.state === "neutral" : g.state === "success",
  );
}

/** Nothing will change any more (no pending gate). */
export function settled(s: readonly GateStatus[]): boolean {
  return s.every((g) => g.state !== "pending");
}
