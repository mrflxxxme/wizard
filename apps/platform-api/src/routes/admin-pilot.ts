// /admin/pilot/* — the «Пилот» section of the staff console (api.yaml x-roles [staff], x-auth M2; staffGuard: non-staff
// 404, no MFA step-up 403 MFA_REQUIRED): beta_readiness with who/when and its checklist, founder invitations (the
// beta_readiness gate stays in createPilotInvite), pilot orgs with the month's spend, pilot credits, the founder-review
// flag and the platform LLM spend vs WIZARD_LLM_MONTHLY_CAP_RUB. Same functions as the pilot CLI (src/pilot/*); every
// change is written to staff_audit_log. Client e-mails stay out of the journal and logs (only invitation ids).
import { Hono } from "hono";
import { z } from "zod";
import { type AbuseDeps, staffAudit } from "../abuse/reports.js";
import { type StaffDeps, staffGuard } from "../abuse/staff.js";
import type { Billing } from "../billing/ledger.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, isUuid } from "../http/auth.js";
import { jsonBody } from "../http/util.js";
import { createPilotInvite, PilotError } from "../pilot/invites.js";
import {
  BETA_READINESS_CHECKLIST_RU,
  BETA_READINESS_KEY,
  getBetaReadiness,
  setBetaReadiness,
} from "../pilot/readiness.js";
import {
  grantPilotCredits,
  listPilotInvites,
  PILOT_GRANT_MAX,
  pilotOrgs,
  platformLlmSpend,
  revokePilotInvite,
  setFounderReviewRequired,
} from "../pilot/service.js";

export type AdminPilotDeps = AbuseDeps &
  StaffDeps & { billing: Billing; pilotNow?: (() => Date) | undefined };

/** PilotError of the shared functions → api.yaml#Error with the same Russian text. */
async function pilot<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PilotError) throw new ApiError(e.code, e.message);
    throw e;
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const READINESS_TARGET = `platform_settings:${BETA_READINESS_KEY}`;

export function adminPilotRoutes(d: AdminPilotDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const staff = staffGuard(d);
  const now = () => d.pilotNow?.() ?? new Date();

  const readinessView = async () => {
    const x = await getBetaReadiness(d.db);
    return { on: x.on, by: x.by, at: iso(x.at), note: x.note, checklist: BETA_READINESS_CHECKLIST_RU };
  };

  r.get("/admin/pilot/readiness", staff, async (c) => c.json(await readinessView()));

  // Switching on is a statement that M2-13 is done: an explicit confirmation and a note are required.
  r.put("/admin/pilot/readiness", staff, async (c) => {
    const b = await jsonBody(
      c,
      z.object({
        on: z.boolean(),
        confirm: z.boolean().optional(),
        note: z.string().trim().max(500).optional(),
      }),
    );
    const note = b.note ?? "";
    if (b.on && (b.confirm !== true || note.length < 3))
      throw invalid("Подтвердите, что всё из списка сделано, и напишите, что именно (не короче 3 символов)");
    const u = c.get("user");
    await setBetaReadiness(d.db, { on: b.on, by: u.email, note: note || null, now: now() });
    await staffAudit(
      d.db,
      u.id,
      b.on ? "pilot_readiness_on" : "pilot_readiness_off",
      READINESS_TARGET,
      note || null,
    );
    return c.json(await readinessView());
  });

  r.get("/admin/pilot/invites", staff, async (c) => {
    const items = await listPilotInvites(d.db, now());
    return c.json({
      items: items.map((x) => ({
        id: x.id,
        email: x.email,
        orgName: x.orgName,
        credits: x.credits,
        requireFounderReview: x.requireFounderReview,
        status: x.status,
        createdAt: x.createdAt.toISOString(),
        expiresAt: x.expiresAt.toISOString(),
        acceptedAt: iso(x.acceptedAt),
        orgId: x.orgId,
      })),
    });
  });

  r.post("/admin/pilot/invites", staff, async (c) => {
    const b = await jsonBody(
      c,
      z.object({
        email: z.string().trim().min(3).max(254),
        orgName: z.string().trim().max(120).optional(),
        credits: z.number().int().min(0).max(PILOT_GRANT_MAX).optional(),
        requireFounderReview: z.boolean().optional(),
      }),
    );
    const review = b.requireFounderReview ?? true;
    const res = await pilot(
      createPilotInvite(
        d.db,
        d.mailer,
        { platformOrigin: d.config.platformOrigin, now: now() },
        { email: b.email, orgName: b.orgName ?? null, credits: b.credits ?? 0, requireFounderReview: review },
      ),
    );
    await staffAudit(
      d.db,
      c.get("user").id,
      "pilot_invite",
      `pilot_invite:${res.id}`,
      `кредиты ${b.credits ?? 0}, ревью ${review ? "вкл" : "выкл"}`,
    );
    return c.json(
      {
        id: res.id,
        email: res.email,
        expiresAt: res.expiresAt.toISOString(),
        link: res.link,
        requireFounderReview: review,
      },
      201,
    );
  });

  r.post("/admin/pilot/invites/:inviteId/revoke", staff, async (c) => {
    const id = c.req.param("inviteId");
    if (!isUuid(id)) throw notFound("Приглашение");
    const res = await revokePilotInvite(d.db, { id }, now());
    if (!res) throw notFound("Активное приглашение");
    await staffAudit(d.db, c.get("user").id, "pilot_invite_revoke", `pilot_invite:${id}`);
    return c.json({ id, status: "revoked" });
  });

  r.get("/admin/pilot/orgs", staff, async (c) => {
    const { month, items } = await pilotOrgs(d.db, d.billing, { now: now(), pilotOnly: true });
    return c.json({ month, capRub: d.config.llmMonthlyCapRub, items });
  });

  r.post("/admin/pilot/orgs/:orgId/grants", staff, async (c) => {
    const orgId = c.req.param("orgId");
    if (!isUuid(orgId)) throw notFound("Организация");
    const b = await jsonBody(
      c,
      z.object({
        credits: z.number().positive().max(PILOT_GRANT_MAX),
        reference: z.string().trim().min(3).max(200),
      }),
    );
    const actor = c.get("user").id;
    const res = await pilot(
      grantPilotCredits(d.db, d.billing, {
        orgId,
        credits: b.credits,
        reference: b.reference,
        createdBy: actor,
      }),
    );
    await staffAudit(
      d.db,
      actor,
      "pilot_grant",
      `org:${orgId}`,
      `${b.credits} кр., reference ${res.reference}${res.granted ? "" : " (уже начислено ранее)"}`,
    );
    return c.json({
      orgId,
      granted: res.granted,
      reference: res.reference,
      creditsAvailable: res.availableCredits,
    });
  });

  r.put("/admin/pilot/orgs/:orgId/founder-review", staff, async (c) => {
    const orgId = c.req.param("orgId");
    if (!isUuid(orgId)) throw notFound("Организация");
    const b = await jsonBody(c, z.object({ on: z.boolean() }));
    const res = await pilot(setFounderReviewRequired(d.db, orgId, b.on));
    await staffAudit(d.db, c.get("user").id, "pilot_review_required", `org:${orgId}`, b.on ? "вкл" : "выкл");
    return c.json({ orgId, requireFounderReview: res.requireFounderReview });
  });

  r.get("/admin/pilot/spend", staff, async (c) =>
    c.json(await platformLlmSpend(d.db, d.config.llmMonthlyCapRub, now())),
  );

  return r;
}
