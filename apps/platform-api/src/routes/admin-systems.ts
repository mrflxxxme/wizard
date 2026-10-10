// /admin «Системы и сбои» (V3-18, api.yaml adminListSystems / adminListRuns): the founder sees every client system — its
// org, stage, published revision, the last build and what it cost — and the failed runs with the code and the Russian
// text the client saw. Staff only (non-staff 404, no MFA 403 — staffGuard as the other /admin routes). Read only; no
// client data beyond names (no briefs, messages or system rows).
import { Hono } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import { type StaffDeps, staffGuard } from "../abuse/staff.js";
import type { AppEnv } from "../http/auth.js";
import { parseQuery } from "../http/util.js";

/** Run statuses of platform.runs (db.yaml). */
export const RUN_STATUSES = [
  "queued",
  "waiting_lock",
  "running",
  "needs_input",
  "succeeded",
  "failed",
  "cancelled",
] as const;

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const num = (v: unknown) => Number(v ?? 0);
const limitParam = z.coerce.number().int().min(1).max(200).default(100);

export function adminSystemsRoutes(d: StaffDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const staff = staffGuard(d);

  // Systems (not deleted), the latest active first: org, stage, revisions, the last build, model spend and credits.
  r.get("/admin/systems", staff, async (c) => {
    const q = parseQuery(c, z.object({ limit: limitParam }));
    const rows = await d.db
      .selectFrom("platform.systems as s")
      .innerJoin("platform.orgs as o", "o.id", "s.org_id")
      .leftJoinLateral(
        (eb) =>
          eb
            .selectFrom("platform.runs as b")
            .select(["b.status", "b.failure_code", "b.created_at", "b.finished_at"])
            .whereRef("b.system_id", "=", "s.id")
            .where("b.kind", "=", "build")
            .orderBy("b.created_at", "desc")
            .limit(1)
            .as("lb"),
        (join) => join.onTrue(),
      )
      .select([
        "s.id",
        "s.name",
        "s.slug",
        "s.stage",
        "s.draft_revision",
        "s.preview_revision",
        "s.prod_revision",
        "s.suspended_at",
        "s.last_activity_at",
        "s.created_at",
        "o.id as org_id",
        "o.name as org_name",
        "o.kind as org_kind",
        "lb.status as build_status",
        "lb.failure_code as build_failure_code",
        "lb.created_at as build_at",
        (eb) =>
          eb
            .selectFrom("platform.llm_calls as l")
            .select(sql<string>`coalesce(sum(l.cost_rub), 0)`.as("v"))
            .whereRef("l.system_id", "=", "s.id")
            .as("model_rub"),
        (eb) =>
          eb
            .selectFrom("platform.runs as x")
            .select(sql<string>`coalesce(sum(x.credits_used_milli), 0)`.as("v"))
            .whereRef("x.system_id", "=", "s.id")
            .as("credits_milli"),
      ])
      .where("s.deleted_at", "is", null)
      .orderBy("s.last_activity_at", "desc")
      .orderBy("s.id")
      .limit(q.limit)
      .execute();
    c.header("cache-control", "no-store");
    return c.json({
      items: rows.map((x) => ({
        id: x.id,
        name: x.name,
        slug: x.slug,
        org: { id: x.org_id, name: x.org_name, kind: x.org_kind },
        stage: x.stage,
        suspended: x.suspended_at !== null,
        draftRevision: x.draft_revision,
        previewRevision: x.preview_revision,
        publishedRevision: x.prod_revision,
        lastBuild: x.build_status
          ? { status: x.build_status, failureCode: x.build_failure_code, at: iso(x.build_at) }
          : null,
        modelSpendRub: Math.round(num(x.model_rub) * 100) / 100,
        creditsUsed: num(x.credits_milli) / 1000,
        lastActivityAt: iso(x.last_activity_at),
        createdAt: iso(x.created_at),
      })),
    });
  });

  // Runs by status (default: failed), the latest first: org, system, kind, the error and what the run cost.
  r.get("/admin/runs", staff, async (c) => {
    const q = parseQuery(
      c,
      z.object({
        status: z.enum(RUN_STATUSES).default("failed"),
        kind: z
          .string()
          .regex(/^[a-z_]{1,40}$/)
          .optional(),
        limit: limitParam,
      }),
    );
    let query = d.db
      .selectFrom("platform.runs as r")
      .innerJoin("platform.orgs as o", "o.id", "r.org_id")
      .leftJoin("platform.systems as s", "s.id", "r.system_id")
      .select([
        "r.id",
        "r.kind",
        "r.mode",
        "r.status",
        "r.failure_code",
        "r.failure_message_ru",
        "r.credits_used_milli",
        "r.created_at",
        "r.finished_at",
        "o.id as org_id",
        "o.name as org_name",
        "s.id as system_id",
        "s.name as system_name",
        (eb) =>
          eb
            .selectFrom("platform.llm_calls as l")
            .select(sql<string>`coalesce(sum(l.cost_rub), 0)`.as("v"))
            .whereRef("l.run_id", "=", "r.id")
            .as("model_rub"),
      ])
      .where("r.status", "=", q.status);
    if (q.kind) query = query.where("r.kind", "=", q.kind);
    const rows = await query
      .orderBy(sql`coalesce(r.finished_at, r.created_at)`, "desc")
      .orderBy("r.id")
      .limit(q.limit)
      .execute();
    c.header("cache-control", "no-store");
    return c.json({
      items: rows.map((x) => ({
        id: x.id,
        org: { id: x.org_id, name: x.org_name },
        system: x.system_id ? { id: x.system_id, name: x.system_name } : null,
        kind: x.kind,
        mode: x.mode,
        status: x.status,
        errorCode: x.failure_code,
        messageRu: x.failure_message_ru,
        modelSpendRub: Math.round(num(x.model_rub) * 100) / 100,
        creditsUsed: num(x.credits_used_milli) / 1000,
        createdAt: iso(x.created_at),
        finishedAt: iso(x.finished_at),
      })),
    });
  });

  return r;
}
