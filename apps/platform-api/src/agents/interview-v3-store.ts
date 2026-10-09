// V3-03: what the v3 interview keeps in the platform database. Its brief is saved as a new version through the V3-02
// store (author agent, the run that wrote it) in the persist_output transaction of the turn; the non-blocking questions
// of the build queue live in the interview state; the monthly share of «пока не умею» for /admin is counted over the
// capability maps of the briefs (D77 (12)).
import type { DeferredQuestion } from "@wizard/agents/interview-v3";
import { type CapabilityMonth, notYetShareByMonth } from "@wizard/agents/interview-v3";
import type { BriefCapability } from "@wizard/appspec";
import { sql, type Transaction } from "kysely";
import { BriefConflictError, BriefInvalidError, saveBriefVersion } from "../briefs/store.js";
import type { Db } from "../db/index.js";
import type { DB } from "../db/types.js";
import { RunFailure } from "../runs/types.js";

export interface SaveInterviewBrief {
  systemId: string;
  runId: string;
  brief: Record<string, unknown>;
  /** The version the turn started from; another latest version → retryable failure (the owner edited meanwhile). */
  baseVersion?: number;
}

/**
 * Saves the interview's brief as a new version (author agent) unless it equals the latest; returns the latest version
 * number after the call. Runs in the caller's transaction.
 */
export async function saveInterviewBrief(trx: Transaction<DB>, p: SaveInterviewBrief): Promise<number> {
  try {
    const saved = await saveBriefVersion(trx, {
      systemId: p.systemId,
      brief: p.brief,
      author: "agent",
      runId: p.runId,
      ...(p.baseVersion !== undefined ? { baseVersion: p.baseVersion } : {}),
    });
    return saved.version.version;
  } catch (e) {
    if (e instanceof BriefConflictError)
      throw new RunFailure(
        "INTERNAL",
        "Бриф изменился, пока я думал над ответом. Нажмите «Повторить».",
        true,
      );
    if (e instanceof BriefInvalidError)
      throw new RunFailure("ORCH_INVALID_OUTPUT", "Не получилось записать бриф. Попробуйте ещё раз.", true);
    throw e;
  }
}

/** The build queue of a system: non-blocking questions of its latest v3 interview turn (empty without one). */
export async function loadBuildQuestions(db: Db, systemId: string): Promise<DeferredQuestion[]> {
  const row = await db
    .selectFrom("platform.runs")
    .select(sql<unknown>`input -> 'executorState' -> 'deferred'`.as("deferred"))
    .where("system_id", "=", systemId)
    .where("kind", "=", "interview_turn")
    .where("status", "=", "succeeded")
    .where(sql<boolean>`input -> 'executorState' ->> 'pipeline' = 'v3'`)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return Array.isArray(row?.deferred) ? (row.deferred as DeferredQuestion[]) : [];
}

/**
 * The share of «пока не умею» per month (D77 (12), /admin): for every system and month, the capability map of its last
 * brief version of that month; months ascending from `from` (default — twelve months back).
 */
export async function capabilityShareByMonth(db: Db, o: { from?: Date } = {}): Promise<CapabilityMonth[]> {
  const from = o.from ?? new Date(Date.UTC(new Date().getUTCFullYear() - 1, new Date().getUTCMonth(), 1));
  const { rows } = await sql<{ created_at: Date; capability: unknown }>`
    SELECT DISTINCT ON (b.system_id, date_trunc('month', b.created_at AT TIME ZONE 'UTC'))
      b.created_at, b.brief -> 'capability' AS capability
    FROM platform.system_briefs AS b
    WHERE b.created_at >= ${from}
    ORDER BY b.system_id, date_trunc('month', b.created_at AT TIME ZONE 'UTC'), b.version DESC
  `.execute(db);
  return notYetShareByMonth(
    rows.map((r) => ({
      createdAt: r.created_at,
      capability: Array.isArray(r.capability) ? (r.capability as BriefCapability[]) : [],
    })),
  );
}
