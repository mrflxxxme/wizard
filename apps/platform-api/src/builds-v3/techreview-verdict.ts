// V3-15: the verdict of a v3 build's techreview for publication — a revision the build left as the draft after the
// techreview found blockers is not published (routes/publish.ts, publish/blockers.ts, publish/workflows.ts). Read
// from the harness checkpoints of the system (platform.system_build_checkpoints «techreview» and «draft» of one run).
import { sql } from "kysely";
import type { Db } from "../db/index.js";

/** Russian reason a revision is not published: the techreview of its v3 build found blockers. */
export const TECHREVIEW_BLOCKED_RU = (blocker: string) =>
  `Техревью последней сборки нашло ошибку, с которой эту версию нельзя публиковать: ${blocker.replace(/\.$/, "")}. Исправьте её и соберите систему заново.`;

/**
 * Blockers of the techreview of the v3 build that left `revision` as the draft (checkpoints «techreview» and «draft»
 * of the same run, the draft at this revision); empty — nothing keeps it from publication.
 */
export async function techreviewBlockersOf(db: Db, systemId: string, revision: number): Promise<string[]> {
  const r = await sql<{
    blockers: unknown;
    tr_run: string | null;
    draft_run: string | null;
    draft_rev: string | null;
  }>`
    select t.checkpoint -> 'data' -> 'blockers' as blockers,
           t.checkpoint ->> 'runId' as tr_run,
           d.checkpoint ->> 'runId' as draft_run,
           d.checkpoint -> 'data' ->> 'revision' as draft_rev
      from platform.system_build_checkpoints t
      join platform.system_build_checkpoints d on d.system_id = t.system_id and d.key = 'draft'
     where t.system_id = ${systemId} and t.key = 'techreview'`.execute(db);
  const row = r.rows[0];
  if (!row?.tr_run || row.tr_run !== row.draft_run || Number(row.draft_rev) !== revision) return [];
  return Array.isArray(row.blockers) ? row.blockers.filter((b): b is string => typeof b === "string") : [];
}
