// /admin/* of api.yaml (x-roles: [staff], x-auth M2; M2-08): staff session and TOTP step-up, the moderation queue and
// ticket actions, staff access to system data by a ticket (24 h), founder reviews (adminFounderReview; the CLI
// `moderation` keeps working) and org flags. Every action is written to staff_audit_log; non-staff get 404.
import { Hono } from "hono";
import { z } from "zod";
import { setOrgSuspension } from "../abuse/escalation.js";
import {
  type AbuseDeps,
  abuseTicket,
  applyAbuseAction,
  listAbuseReports,
  openStaffAccess,
  REPORT_CATEGORIES,
  reportTarget,
  staffAudit,
  staffSystemData,
} from "../abuse/reports.js";
import { confirmMfa, enrollMfa, type StaffDeps, staffGuard, staffState, verifyMfa } from "../abuse/staff.js";
import { invalid, notFound } from "../errors.js";
import { type AppEnv, isUuid } from "../http/auth.js";
import { jsonBody, parseQuery } from "../http/util.js";
import { decideFounderReview, pendingFounderReviews } from "../publish/moderation.js";

const STATUSES = ["new", "triaged", "takedown", "dismissed", "restored"] as const;
const code = z.string().regex(/^[0-9]{6}$/);
const note = z.string().trim().min(3).max(2000);

const uuidParam = (v: string | undefined, what: string): string => {
  if (!isUuid(v)) throw notFound(what);
  return v;
};

export function adminRoutes(d: AbuseDeps & StaffDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const setup = staffGuard(d, { mfaSetup: true });
  const staff = staffGuard(d);
  r.use("/admin/*", async (c, next) => {
    c.header("cache-control", "no-store");
    return next();
  });

  // Staff state of this session (the console decides: enrol, verify or the queue).
  r.get("/admin/session", setup, async (c) => {
    const u = c.get("user");
    return c.json({ email: u.email, ...(await staffState(d, u.id, c.get("sessionId"))) });
  });
  r.post("/admin/mfa/enroll", setup, async (c) =>
    c.json(await enrollMfa(d, c.get("user").id, c.get("sessionId"))),
  );
  r.post("/admin/mfa/confirm", setup, async (c) => {
    const b = await jsonBody(c, z.object({ code }));
    return c.json(await confirmMfa(d, c.get("user").id, c.get("sessionId"), b.code));
  });
  r.post("/admin/mfa/verify", setup, async (c) => {
    const b = await jsonBody(
      c,
      z
        .object({ code: code.optional(), recoveryCode: z.string().trim().min(10).max(20).optional() })
        .refine((x) => !!x.code !== !!x.recoveryCode),
    );
    return c.json(await verifyMfa(d, c.get("user").id, c.get("sessionId"), b));
  });

  // Moderation queue (adminListAbuseReports): open tickets by sla_deadline.
  r.get("/admin/abuse-reports", staff, async (c) => {
    const q = parseQuery(c, z.object({ status: z.enum(STATUSES).optional() }));
    return c.json({ items: await listAbuseReports(d.db, q.status) });
  });

  // Ticket view (complaint text and the reporter's e-mail are personal data: the view is journaled).
  r.get("/admin/abuse-reports/:reportId", staff, async (c) => {
    const id = uuidParam(c.req.param("reportId"), "Жалоба");
    const t = await abuseTicket(d, id);
    await staffAudit(d.db, c.get("user").id, "abuse_view", reportTarget(id));
    return c.json(t);
  });

  r.post("/admin/abuse-reports/:reportId/actions", staff, async (c) => {
    const id = uuidParam(c.req.param("reportId"), "Жалоба");
    const b = await jsonBody(
      c,
      z.object({
        action: z.enum(["triage", "takedown", "dismiss", "restore"]),
        note,
        category: z.enum(REPORT_CATEGORIES).optional(),
      }),
    );
    return c.json(await applyAbuseAction(d, { reportId: id, actor: c.get("user").id, ...b }));
  });

  // Staff access to the ticket's system data for 24 h (owner notified, except phishing).
  r.post("/admin/abuse-reports/:reportId/access", staff, async (c) => {
    const id = uuidParam(c.req.param("reportId"), "Жалоба");
    const b = await jsonBody(c, z.object({ note }));
    const until = await openStaffAccess(d, { reportId: id, actor: c.get("user").id, note: b.note });
    return c.json({ until: until.toISOString() });
  });

  r.get("/admin/abuse-reports/:reportId/data", staff, async (c) => {
    const id = uuidParam(c.req.param("reportId"), "Жалоба");
    const q = parseQuery(
      c,
      z.object({
        entity: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,62}$/)
          .optional(),
      }),
    );
    return c.json(await staffSystemData(d, { reportId: id, actor: c.get("user").id, entity: q.entity }));
  });

  // Founder reviews before prod (M2-04): the queue and the decision (adminFounderReview).
  r.get("/admin/founder-reviews", staff, async (c) => {
    const rows = await pendingFounderReviews(d.db);
    return c.json({
      items: rows.map((x) => ({
        systemId: x.system_id,
        systemName: x.name,
        orgId: x.org_id,
        revision: x.revision,
        createdAt: new Date(x.created_at).toISOString(),
        egressHosts: x.egress_hosts,
        newEgressHosts: x.new_egress_hosts,
      })),
    });
  });

  r.post("/admin/systems/:id/founder-review", staff, async (c) => {
    const systemId = uuidParam(c.req.param("id"), "Система");
    const b = await jsonBody(
      c,
      z.object({
        revision: z.number().int().min(1),
        decision: z.enum(["approve", "reject"]),
        note: z.string().trim().max(2000).optional(),
      }),
    );
    if (b.decision === "reject" && (b.note ?? "").length < 3)
      throw invalid("Напишите владельцу, что исправить");
    const actor = c.get("user").id;
    const ok = await decideFounderReview(
      d.db,
      { systemId, revision: b.revision, decision: b.decision, reviewer: actor, note: b.note ?? null },
      { mailer: d.mailer, platformOrigin: d.config.platformOrigin, log: d.log },
    );
    if (!ok) throw notFound("Ревизия на ревью");
    await staffAudit(
      d.db,
      actor,
      `founder_review_${b.decision}`,
      `system:${systemId}`,
      `ревизия ${b.revision}${b.note ? `: ${b.note}` : ""}`,
    );
    return c.json({
      systemId,
      revision: b.revision,
      status: b.decision === "approve" ? "approved" : "rejected",
    });
  });

  // abuse.yaml#takedown.flow: org-wide suspension for a repeated or obvious violation, and its restore.
  r.post("/admin/orgs/:orgId/suspension", staff, async (c) => {
    const orgId = uuidParam(c.req.param("orgId"), "Организация");
    const b = await jsonBody(
      c,
      z.object({ action: z.enum(["suspend", "restore"]), note, reportId: z.guid().optional() }),
    );
    return c.json(await setOrgSuspension(d, { orgId, actor: c.get("user").id, ...b }));
  });

  r.put("/admin/orgs/:orgId/flags", staff, async (c) => {
    const orgId = uuidParam(c.req.param("orgId"), "Организация");
    const b = await jsonBody(
      c,
      z.object({
        requireFounderReview: z.boolean().optional(),
        passportCollectionAllowed: z.boolean().optional(),
      }),
    );
    const set = {
      ...(b.requireFounderReview === undefined ? {} : { require_founder_review: b.requireFounderReview }),
      ...(b.passportCollectionAllowed === undefined
        ? {}
        : { passport_collection_allowed: b.passportCollectionAllowed }),
    };
    const org = await d.db
      .updateTable("platform.orgs")
      .set(
        Object.keys(set).length ? set : { require_founder_review: (eb) => eb.ref("require_founder_review") },
      )
      .where("id", "=", orgId)
      .returning(["id", "require_founder_review", "passport_collection_allowed"])
      .executeTakeFirst();
    if (!org) throw notFound("Организация");
    await staffAudit(d.db, c.get("user").id, "org_flags", `org:${orgId}`, JSON.stringify(b));
    return c.json({
      orgId,
      requireFounderReview: org.require_founder_review,
      passportCollectionAllowed: org.passport_collection_allowed,
    });
  });

  return r;
}
