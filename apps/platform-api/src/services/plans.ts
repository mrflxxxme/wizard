// System plan revisions of the beta v2 path (B2-20, db.yaml#system_plans, api.yaml#getSystemPlan): the planner or a
// deterministic edit adds a revision awaiting approval (the previous one is superseded); approval starts the build.
import type { Selectable } from "kysely";
import { type Db, json } from "../db/index.js";
import type { SystemPlansTable } from "../db/types.js";
import type { TxCtx } from "../runs/events.js";

export type PlanRow = Selectable<SystemPlansTable>;

export interface NewPlanRevision {
  systemId: string;
  plan: Record<string, unknown>;
  errors: readonly unknown[];
  fingerprint: string | null;
  source: "planner" | "edit";
  runId?: string | null;
  authorUserId?: string | null;
}

/** Caller MUST hold the systems row lock: revision = max+1, the awaiting one becomes superseded. */
export async function insertPlanRevision(t: TxCtx, p: NewPlanRevision): Promise<PlanRow> {
  const { last } = await t.trx
    .selectFrom("platform.system_plans")
    .select((eb) => eb.fn.coalesce(eb.fn.max("revision"), eb.lit(0)).as("last"))
    .where("system_id", "=", p.systemId)
    .executeTakeFirstOrThrow();
  await t.trx
    .updateTable("platform.system_plans")
    .set({ status: "superseded" })
    .where("system_id", "=", p.systemId)
    .where("status", "=", "awaiting_approval")
    .execute();
  return t.trx
    .insertInto("platform.system_plans")
    .values({
      system_id: p.systemId,
      revision: Number(last) + 1,
      status: "awaiting_approval",
      source: p.source,
      plan: json(p.plan),
      errors: json(p.errors),
      fingerprint: p.fingerprint,
      run_id: p.runId ?? null,
      author_user_id: p.authorUserId ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/** A revision of the system's plan, or the latest one. */
export async function loadPlan(
  db: Db | TxCtx["trx"],
  systemId: string,
  revision?: number,
): Promise<PlanRow | undefined> {
  let q = db.selectFrom("platform.system_plans").selectAll().where("system_id", "=", systemId);
  if (revision !== undefined) q = q.where("revision", "=", revision);
  return q.orderBy("revision", "desc").limit(1).executeTakeFirst();
}
