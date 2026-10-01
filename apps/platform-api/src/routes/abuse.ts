// api.yaml#createAbuseReport (security: []): «Пожаловаться» without login; 10 reports an hour per IP (IPv6 by /64);
// the answer never reveals the system's status. The reporter's e-mail needs a separate consent (152-ФЗ). A phishing
// report may trigger the automatic takedown (abuse.yaml#takedown.auto_suspend). api.yaml#disputeG2Block — «Оспорить».
import { Hono } from "hono";
import { z } from "zod";
import { checkAutoSuspend, DISPUTE_SENT_RU, disputeG2Block } from "../abuse/escalation.js";
import { type AbuseDeps, createAbuseReport, REPORT_CATEGORIES } from "../abuse/reports.js";
import { deriveKey, hmacHex } from "../auth/crypto.js";
import { ipLimitKey } from "../billing/payments.js";
import { invalid, notFound } from "../errors.js";
import { type AppEnv, checkOrgAccess, clientIp, isUuid } from "../http/auth.js";
import { jsonBody } from "../http/util.js";

const body = z.object({
  url: z.string().trim().min(8).max(2000),
  category: z.enum(REPORT_CATEGORIES),
  text: z.string().max(4000).optional(),
  contactEmail: z
    .string()
    .trim()
    .max(254)
    .transform((s) => s.toLowerCase())
    .pipe(z.email())
    .optional(),
  /** Separate consent to process the reporter's e-mail (only to answer this report). */
  contactConsent: z.boolean().optional(),
});

export function abuseRoutes(d: AbuseDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const ipKey = deriveKey(d.config.secretsKey, "ip-hash");

  r.post("/abuse-reports", async (c) => {
    const b = await jsonBody(c, body);
    if (b.contactEmail && b.contactConsent !== true)
      throw invalid("Отметьте согласие на обработку адреса почты или оставьте поле пустым");
    const ipHash = hmacHex(ipKey, ipLimitKey(clientIp(c, d.config.trustedProxies)));
    const rep = await createAbuseReport(d, {
      url: b.url,
      category: b.category,
      text: b.text,
      contactEmail: b.contactEmail,
      ipHash,
    });
    // abuse.yaml#takedown.auto_suspend: a phishing cluster on a live system is re-checked by the current G2.
    if (b.category === "phishing" && rep.systemId)
      await checkAutoSuspend(d, { systemId: rep.systemId, reportId: rep.id }).catch((e) =>
        d.log?.("abuse auto-suspend check failed", e),
      );
    c.header("cache-control", "no-store");
    return c.json({ reportId: rep.id }, 202);
  });

  // «Оспорить» (abuse.yaml#rescan, #messages_ru.dispute): the owner asks staff to check a G2 antifraud stop.
  r.post("/systems/:id/disputes", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) throw notFound("Система");
    const s = await d.db
      .selectFrom("platform.systems")
      .select(["id", "org_id"])
      .where("id", "=", id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!s) throw notFound("Система");
    checkOrgAccess(c.get("user"), s.org_id, "owner", "Система", "NOT_OWNER");
    const b = await jsonBody(
      c,
      z.object({ revision: z.number().int().min(1), text: z.string().trim().max(2000).optional() }),
    );
    const out = await disputeG2Block(d, { systemId: s.id, revision: b.revision, text: b.text });
    return c.json({ reportId: out.reportId, message_ru: DISPUTE_SENT_RU }, 202);
  });

  return r;
}
