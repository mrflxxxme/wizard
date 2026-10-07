// /systems/:id/plan* of specs/platform/api.yaml (B2-20, beta v2): the system plan awaiting approval — read it with its
// sketch, edit it deterministically (no model: compiled again in milliseconds), approve it — only then the build starts.
import {
  applyPlanEdits,
  DEFAULT_REGISTRY,
  type PlanView,
  planBuildCapCredits,
  planEditsSchema,
  viewPlan,
} from "@wizard/agents/planner";
import type { SystemPlan } from "@wizard/appspec";
import { Hono } from "hono";
import type { Selectable } from "kysely";
import { z } from "zod";
import type { SystemsTable } from "../db/types.js";
import { ApiError, notFound } from "../errors.js";
import { recordPlanOutOfScope } from "../gaps/service.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid, type OrgRole } from "../http/auth.js";
import { type Deps, jsonBody, parseQuery } from "../http/util.js";
import { withTx } from "../runs/events.js";
import { insertRun } from "../runs/queue.js";
import { insertPlanRevision, loadPlan, type PlanRow } from "../services/plans.js";
import { lockSystem } from "../services/revisions.js";
import { toRun } from "../services/serialize.js";
import { assertTransition } from "../services/stage.js";

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

/** api.yaml#/components/schemas/SystemPlanRevision: the stored plan, compiled again now (errors and sketch). */
export function toPlanRevision(row: PlanRow, view: PlanView, extra: { dryRun?: boolean } = {}) {
  return {
    revision: row.revision,
    status: row.status,
    source: row.source,
    plan: row.plan,
    errors: view.errors,
    sketch: view.sketch,
    fingerprint: view.sketch?.fingerprint ?? null,
    createdAt: iso(row.created_at),
    approvedAt: iso(row.approved_at),
    buildRunId: row.build_run_id,
    ...(extra.dryRun ? { dryRun: true } : {}),
  };
}

const revisionQ = z.object({ revision: z.coerce.number().int().min(1).optional() });

export function planRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const registry = d.modules ?? DEFAULT_REGISTRY;
  const tx = <T>(fn: Parameters<typeof withTx<T>>[2]) => withTx(d.db, d.bus, fn);

  async function loadSystem(
    user: AuthUser,
    id: string | undefined,
    min: OrgRole,
  ): Promise<Selectable<SystemsTable>> {
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(user, s.org_id, min, "Система");
    return s;
  }

  /** The asked revision (404 when absent) or the latest one (null before the interview reaches a plan). */
  async function planOf(systemId: string, revision?: number): Promise<PlanRow | null> {
    const row = await loadPlan(d.db, systemId, revision);
    if (!row && revision !== undefined) throw notFound("Ревизия плана");
    return row ?? null;
  }

  // getSystemPlan
  r.get("/systems/:id/plan", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const q = parseQuery(c, revisionQ);
    const row = await planOf(s.id, q.revision);
    if (!row) return c.json({ plan: null });
    return c.json({ plan: toPlanRevision(row, viewPlan(row.plan, registry, { appName: s.name })) });
  });

  // getSystemPlanSketch: the canvas — the light sketch, or with detail=full the compiled spec and files as well.
  r.get("/systems/:id/plan/sketch", async (c) => {
    const s = await loadSystem(c.get("user"), c.req.param("id"), "viewer");
    const q = parseQuery(c, revisionQ.extend({ detail: z.enum(["sketch", "full"]).default("sketch") }));
    const row = await planOf(s.id, q.revision);
    if (!row) return c.json({ revision: null, sketch: null });
    const view = viewPlan(row.plan, registry, { appName: s.name });
    return c.json({
      revision: row.revision,
      sketch: view.sketch,
      ...(q.detail === "full" && view.compiled.ok
        ? { spec: view.compiled.spec, files: view.compiled.files }
        : {}),
    });
  });

  // editSystemPlan: deterministic edits of the plan awaiting approval (no model, no credits); B2-29 — also of the
  // approved plan of a built system (the rebuild starts from approveSystemPlan).
  r.patch("/systems/:id/plan", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "editor");
    const b = await jsonBody(
      c,
      z.strictObject({
        revision: z.number().int().min(1),
        edits: planEditsSchema,
        dryRun: z.boolean().default(false),
      }),
    );
    const out = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      if (s.stage === "building") throw new ApiError("SYSTEM_LOCKED", "Идёт сборка — дождитесь её окончания");
      const row = await loadPlan(t.trx, s.id);
      // B2-29: a built system edits its approved plan too — the edit becomes a revision awaiting approval (stage
      // card) and reaches the system with the rebuild (approveSystemPlan, build mode change).
      const rebuild = row?.status === "approved" && s.stage === "ready";
      if (!row || (row.status !== "awaiting_approval" && !rebuild))
        throw new ApiError("NO_PLAN", "Нет плана, ожидающего утверждения");
      if (row.revision !== b.revision)
        throw new ApiError("PLAN_REVISION_STALE", "План изменился — посмотрите новую версию", {
          revision: row.revision,
        });
      const edited = applyPlanEdits(row.plan as unknown as SystemPlan, b.edits, registry, {
        appName: s.name,
      });
      if (!edited.ok)
        throw new ApiError("PLAN_INVALID", edited.errors[0]?.message_ru ?? "План не собирается", {
          errors: edited.errors,
        });
      const plan = edited.plan as unknown as Record<string, unknown>;
      const view = viewPlan(plan, registry, { appName: s.name });
      if (b.dryRun) return toPlanRevision({ ...row, plan }, view, { dryRun: true });
      const next = await insertPlanRevision(t, {
        systemId: s.id,
        plan,
        errors: [],
        fingerprint: view.sketch?.fingerprint ?? null,
        source: "edit",
        authorUserId: user.id,
      });
      await t.trx
        .updateTable("platform.systems")
        .set({
          ...(rebuild ? { stage: assertTransition(s.stage, "card") } : {}),
          last_activity_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", s.id)
        .execute();
      return toPlanRevision(next, view);
    });
    return c.json({ plan: out });
  });

  // approveSystemPlan: the only point where a build of the modules pipeline starts.
  r.post("/systems/:id/plan/approve", async (c) => {
    const user = c.get("user");
    const s0 = await loadSystem(user, c.req.param("id"), "editor");
    const b = await jsonBody(c, z.strictObject({ revision: z.number().int().min(1) }));
    const run = await tx(async (t) => {
      const s = await lockSystem(t, s0.id);
      const row = await loadPlan(t.trx, s.id);
      if (row?.status !== "awaiting_approval" || s.stage !== "card")
        throw new ApiError("NO_PLAN", "Нет плана, ожидающего утверждения");
      if (row.revision !== b.revision)
        throw new ApiError("PLAN_REVISION_STALE", "План изменился — посмотрите новую версию", {
          revision: row.revision,
        });
      // Compiled again under the lock: the catalog may have changed since the plan was made.
      const view = viewPlan(row.plan, registry, { appName: s.name });
      if (!view.compiled.ok)
        throw new ApiError("PLAN_INVALID", view.errors[0]?.message_ru ?? "План не собирается", {
          errors: view.errors,
        });
      const plan = view.compiled.plan;
      const cap = planBuildCapCredits(plan);
      await t.trx
        .updateTable("platform.systems")
        .set({
          stage: assertTransition(s.stage, "building"),
          updated_at: new Date(),
          last_activity_at: new Date(),
        })
        .where("id", "=", s.id)
        .execute();
      const build = await insertRun(
        t,
        {
          orgId: s.org_id,
          systemId: s.id,
          kind: "build",
          mode: s.preview_revision !== null ? "change" : "create",
          input: { pipeline: "modules", planRevision: row.revision, plan },
          capMilli: cap * 1000,
          startedBy: user.id,
        },
        d.billing,
      );
      await t.trx
        .updateTable("platform.system_plans")
        .set({ status: "approved", approved_at: new Date(), approved_by: user.id, build_run_id: build.id })
        .where("system_id", "=", s.id)
        .where("revision", "=", row.revision)
        .execute();
      // modules.yaml#system_plan.outOfScope: what the approved plan leaves out goes to «Запросы на развитие».
      await recordPlanOutOfScope(
        t.trx,
        { id: build.id, org_id: s.org_id, system_id: s.id, started_by: user.id },
        plan.outOfScope,
      );
      return build;
    });
    d.engine.enqueue(run);
    return c.json({ run: toRun(run, 0) }, 202);
  });

  return r;
}
