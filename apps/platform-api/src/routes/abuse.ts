// api.yaml#createAbuseReport (security: []): «Пожаловаться» without login; 10 reports an hour per IP (IPv6 by /64);
// the answer never reveals the system's status. The reporter's e-mail needs a separate consent (152-ФЗ).
import { Hono } from "hono";
import { z } from "zod";
import { type AbuseDeps, createAbuseReport, REPORT_CATEGORIES } from "../abuse/reports.js";
import { deriveKey, hmacHex } from "../auth/crypto.js";
import { ipLimitKey } from "../billing/payments.js";
import { invalid } from "../errors.js";
import { type AppEnv, clientIp } from "../http/auth.js";
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
    c.header("cache-control", "no-store");
    return c.json({ reportId: rep.id }, 202);
  });

  return r;
}
