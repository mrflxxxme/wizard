// M2 billing operations of specs/platform/api.yaml (x-roles owner): getBilling, startCardBinding,
// changeSubscription, cancelSubscription, createTopup; and the platform shop webhook (yookassaWebhook, no auth).

import { ipInCidrs } from "@wizard/connectors";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { TOPUP_NOT_ON_PLAN_RU, TOPUP_PLANS } from "../billing/plans.js";
import { ShopError } from "../billing/shop.js";
import { ApiError, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, clientIp, isUuid } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";

/** connectors/yookassa.yaml#webhooks: notification bodies are small. */
export const WEBHOOK_BODY_MAX = 256 * 1024;

/** api.yaml#Error PAYMENTS_DISABLED (M2-15). */
export const PAYMENTS_DISABLED_RU = "Оплата на пилоте отключена — кредиты начисляет команда Wizard";

export function billingRoutes(d: Deps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  /** Money operations are owner-only (platform-screens.yaml S-billing rules); another org → 404. */
  function ownerOrg(user: AuthUser, id: string | undefined): string {
    if (!isUuid(id)) throw notFound("Организация");
    checkOrgAccess(user, id, "owner", "Организация", "NOT_OWNER");
    return id;
  }

  /** WIZARD_PAYMENTS=off (D24_pilot_free): every money operation → 403 PAYMENTS_DISABLED; GET billing stays. */
  function paymentsOn(): void {
    if (!d.config.payments) throw new ApiError("PAYMENTS_DISABLED", PAYMENTS_DISABLED_RU);
  }

  r.get("/orgs/:orgId/billing", async (c) => {
    const orgId = ownerOrg(c.get("user"), c.req.param("orgId"));
    return c.json(await d.payments.view(orgId));
  });

  r.post("/orgs/:orgId/billing/card-binding", async (c) => {
    const user = c.get("user");
    const orgId = ownerOrg(user, c.req.param("orgId"));
    paymentsOn();
    const ip = clientIp(c, d.config.trustedProxies);
    return c.json(await d.payments.startCardBinding(user, orgId, ip));
  });

  r.put("/orgs/:orgId/billing/subscription", async (c) => {
    const user = c.get("user");
    const orgId = ownerOrg(user, c.req.param("orgId"));
    paymentsOn();
    const b = await jsonBody(c, z.strictObject({ plan: z.enum(["start", "business"]) }));
    return c.json(await d.payments.changeSubscription(user, orgId, b.plan));
  });

  r.delete("/orgs/:orgId/billing/subscription", async (c) => {
    const orgId = ownerOrg(c.get("user"), c.req.param("orgId"));
    paymentsOn();
    return c.json(await d.payments.cancelSubscription(orgId));
  });

  r.post("/orgs/:orgId/billing/topups", async (c) => {
    const user = c.get("user");
    const orgId = ownerOrg(user, c.req.param("orgId"));
    paymentsOn();
    // billing.yaml#plans.topup.available_on (M2-09): pilot credits come from the founder, even with payments on.
    const org = await d.db
      .selectFrom("platform.orgs")
      .select("plan")
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org || !TOPUP_PLANS.includes(org.plan)) throw new ApiError("FORBIDDEN", TOPUP_NOT_ON_PLAN_RU);
    const b = await jsonBody(c, z.strictObject({ packs: z.number().int().min(1).max(20) }));
    return c.json(await d.payments.createTopup(user, orgId, b.packs));
  });

  return r;
}

/**
 * POST /api/v1/webhooks/yookassa (security: []), mounted before the Origin guard: source IP outside the YooKassa
 * list → 401, oversized body → 413; the state comes from GET /v3/payments/{id}, never from the body (M2-02 rules).
 * Provider unavailable → 500 so that YooKassa delivers again.
 */
export function yookassaWebhook(d: Deps) {
  return async (c: Context) => {
    if (!d.payments.enabled) return c.json({ code: "NOT_FOUND", message_ru: "Не найдено" }, 404);
    const ip = clientIp(c, d.config.trustedProxies);
    if (ip === "unknown" || !ipInCidrs(ip, d.config.yookassaIpAllowlist))
      return c.json({ code: "UNAUTHORIZED", message_ru: "Источник уведомления не подтверждён" }, 401);
    const len = Number(c.req.header("content-length") ?? 0);
    if (len > WEBHOOK_BODY_MAX)
      return c.json({ code: "PAYLOAD_TOO_LARGE", message_ru: "Слишком большое уведомление" }, 413);
    const raw = await c.req.text();
    if (raw.length > WEBHOOK_BODY_MAX)
      return c.json({ code: "PAYLOAD_TOO_LARGE", message_ru: "Слишком большое уведомление" }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ code: "VALIDATION_FAILED", message_ru: "Тело уведомления должно быть JSON" }, 400);
    }
    try {
      await d.payments.handleNotification(body);
    } catch (e) {
      if (e instanceof ShopError) return c.json({ code: "INTERNAL", message_ru: "Повторите позже" }, 500);
      throw e;
    }
    return c.json({ ok: true });
  };
}
