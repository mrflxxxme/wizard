// Versions of the system brief (V3-02, db.yaml#system_briefs; builder-v3.md §3 C1). The interview agent and the owner
// write a new version — max+1 with briefDiff to the previous one — under the systems row lock; an edit that changes
// nothing adds no version. Build stages read getLatestBrief before every stage, so an edit made during a build reaches
// the next stage.
import {
  type BriefAuthor,
  type BriefChange,
  type BriefError,
  type BriefVersion,
  briefDiff,
  type SystemBrief,
  validateBrief,
} from "@wizard/appspec";
import type { Selectable, Transaction } from "kysely";
import { type Db, json } from "../db/index.js";
import type { DB, SystemBriefsTable } from "../db/types.js";

export type BriefRow = Selectable<SystemBriefsTable>;

/** A version in the history list: everything but the brief itself. */
export type BriefVersionSummary = Omit<BriefVersion, "brief">;

/** The brief does not pass validateBrief; `errors` are Russian with the place in the brief. */
export class BriefInvalidError extends Error {
  constructor(readonly errors: BriefError[]) {
    super(errors[0]?.message_ru ?? "Бриф не прошёл проверку");
    this.name = "BriefInvalidError";
  }
}

/** The writer saw another version than the latest one (`latest`, 0 — no brief yet). */
export class BriefConflictError extends Error {
  constructor(readonly latest: number) {
    super(`brief version conflict: latest ${latest}`);
    this.name = "BriefConflictError";
  }
}

export function toBriefVersion(row: BriefRow): BriefVersion {
  return {
    version: row.version,
    brief: row.brief as unknown as SystemBrief,
    diff: row.diff as BriefChange[],
    author: row.author,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** The latest version of the system brief; null before the interview wrote one. */
export async function getLatestBrief(db: Db, systemId: string): Promise<BriefVersion | null> {
  const row = await db
    .selectFrom("platform.system_briefs")
    .selectAll()
    .where("system_id", "=", systemId)
    .orderBy("version", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? toBriefVersion(row) : null;
}

/** One version of the system brief; null when there is no such version. */
export async function getBriefVersion(
  db: Db,
  systemId: string,
  version: number,
): Promise<BriefVersion | null> {
  const row = await db
    .selectFrom("platform.system_briefs")
    .selectAll()
    .where("system_id", "=", systemId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row ? toBriefVersion(row) : null;
}

export interface ListBriefVersions {
  /** At most this many versions (default 50). */
  limit?: number;
  /** Only versions older than this one (the next page). */
  before?: number;
}

/** History of the system brief, newest first, without the briefs themselves (diff, author, time). */
export async function listBriefVersions(
  db: Db,
  systemId: string,
  o: ListBriefVersions = {},
): Promise<BriefVersionSummary[]> {
  let q = db
    .selectFrom("platform.system_briefs")
    .select(["version", "diff", "author", "created_at"])
    .where("system_id", "=", systemId);
  if (o.before !== undefined) q = q.where("version", "<", o.before);
  const rows = await q
    .orderBy("version", "desc")
    .limit(o.limit ?? 50)
    .execute();
  return rows.map((r) => ({
    version: r.version,
    diff: r.diff as BriefChange[],
    author: r.author,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export interface SaveBrief {
  systemId: string;
  /** The whole brief as written (validated and normalized here). */
  brief: unknown;
  author: BriefAuthor;
  /** The owner who edited (author owner). */
  authorUserId?: string | null;
  /** The run that wrote it (author agent: interview, ТЗ extraction, build questions). */
  runId?: string | null;
  /** The version the writer saw (0 — no brief yet); another latest version → BriefConflictError. Omitted — no check. */
  baseVersion?: number;
}

export interface SavedBrief {
  version: BriefVersion;
  /** false — the brief equals the latest version: nothing was written, `version` is that latest one. */
  changed: boolean;
}

/**
 * Writes a new version of the system brief: validates it (BriefInvalidError), locks the system row, checks
 * `baseVersion` (BriefConflictError), stores version max+1 with the diff to the previous one and marks the system
 * active. Runs in the caller's transaction when given one.
 */
export async function saveBriefVersion(db: Db, p: SaveBrief): Promise<SavedBrief> {
  const valid = validateBrief(p.brief);
  if (!valid.ok) throw new BriefInvalidError(valid.errors);
  const write = async (trx: Transaction<DB>): Promise<SavedBrief> => {
    await trx
      .selectFrom("platform.systems")
      .select("id")
      .where("id", "=", p.systemId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    const latest = await getLatestBrief(trx, p.systemId);
    const current = latest?.version ?? 0;
    if (p.baseVersion !== undefined && p.baseVersion !== current) throw new BriefConflictError(current);
    const diff = briefDiff(latest?.brief ?? null, valid.brief);
    if (latest && diff.length === 0) return { version: latest, changed: false };
    const row = await trx
      .insertInto("platform.system_briefs")
      .values({
        system_id: p.systemId,
        version: current + 1,
        brief: json(valid.brief),
        diff: json(diff),
        author: p.author,
        author_user_id: p.authorUserId ?? null,
        run_id: p.runId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("platform.systems")
      .set({ last_activity_at: new Date() })
      .where("id", "=", p.systemId)
      .execute();
    return { version: toBriefVersion(row), changed: true };
  };
  return db.isTransaction ? write(db as Transaction<DB>) : db.transaction().execute(write);
}
