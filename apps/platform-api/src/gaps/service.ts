// «Запросы на развитие» (product.yaml#decisions.D73_development_requests, M2-59 mvp_scope): what a client asked for
// beyond the platform's abilities. The agents record it from a run through the host (recordDevelopmentRequest: the
// interview and the builder report_capability_gap); /admin groups the requests by category and frequency and links to
// the system and the client. The quote comes scrubbed of personal data; it is scrubbed once more before it is stored.
import {
  DEVELOPMENT_REQUEST_CATEGORIES,
  type DevelopmentRequestCategory,
  type DevelopmentRequestInput,
} from "@wizard/agents";
import { scrub } from "@wizard/pii";
import { sql } from "kysely";
import type { Db } from "../db/index.js";

/** The agents' contract (@wizard/agents gaps.ts): categories and the host method input. */
export const DEVELOPMENT_CATEGORIES = DEVELOPMENT_REQUEST_CATEGORIES;
export type DevelopmentCategory = DevelopmentRequestCategory;
export type { DevelopmentRequestInput };

const QUOTE_MAX = 1000;
const cut = (s: string) => (s.length > QUOTE_MAX ? `${s.slice(0, QUOTE_MAX - 1)}…` : s);

export const isDevelopmentCategory = (c: unknown): c is DevelopmentCategory =>
  typeof c === "string" && (DEVELOPMENT_CATEGORIES as readonly string[]).includes(c);

/**
 * Stores one request of a run (idempotent per run, category and quote). An unknown category is stored as other, an
 * empty quote is ignored; returns whether a row was written.
 */
export async function recordDevelopmentRequest(
  db: Db,
  /** id null — not from a run (V3-32: the compatibility check of a repository). */
  run: { id: string | null; org_id: string; system_id: string | null; started_by: string | null },
  input: DevelopmentRequestInput,
): Promise<boolean> {
  const quote = cut(scrub(String(input.quote ?? "")).text.trim());
  if (!quote) return false;
  const offeredRaw = input.offered ? scrub(String(input.offered)).text.trim() : "";
  const row = await db
    .insertInto("platform.development_requests")
    .values({
      org_id: run.org_id,
      system_id: run.system_id,
      run_id: run.id,
      user_id: run.started_by,
      category: isDevelopmentCategory(input.category) ? input.category : "other",
      quote,
      offered: offeredRaw ? cut(offeredRaw) : null,
    })
    .onConflict((oc) =>
      oc.expression(sql`run_id, category, md5(quote)`).where("run_id", "is not", null).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

/** SystemPlan.outOfScope.category (modules.yaml#system_plan) → the category of «Запросы на развитие» (D73). */
const PLAN_CATEGORY: Readonly<Record<string, DevelopmentCategory>> = {
  payments: "payments",
  integration: "integration",
  mobile_app: "mobile",
  ai: "ai",
};

/**
 * modules.yaml#system_plan.outOfScope: «каждая запись уходит в «Запросы на развитие»» — the approved plan's out-of-scope
 * items, recorded with the build run of approveSystemPlan (B2-41: found by the D76 dry run — nothing recorded them
 * unless the model also called report_capability_gap). A request already recorded for the system is not repeated (a
 * rebuild approves the same items again). Returns the number of rows written.
 */
export async function recordPlanOutOfScope(
  db: Db,
  run: { id: string; org_id: string; system_id: string | null; started_by: string | null },
  outOfScope: readonly { request?: unknown; replacement?: unknown; category?: unknown }[],
): Promise<number> {
  let n = 0;
  for (const o of outOfScope) {
    const category = PLAN_CATEGORY[String(o.category)] ?? "other";
    const quote = cut(scrub(String(o.request ?? "")).text.trim());
    if (!quote) continue;
    if (run.system_id) {
      const seen = await db
        .selectFrom("platform.development_requests")
        .select("id")
        .where("system_id", "=", run.system_id)
        .where("category", "=", category)
        .where("quote", "=", quote)
        .executeTakeFirst();
      if (seen) continue;
    }
    const replacement = String(o.replacement ?? "").trim();
    if (await recordDevelopmentRequest(db, run, { category, quote, offered: replacement || null })) n += 1;
  }
  return n;
}

export interface CategoryStat {
  category: DevelopmentCategory;
  last7: number;
  last30: number;
  total: number;
  systems: number;
  lastAt: Date;
}

export interface DevelopmentRequestRow {
  id: string;
  category: DevelopmentCategory;
  quote: string;
  offered: string | null;
  createdAt: Date;
  orgId: string;
  orgName: string;
  systemId: string | null;
  systemName: string | null;
  email: string | null;
  /** B2-26: done — a ready module covers the request (module factory); candidateId — its module candidate. */
  status: "open" | "done";
  doneAt: Date | null;
  candidateId: string | null;
}

const DAY_MS = 86_400_000;

/** /admin: categories by frequency (30 days, then all time) and the latest requests (optionally of one category). */
export async function developmentRequests(
  db: Db,
  o: { now: Date; category?: DevelopmentCategory | undefined; limit?: number },
): Promise<{ categories: CategoryStat[]; items: DevelopmentRequestRow[] }> {
  const d7 = new Date(o.now.getTime() - 7 * DAY_MS);
  const d30 = new Date(o.now.getTime() - 30 * DAY_MS);
  const stats = await db
    .selectFrom("platform.development_requests")
    .select([
      "category",
      sql<number>`count(*) filter (where created_at > ${d7})::int`.as("last7"),
      sql<number>`count(*) filter (where created_at > ${d30})::int`.as("last30"),
      sql<number>`count(*)::int`.as("total"),
      sql<number>`count(distinct system_id)::int`.as("systems"),
      sql<Date>`max(created_at)`.as("last_at"),
    ])
    .groupBy("category")
    .orderBy(sql`count(*) filter (where created_at > ${d30})`, "desc")
    .orderBy(sql`count(*)`, "desc")
    .orderBy("category")
    .execute();
  let q = db
    .selectFrom("platform.development_requests as r")
    .innerJoin("platform.orgs as o", "o.id", "r.org_id")
    .leftJoin("platform.systems as s", "s.id", "r.system_id")
    .leftJoin("platform.users as u", "u.id", "r.user_id")
    .select([
      "r.id",
      "r.category",
      "r.quote",
      "r.offered",
      "r.created_at",
      "r.org_id",
      "o.name as org_name",
      "r.system_id",
      "s.name as system_name",
      "u.email",
      "r.status",
      "r.done_at",
      "r.candidate_id",
    ]);
  if (o.category) q = q.where("r.category", "=", o.category);
  const rows = await q
    .orderBy("r.created_at", "desc")
    .limit(o.limit ?? 50)
    .execute();
  return {
    categories: stats.map((s) => ({
      category: s.category as DevelopmentCategory,
      last7: Number(s.last7),
      last30: Number(s.last30),
      total: Number(s.total),
      systems: Number(s.systems),
      lastAt: new Date(s.last_at),
    })),
    items: rows.map((r) => ({
      id: r.id,
      category: r.category as DevelopmentCategory,
      quote: r.quote,
      offered: r.offered,
      createdAt: new Date(r.created_at),
      orgId: r.org_id,
      orgName: r.org_name,
      systemId: r.system_id,
      systemName: r.system_name ?? null,
      email: r.email ?? null,
      status: r.status,
      doneAt: r.done_at ? new Date(r.done_at) : null,
      candidateId: r.candidate_id,
    })),
  };
}
