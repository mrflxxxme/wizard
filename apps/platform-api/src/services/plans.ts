// System plan revisions of the beta v2 path (B2-20, db.yaml#system_plans, api.yaml#getSystemPlan): the planner or a
// deterministic edit adds a revision awaiting approval (the previous one is superseded); approval starts the build.
import { type Selectable, sql } from "kysely";
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

/**
 * Pipeline of a system for the platform screens (B2-25, api.yaml#getSystem.pipeline): «modules» once it has a plan or
 * its interview state is a goal session, «legacy» once it has a card or a v1 interview state; a fresh system follows
 * WIZARD_BUILD_PIPELINE — the same rule as the interview executor (a system keeps the pipeline it started with).
 */
export async function systemPipeline(
  db: Db,
  s: { id: string; card: unknown },
  fallback: "legacy" | "modules",
): Promise<"legacy" | "modules"> {
  if (s.card) return "legacy";
  const plan = await db
    .selectFrom("platform.system_plans")
    .select("revision")
    .where("system_id", "=", s.id)
    .limit(1)
    .executeTakeFirst();
  if (plan) return "modules";
  const last = await db
    .selectFrom("platform.runs")
    .select(sql<unknown>`input -> 'executorState'`.as("state"))
    .where("system_id", "=", s.id)
    .where("kind", "=", "interview_turn")
    .where(sql<boolean>`input ? 'executorState'`)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  const state = last?.state as { pipeline?: unknown } | null | undefined;
  if (state && typeof state === "object") return state.pipeline === "modules" ? "modules" : "legacy";
  return fallback;
}
