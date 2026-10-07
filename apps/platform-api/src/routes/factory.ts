// /admin «Кандидаты в модули» (api.yaml adminModuleCandidates, adminModuleCandidate, adminDecideModuleCandidate,
// adminRecomputeModuleCandidates; B2-26, grill-6 decision 4) and the client's consent to «Теперь умеем» letters
// (getUpdatesConsent / setUpdatesConsent). Staff paths: non-staff 404, no MFA 403; every decision — staff_audit_log.
import type { ModuleRegistry } from "@wizard/agents/planner";
import { Hono } from "hono";
import { z } from "zod";
import type { AbuseDeps } from "../abuse/reports.js";
import { staffAudit } from "../abuse/reports.js";
import { type StaffDeps, staffGuard } from "../abuse/staff.js";
import { notFound } from "../errors.js";
import {
  CANDIDATE_ACTIONS,
  CANDIDATE_FILTERS,
  type CandidateRequest,
  type CandidateView,
  decideModuleCandidate,
  listModuleCandidates,
  moduleCandidateCard,
  recomputeModuleCandidates,
  setUpdatesConsent,
} from "../gaps/factory.js";
import { type AppEnv, isUuid } from "../http/auth.js";
import { jsonBody, parseQuery } from "../http/util.js";

export type FactoryRouteDeps = AbuseDeps &
  StaffDeps & { factoryNow?: (() => Date) | undefined; modules?: ModuleRegistry | undefined };

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const candidateJson = (c: CandidateView) => ({
  ...c,
  lastSeenAt: iso(c.lastSeenAt),
  computedAt: iso(c.computedAt),
  decidedAt: iso(c.decidedAt),
  readyAt: iso(c.readyAt),
});
const requestJson = (r: CandidateRequest) => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
  doneAt: iso(r.doneAt),
});

export function factoryRoutes(d: FactoryRouteDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const staff = staffGuard(d);
  const now = () => d.factoryNow?.() ?? new Date();
  const announce = {
    db: d.db,
    mailer: d.mailer,
    platformOrigin: d.config.platformOrigin,
    ...(d.modules ? { registry: d.modules } : {}),
    ...(d.log ? { log: d.log } : {}),
  };

  r.get("/me/updates-consent", async (c) => {
    const u = await d.db
      .selectFrom("platform.users")
      .select("updates_consent_at")
      .where("id", "=", c.get("user").id)
      .executeTakeFirst();
    return c.json({
      on: !!u?.updates_consent_at,
      since: iso(u?.updates_consent_at ? new Date(u.updates_consent_at) : null),
    });
  });

  r.put("/me/updates-consent", async (c) => {
    const b = await jsonBody(c, z.object({ on: z.boolean() }));
    const at = now();
    await setUpdatesConsent(d.db, c.get("user").id, b.on, at);
    return c.json({ on: b.on, since: b.on ? at.toISOString() : null });
  });

  r.get("/admin/module-candidates", staff, async (c) => {
    const q = parseQuery(c, z.object({ status: z.enum(CANDIDATE_FILTERS).optional() }));
    const res = await listModuleCandidates(d.db, {
      ...(q.status ? { status: q.status } : {}),
      ...(d.modules ? { registry: d.modules } : {}),
    });
    c.header("cache-control", "no-store");
    return c.json({
      computedAt: iso(res.computedAt),
      items: res.items.map(candidateJson),
      modules: res.modules,
    });
  });

  r.post("/admin/module-candidates/recompute", staff, async (c) => {
    const res = await recomputeModuleCandidates(announce, now());
    await staffAudit(d.db, c.get("user").id, "module_candidates_recompute", "module_candidates");
    return c.json({
      computedAt: res.computedAt.toISOString(),
      candidates: res.candidates,
      sent: res.announced.reduce((n, a) => n + a.sent, 0),
    });
  });

  r.get("/admin/module-candidates/:candidateId", staff, async (c) => {
    const id = c.req.param("candidateId");
    if (!isUuid(id)) throw notFound("Кандидат");
    const card = await moduleCandidateCard(d.db, id, d.modules);
    if (!card) throw notFound("Кандидат");
    c.header("cache-control", "no-store");
    return c.json({
      candidate: candidateJson(card.candidate),
      requests: card.requests.map(requestJson),
      notified: card.notified,
    });
  });

  r.post("/admin/module-candidates/:candidateId/decision", staff, async (c) => {
    const id = c.req.param("candidateId");
    if (!isUuid(id)) throw notFound("Кандидат");
    const b = await jsonBody(
      c,
      z.object({
        action: z.enum(CANDIDATE_ACTIONS),
        moduleId: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/)
          .optional(),
        note: z.string().max(500).optional(),
      }),
    );
    const actor = c.get("user").id;
    const res = await decideModuleCandidate(
      announce,
      { id, action: b.action, moduleId: b.moduleId, note: b.note, by: actor },
      now(),
    );
    if (!res) throw notFound("Кандидат");
    await staffAudit(
      d.db,
      actor,
      `module_candidate_${b.action}`,
      `module_candidate:${id}`,
      res.candidate.moduleId ? `module:${res.candidate.moduleId}` : null,
    );
    return c.json({
      candidate: candidateJson(res.candidate),
      announced: res.announced
        ? {
            done: res.announced.done,
            sent: res.announced.sent,
            noConsent: res.announced.noConsent,
            failed: res.announced.failed,
          }
        : null,
    });
  });

  return r;
}
