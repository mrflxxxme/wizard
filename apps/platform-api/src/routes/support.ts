// «Написать команде» (api.yaml createSupportRequest, adminListSupportRequests, adminMarkSupportRequest; D68, M2-35
// mvp_scope): the client sends a message from any cabinet screen; the founder gets it in Telegram and answers by letter;
// /admin lists the copies with the «отвечено» mark. Staff paths: non-staff 404, no MFA 403; every mark — staff_audit_log.
import { Hono } from "hono";
import { z } from "zod";
import { type AbuseDeps, staffAudit } from "../abuse/reports.js";
import { type StaffDeps, staffGuard } from "../abuse/staff.js";
import { notFound } from "../errors.js";
import { type AppEnv, checkOrgAccess, isUuid } from "../http/auth.js";
import { jsonBody, parseQuery } from "../http/util.js";
import { createSupportRequest, listSupportRequests, markSupportAnswered } from "../support/service.js";

export type SupportRouteDeps = AbuseDeps & StaffDeps & { supportNow?: (() => Date) | undefined };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

export function supportRoutes(d: SupportRouteDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const staff = staffGuard(d);
  const now = () => d.supportNow?.() ?? new Date();

  r.post("/support/requests", async (c) => {
    const b = await jsonBody(
      c,
      z.object({
        text: z.string().trim().min(1).max(4000),
        wantsTeam: z.boolean().optional(),
        systemId: uuid.optional(),
        orgId: uuid.optional(),
        screen: z
          .string()
          .trim()
          .max(64)
          .regex(/^[a-z0-9_-]*$/)
          .optional(),
      }),
    );
    const user = c.get("user");
    let orgId = b.orgId ?? user.defaultOrgId;
    if (b.systemId) {
      const sys = await d.db
        .selectFrom("platform.systems")
        .select("org_id")
        .where("id", "=", b.systemId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!sys || !user.orgs.has(sys.org_id)) throw notFound("Система");
      orgId = sys.org_id;
    }
    checkOrgAccess(user, orgId, "viewer", "Организация");
    const res = await createSupportRequest(
      { db: d.db, platformOrigin: d.config.platformOrigin, alert: d.alert, now: now() },
      {
        orgId,
        userId: user.id,
        email: user.email,
        systemId: b.systemId ?? null,
        screen: b.screen || null,
        text: b.text,
        wantsTeam: b.wantsTeam ?? false,
      },
    );
    return c.json({ id: res.id, replyBy: res.replyBy.toISOString(), message_ru: res.message_ru }, 201);
  });

  r.get("/admin/support/requests", staff, async (c) => {
    const q = parseQuery(c, z.object({ status: z.enum(["open", "all"]).optional() }));
    const items = await listSupportRequests(d.db, { status: q.status ?? "all" });
    c.header("cache-control", "no-store");
    return c.json({
      items: items.map((x) => ({
        id: x.id,
        orgId: x.orgId,
        orgName: x.orgName,
        email: x.email,
        systemId: x.systemId,
        systemName: x.systemName,
        screen: x.screen,
        text: x.text,
        wantsTeam: x.wantsTeam,
        createdAt: x.createdAt.toISOString(),
        replyBy: x.replyBy.toISOString(),
        answeredAt: iso(x.answeredAt),
      })),
    });
  });

  r.post("/admin/support/requests/:requestId/answered", staff, async (c) => {
    const id = c.req.param("requestId");
    if (!isUuid(id)) throw notFound("Обращение");
    const b = await jsonBody(c, z.object({ answered: z.boolean() }));
    const actor = c.get("user").id;
    const res = await markSupportAnswered(d.db, { id, answered: b.answered, by: actor, now: now() });
    if (!res) throw notFound("Обращение");
    await staffAudit(
      d.db,
      actor,
      b.answered ? "support_answered" : "support_reopened",
      `support_request:${id}`,
    );
    return c.json({ id, answeredAt: iso(res.answeredAt) });
  });

  return r;
}
