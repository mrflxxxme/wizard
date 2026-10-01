// Payments of the PLATFORM shop: card binding (identification before prod), subscriptions with renewals and dunning,
// topups — specs/platform/billing.yaml#card_binding, #recurring; api.yaml /orgs/{orgId}/billing/*, /webhooks/yookassa.
// Decisions: docs/reviews/impl-notes/M2-07.md. Every state change is idempotent: a payment row moves out of
// pending/waiting_for_capture once under FOR UPDATE, ledger grants use keys topup:<paymentId> and
// grant:plan_monthly:<org>:<periodStart>.
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { sql, type Transaction } from "kysely";
import { deriveKey, hmacHex, sharedKeyMaterial } from "../auth/crypto.js";
import type { Mailer } from "../auth/mailer.js";
import type { Config } from "../config.js";
import { type Db, json } from "../db/index.js";
import type { DB, PaymentsTable } from "../db/types.js";
import { ApiError, notFound } from "../errors.js";
import type { Billing } from "./ledger.js";
import { DAY_MS, PLANS, type PlanId, TOPUP } from "./plans.js";
import { kopOf, PlatformShop, rubles, ShopError, type ShopPayment } from "./shop.js";

type Trx = Transaction<DB>;
type Q = Db | Trx;
type PaidPlan = Exclude<PlanId, "free">;
type PaymentRow = {
  id: string;
  org_id: string;
  kind: PaymentsTable["kind"];
  amount_kop: string;
  status: PaymentsTable["status"];
  provider_payment_id: string | null;
  idempotence_key: string;
  packs: number | null;
  meta: Record<string, unknown>;
};

/** billing.yaml#card_binding.flow: 1 ₽, two-stage, cancelled after the check. */
export const CARD_BINDING_KOP = 100;
/** L3-28 (billing.yaml#card_binding.anti_carding). */
export const BINDINGS_PER_ORG_DAY = 3;
export const BINDINGS_PER_IP_DAY = 10;
export const ORGS_PER_CARD = 3;
/** billing.yaml#recurring.retries: attempts at day 0, +1, +3 after the period end; then past_due for 7 days. */
export const RETRY_DAYS: readonly number[] = [0, 1, 3];
export const PAST_DUE_DAYS = 7;
/** Renewal notice 24 h before current_period_end (sent by the hourly sweep that falls into [end−24h, end−23h)). */
export const REMIND_BEFORE_MS = 24 * 3600_000;
/** A pending payment whose notification did not arrive is re-read from the API after this delay. */
export const RECONCILE_AFTER_MS = 10 * 60_000;

const PLAN_RU: Record<PaidPlan, string> = { start: "Старт", business: "Бизнес" };
const priceKop = (plan: PaidPlan) => PLANS[plan].priceRubMonth * 100;

export const CARD_REJECT_RU = {
  CARD_NOT_RU: "Нужна карта российского банка",
  CARD_BINDING_REJECTED: "Не удалось привязать карту. Попробуйте другую карту",
} as const;
type CardCode = keyof typeof CARD_REJECT_RU;

/** One calendar month later (the day is clamped to the month's length). */
export function addMonth(d: Date): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const out = new Date(d);
  out.setUTCDate(1);
  out.setUTCFullYear(y, m, Math.min(d.getUTCDate(), last));
  return out;
}

/** Key of the per-IP limit: IPv4 as is, IPv6 by its /64 (deploy.yaml#cloud.client_ip). */
export function ipLimitKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return `${full
    .slice(0, 4)
    .map((x) => x.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** db.yaml#payment_methods: an active (not revoked) card of the org. */
export async function activeCard(q: Q, orgId: string) {
  return q
    .selectFrom("platform.payment_methods")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("revoked_at", "is", null)
    .orderBy("bound_at", "desc")
    .executeTakeFirst();
}

export interface BillingView {
  plan: PlanId;
  status: "none" | "active" | "past_due" | "cancelled";
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /** Plan of the next period when a downgrade waits for the period end. */
  nextPlan: PaidPlan | null;
  card: { last4: string; issuerCountry: string; boundAt: string; cardType: string | null } | null;
  /** Outcome of the latest card binding (the return page of YooKassa polls it). */
  cardBinding: {
    status: "pending" | "bound" | "rejected" | "cancelled";
    code: CardCode | null;
    message_ru: string | null;
  } | null;
  limits: { prodSystems: number; members: number; monthlyCredits: number };
  confirmationUrl?: string | null;
}

export interface PaymentsOptions {
  db: Db;
  config: Config;
  ledger: Billing;
  mailer?: Mailer;
  /** Defaults to a client of config.platformShop; null when the shop keys are not set. */
  shop?: PlatformShop | null;
  log?: (msg: string, err?: unknown) => void;
}

export class Payments {
  readonly #d: PaymentsOptions;
  readonly #shop: PlatformShop | null;
  readonly #ipKey: Buffer;
  readonly #cardKey: Buffer;

  constructor(d: PaymentsOptions) {
    this.#d = d;
    const s = d.config.platformShop;
    this.#shop =
      d.shop !== undefined
        ? d.shop
        : s
          ? new PlatformShop({ shopId: s.shopId, secretKey: s.secretKey, apiBase: d.config.yookassaApiBase })
          : null;
    this.#ipKey = deriveKey(d.config.secretsKey, "ip-hash");
    // Shared with apps/worker (reconciliation of pending bindings) — the same key in both processes.
    this.#cardKey = deriveKey(
      sharedKeyMaterial(d.config.secretsKey, dirname(d.config.secretsFile)),
      "card-fingerprint",
    );
  }

  get enabled(): boolean {
    return this.#shop !== null;
  }

  #now(): Date {
    return this.#d.ledger.now();
  }

  #log(msg: string, e?: unknown): void {
    this.#d.log?.(msg, e);
  }

  #requireShop(): PlatformShop {
    if (!this.#shop) throw new ApiError("INTERNAL", "Оплата пока не подключена — попробуйте позже");
    return this.#shop;
  }

  // ------------------------------------------------------------------------------------------------- views

  /** GET /orgs/:orgId/billing. */
  async view(orgId: string, q: Q = this.#d.db): Promise<BillingView> {
    const org = await q.selectFrom("platform.orgs").select("plan").where("id", "=", orgId).executeTakeFirst();
    if (!org) throw notFound("Организация");
    const plan = (org.plan in PLANS ? org.plan : "free") as PlanId;
    const sub = await q
      .selectFrom("platform.subscriptions")
      .selectAll()
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    const card = await activeCard(q, orgId);
    const bind = await q
      .selectFrom("platform.payments")
      .select(["status", "meta"])
      .where("org_id", "=", orgId)
      .where("kind", "=", "card_binding")
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const result = bind?.meta?.result as string | undefined;
    const code = result === "CARD_NOT_RU" || result === "CARD_BINDING_REJECTED" ? result : null;
    const def = PLANS[plan];
    return {
      plan,
      status: sub ? sub.status : "none",
      periodEnd: sub && sub.status !== "cancelled" ? new Date(sub.current_period_end).toISOString() : null,
      cancelAtPeriodEnd: sub?.status === "active" ? sub.cancel_at_period_end : false,
      nextPlan: sub?.status === "active" && sub.plan !== plan && !sub.cancel_at_period_end ? sub.plan : null,
      card: card
        ? {
            last4: card.card_last4,
            issuerCountry: card.issuer_country,
            boundAt: new Date(card.bound_at).toISOString(),
            cardType: card.card_type,
          }
        : null,
      cardBinding: bind
        ? {
            status:
              result === "bound"
                ? "bound"
                : code
                  ? "rejected"
                  : bind.status === "pending" || bind.status === "waiting_for_capture"
                    ? "pending"
                    : "cancelled",
            code,
            message_ru: code ? CARD_REJECT_RU[code] : null,
          }
        : null,
      limits: {
        prodSystems: def.limits.prod_systems,
        members: def.limits.members,
        monthlyCredits: def.monthlyMilli / 1000,
      },
    };
  }

  // ------------------------------------------------------------------------------------------ operations

  /** POST /orgs/:orgId/billing/card-binding: 1 ₽ two-stage payment with save_payment_method and 3-DS redirect. */
  async startCardBinding(
    user: { id: string; email: string },
    orgId: string,
    clientIp: string,
  ): Promise<{ confirmationUrl: string }> {
    const shop = this.#requireShop();
    const ipHash = hmacHex(this.#ipKey, ipLimitKey(clientIp));
    const row = await this.#d.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`card-binding:${orgId}`}))`.execute(trx);
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`card-binding-ip:${ipHash}`}))`.execute(trx);
      const since = new Date(this.#now().getTime() - DAY_MS);
      const count = async (by: "org" | "ip") => {
        let qb = trx
          .selectFrom("platform.payments")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("kind", "=", "card_binding")
          .where("created_at", ">", since);
        qb = by === "org" ? qb.where("org_id", "=", orgId) : qb.where(sql`meta->>'ipHash'`, "=", ipHash);
        return Number((await qb.executeTakeFirstOrThrow()).n);
      };
      if ((await count("org")) >= BINDINGS_PER_ORG_DAY || (await count("ip")) >= BINDINGS_PER_IP_DAY)
        throw new ApiError("RATE_LIMITED", "Слишком много попыток привязки карты. Попробуйте завтра");
      return this.#insertPayment(trx, {
        orgId,
        kind: "card_binding",
        amountKop: CARD_BINDING_KOP,
        key: `bind:${orgId}:${randomUUID()}`,
        meta: { ipHash, userId: user.id },
      });
    });
    const p = await this.#createFor(shop, row, {
      capture: false,
      save_payment_method: true,
      confirmation: { type: "redirect", return_url: this.#returnUrl(row.id) },
      description: "Привязка карты к Wizard (1 ₽ вернётся сразу)",
      receipt: this.#receipt(user.email, "Проверка карты (платёж отменяется)", CARD_BINDING_KOP, "service"),
    });
    const url = p.confirmation?.confirmation_url;
    if (!url) throw new ApiError("INTERNAL", "ЮKassa не вернула ссылку на подтверждение");
    return { confirmationUrl: url };
  }

  /** PUT /orgs/:orgId/billing/subscription. */
  async changeSubscription(
    user: { id: string; email: string },
    orgId: string,
    plan: PaidPlan,
  ): Promise<BillingView> {
    const shop = this.#requireShop();
    const decided = await this.#d.db.transaction().execute(async (trx) => {
      await this.#d.ledger.lock(trx, orgId);
      const org = await trx
        .selectFrom("platform.orgs")
        .select("plan")
        .where("id", "=", orgId)
        .executeTakeFirstOrThrow();
      const sub = await this.#sub(trx, orgId);
      if (sub?.status === "active") {
        const current = org.plan as PlanId;
        // Same plan: resume autopay (and drop a pending downgrade); cheaper plan: from the next period.
        if (plan === current || (current !== "free" && priceKop(plan) < priceKop(current as PaidPlan))) {
          await trx
            .updateTable("platform.subscriptions")
            .set({
              plan,
              cancel_at_period_end: false,
              next_charge_at: sub.next_charge_at ?? sub.current_period_end,
            })
            .where("org_id", "=", orgId)
            .execute();
          return null;
        }
      }
      const card = await activeCard(trx, orgId);
      const row = await this.#insertPayment(trx, {
        orgId,
        kind: "subscription",
        amountKop: priceKop(plan),
        key: `sub:${orgId}:${randomUUID()}`,
        meta: { plan, mode: sub?.status === "active" ? "upgrade" : "start", userId: user.id },
      });
      return { row, card };
    });
    if (!decided) return this.view(orgId);
    const { row, card } = decided;
    const description = `Подписка Wizard «${PLAN_RU[plan]}», 1 месяц`;
    const receipt = this.#receipt(user.email, description, priceKop(plan), "subscription");
    // first_payment: by the bound card, or a payment that saves the card (billing.yaml#recurring.first_payment).
    const p = await this.#createFor(
      shop,
      row,
      card
        ? { capture: true, payment_method_id: card.provider_method_id, description, receipt }
        : {
            capture: true,
            save_payment_method: true,
            confirmation: { type: "redirect", return_url: this.#returnUrl(row.id) },
            description,
            receipt,
          },
    );
    await this.apply(row.id, p);
    return { ...(await this.view(orgId)), confirmationUrl: p.confirmation?.confirmation_url ?? null };
  }

  /** DELETE /orgs/:orgId/billing/subscription: autopay off now, the plan lasts until the period end. */
  async cancelSubscription(orgId: string): Promise<BillingView> {
    await this.#d.db.transaction().execute(async (trx) => {
      await this.#d.ledger.lock(trx, orgId);
      const sub = await this.#sub(trx, orgId);
      if (sub?.status === "active")
        await trx
          .updateTable("platform.subscriptions")
          .set({ cancel_at_period_end: true, next_charge_at: null })
          .where("org_id", "=", orgId)
          .execute();
      // A past_due subscription has no paid period left: it ends now.
      else if (sub?.status === "past_due") await this.#endSubscription(trx, orgId);
    });
    return this.view(orgId);
  }

  /** POST /orgs/:orgId/billing/topups: packs × 60 credits for packs × 990 ₽. */
  async createTopup(
    user: { id: string; email: string },
    orgId: string,
    packs: number,
  ): Promise<{ confirmationUrl: string | null; paymentId: string }> {
    const shop = this.#requireShop();
    const amountKop = packs * TOPUP.priceRub * 100;
    const { row, card } = await this.#d.db.transaction().execute(async (trx) => ({
      row: await this.#insertPayment(trx, {
        orgId,
        kind: "topup",
        amountKop,
        packs,
        key: `topup:${orgId}:${randomUUID()}`,
        meta: { userId: user.id },
      }),
      card: await activeCard(trx, orgId),
    }));
    const description = `Пакет кредитов Wizard: ${packs} × ${TOPUP.milli / 1000}`;
    const receipt = this.#receipt(user.email, description, amountKop, "topup");
    const p = await this.#createFor(
      shop,
      row,
      card
        ? { capture: true, payment_method_id: card.provider_method_id, description, receipt }
        : {
            capture: true,
            confirmation: { type: "redirect", return_url: this.#returnUrl(row.id) },
            description,
            receipt,
          },
    );
    await this.apply(row.id, p);
    return { confirmationUrl: p.confirmation?.confirmation_url ?? null, paymentId: row.id };
  }

  // -------------------------------------------------------------------------------------- notifications

  /**
   * Webhook body (after the IP check of the route). The notification is only a hint: the payment is re-read with
   * GET /v3/payments/{id} and matched to our row by provider_payment_id or metadata.paymentId. Unknown → ignored.
   * Throws ShopError (retryable) when the API is unavailable — the route answers 500 and YooKassa redelivers.
   */
  async handleNotification(body: unknown): Promise<"applied" | "ignored"> {
    const shop = this.#requireShop();
    const b = body as { type?: unknown; event?: unknown; object?: { id?: unknown } } | null;
    const id = b?.object?.id;
    if (b?.type !== "notification" || typeof b.event !== "string" || !b.event.startsWith("payment."))
      return "ignored";
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return "ignored";
    let p: ShopPayment;
    try {
      p = await shop.getPayment(id);
    } catch (e) {
      if (e instanceof ShopError && e.status === 404) return "ignored";
      throw e;
    }
    const byProvider = await this.#d.db
      .selectFrom("platform.payments")
      .select("id")
      .where("provider_payment_id", "=", p.id)
      .executeTakeFirst();
    const ref = p.metadata?.paymentId;
    const rowId =
      byProvider?.id ??
      (typeof ref === "string" && /^[0-9a-f-]{36}$/i.test(ref)
        ? (
            await this.#d.db
              .selectFrom("platform.payments")
              .select("id")
              .where("id", "=", ref)
              .where("provider_payment_id", "is", null)
              .executeTakeFirst()
          )?.id
        : undefined);
    if (!rowId) return "ignored";
    return (await this.apply(rowId, p)) ? "applied" : "ignored";
  }

  /**
   * Applies the provider's view of a payment to our row (state machine of billing.yaml#card_binding /
   * #recurring). Idempotent: a row leaves pending/waiting_for_capture once. False — nothing to do or mismatch.
   */
  async apply(rowId: string, p: ShopPayment): Promise<boolean> {
    const step = await this.#d.db.transaction().execute(async (trx) => {
      const row = (await trx
        .selectFrom("platform.payments")
        .selectAll()
        .where("id", "=", rowId)
        .forUpdate()
        .executeTakeFirst()) as PaymentRow | undefined;
      if (!row) return null;
      if (
        p.metadata?.paymentId !== row.id ||
        p.amount?.currency !== "RUB" ||
        kopOf(p.amount) !== Number(row.amount_kop) ||
        (row.provider_payment_id !== null && row.provider_payment_id !== p.id)
      ) {
        this.#log("billing: payment does not match its row");
        return null;
      }
      if (row.provider_payment_id === null)
        await trx
          .updateTable("platform.payments")
          .set({ provider_payment_id: p.id })
          .where("id", "=", row.id)
          .execute();
      if (row.status === "succeeded" || row.status === "canceled" || row.status === "refunded") return null;
      if (row.kind === "card_binding") return this.#applyBinding(trx, row, p);
      if (p.status === "succeeded") {
        await this.#settle(trx, row, "succeeded");
        if (row.kind === "topup") await this.#grantTopup(trx, row);
        else await this.#activate(trx, row, p);
        return "done" as const;
      }
      if (p.status === "canceled") {
        await this.#settle(trx, row, "canceled");
        const meta = row.meta as { mode?: string; periodStart?: string };
        if (row.kind === "subscription" && meta.mode === "renewal" && meta.periodStart)
          await this.#failAttempt(trx, row.org_id, meta.periodStart);
        return "done" as const;
      }
      return null;
    });
    if (step === "cancel") {
      // billing.yaml#card_binding: the 1 ₽ is never captured.
      const shop = this.#requireShop();
      const c = await shop.cancelPayment(p.id, `cancel:${rowId}`);
      if (c.status !== "canceled") throw new ShopError("binding payment not cancelled", true);
      await this.#d.db.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom("platform.payments")
          .select("status")
          .where("id", "=", rowId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (row.status === "waiting_for_capture")
          await this.#settle(trx, { id: rowId } as PaymentRow, "canceled");
      });
    }
    return step !== null;
  }

  async #applyBinding(trx: Trx, row: PaymentRow, p: ShopPayment): Promise<"cancel" | "done" | null> {
    if (p.status === "waiting_for_capture") {
      if (row.status === "pending") {
        const verdict = await this.#cardVerdict(trx, row.org_id, p);
        if (verdict.ok) await this.#saveCard(trx, row.org_id, p, row.meta.userId as string, verdict.fp);
        await trx
          .updateTable("platform.payments")
          .set({
            status: "waiting_for_capture",
            meta: sql`meta || ${json({ result: verdict.ok ? "bound" : verdict.code })}`,
          })
          .where("id", "=", row.id)
          .execute();
      }
      return "cancel";
    }
    if (p.status === "canceled") {
      await this.#settle(trx, row, "canceled");
      return "done";
    }
    if (p.status === "succeeded") {
      // capture=false never captures by itself; a captured binding is recorded for staff (refund by hand).
      this.#log("billing: card binding payment was captured");
      await this.#settle(trx, row, "succeeded");
      return "done";
    }
    return null;
  }

  /** L3-28: saved card, RU issuer, 3-D Secure applied, the same card in ≤ 3 orgs. */
  async #cardVerdict(
    trx: Trx,
    orgId: string,
    p: ShopPayment,
  ): Promise<{ ok: true; fp: string } | { ok: false; code: CardCode }> {
    const pm = p.payment_method;
    const card = pm?.card;
    if (pm?.saved !== true || !card?.last4) return { ok: false, code: "CARD_BINDING_REJECTED" };
    if (card.issuer_country !== "RU") return { ok: false, code: "CARD_NOT_RU" };
    if (p.authorization_details?.three_d_secure?.applied !== true)
      return { ok: false, code: "CARD_BINDING_REJECTED" };
    const fp = hmacHex(
      this.#cardKey,
      `${card.first6 ?? ""}|${card.last4}|${card.expiry_month ?? ""}/${card.expiry_year ?? ""}`,
    );
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`card:${fp}`}))`.execute(trx);
    const others = await trx
      .selectFrom("platform.payment_methods")
      .select(sql<string>`count(distinct org_id)`.as("n"))
      .where("card_fingerprint", "=", fp)
      .where("org_id", "!=", orgId)
      .executeTakeFirstOrThrow();
    if (Number(others.n) >= ORGS_PER_CARD) return { ok: false, code: "CARD_BINDING_REJECTED" };
    return { ok: true, fp };
  }

  /** Inserts the bound card (idempotent by provider_method_id) and revokes the org's previous ones. */
  async #saveCard(trx: Trx, orgId: string, p: ShopPayment, userId: string, fp: string): Promise<string> {
    const pm = p.payment_method as NonNullable<ShopPayment["payment_method"]>;
    const card = pm.card as NonNullable<NonNullable<ShopPayment["payment_method"]>["card"]>;
    const existing = await trx
      .selectFrom("platform.payment_methods")
      .select(["id", "org_id"])
      .where("provider", "=", "yookassa")
      .where("provider_method_id", "=", pm.id)
      .executeTakeFirst();
    if (existing) return existing.id;
    const now = this.#now();
    await trx
      .updateTable("platform.payment_methods")
      .set({ revoked_at: now })
      .where("org_id", "=", orgId)
      .where("revoked_at", "is", null)
      .execute();
    const ins = await trx
      .insertInto("platform.payment_methods")
      .values({
        org_id: orgId,
        provider_method_id: pm.id,
        card_last4: card.last4.slice(-4),
        card_type: card.card_type ?? null,
        issuer_country: card.issuer_country as string,
        card_fingerprint: fp,
        bound_by: userId,
        bound_at: now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("platform.subscriptions")
      .set({ payment_method_id: ins.id })
      .where("org_id", "=", orgId)
      .execute();
    return ins.id;
  }

  /** Subscription payment succeeded: a new period, orgs.plan, monthly credits of the plan (ledger grant). */
  async #activate(trx: Trx, row: PaymentRow, p: ShopPayment): Promise<void> {
    const meta = row.meta as { plan?: PaidPlan; mode?: string; periodStart?: string; userId?: string };
    const plan: PaidPlan = meta.plan === "business" ? "business" : "start";
    await this.#d.ledger.lock(trx, row.org_id);
    const sub = await this.#sub(trx, row.org_id);
    const start = meta.mode === "renewal" && meta.periodStart ? new Date(meta.periodStart) : this.#now();
    const end = addMonth(start);
    let methodId = sub?.payment_method_id ?? null;
    const pm = p.payment_method;
    if (pm?.id) {
      const known = await trx
        .selectFrom("platform.payment_methods")
        .select("id")
        .where("provider_method_id", "=", pm.id)
        .where("org_id", "=", row.org_id)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (known) methodId = known.id;
      else if (pm.saved && meta.userId) {
        // The first payment saved a card: it binds like a card binding if it passes the same checks.
        const verdict = await this.#cardVerdict(trx, row.org_id, p);
        if (verdict.ok) methodId = await this.#saveCard(trx, row.org_id, p, meta.userId, verdict.fp);
      }
    }
    methodId ??= (await activeCard(trx, row.org_id))?.id ?? null;
    const values = {
      plan,
      status: "active" as const,
      payment_method_id: methodId,
      current_period_start: start,
      current_period_end: end,
      cancel_at_period_end: false,
      next_charge_at: end,
      failed_attempts: 0,
    };
    await trx
      .insertInto("platform.subscriptions")
      .values({ org_id: row.org_id, ...values })
      .onConflict((oc) => oc.column("org_id").doUpdateSet(values))
      .execute();
    await trx.updateTable("platform.orgs").set({ plan }).where("id", "=", row.org_id).execute();
    await this.#d.ledger.grant(trx, row.org_id, {
      bucket: "plan_monthly",
      amountMilli: PLANS[plan].monthlyMilli,
      expiresAt: end,
      key: `grant:plan_monthly:${row.org_id}:${start.toISOString()}`,
      note: `Кредиты тарифа «${PLAN_RU[plan]}» за период`,
      createdBy: meta.userId ?? null,
      paymentId: row.id,
    });
  }

  async #grantTopup(trx: Trx, row: PaymentRow): Promise<void> {
    await this.#d.ledger.grantTopup(trx, row.org_id, {
      packs: row.packs ?? 1,
      key: `topup:${row.id}`,
      paymentId: row.id,
      createdBy: (row.meta.userId as string | undefined) ?? null,
    });
  }

  /** A renewal attempt failed: next attempt at +1/+3 days after the period end, after the third — past_due. */
  async #failAttempt(trx: Trx, orgId: string, periodStart: string): Promise<void> {
    const sub = await this.#sub(trx, orgId, true);
    if (!sub || new Date(sub.current_period_end).toISOString() !== periodStart) return;
    const n = sub.failed_attempts + 1;
    const end = new Date(sub.current_period_end).getTime();
    const retry = RETRY_DAYS[n];
    await trx
      .updateTable("platform.subscriptions")
      .set(
        retry !== undefined
          ? { failed_attempts: n, next_charge_at: new Date(end + retry * DAY_MS) }
          : { failed_attempts: n, status: "past_due", next_charge_at: null },
      )
      .where("org_id", "=", orgId)
      .execute();
  }

  /** Subscription over: status cancelled, the org is back on Free (billing.yaml#plans.enforcement for overflow). */
  async #endSubscription(trx: Trx, orgId: string): Promise<void> {
    await trx
      .updateTable("platform.subscriptions")
      .set({ status: "cancelled", next_charge_at: null, cancel_at_period_end: false })
      .where("org_id", "=", orgId)
      .execute();
    await trx.updateTable("platform.orgs").set({ plan: "free" }).where("id", "=", orgId).execute();
  }

  // ----------------------------------------------------------------------------------------------- sweep

  /**
   * Hourly (DBOS scheduled workflow of apps/worker — one step per phase and per renewal, or the in-process timer):
   * renewal notices, end of cancelled/past_due subscriptions, renewals by the saved card with retries, re-reading
   * pending payments whose notification was lost.
   */
  async sweep(): Promise<{ reminded: number; ended: number; charged: number; reconciled: number }> {
    const out = { reminded: 0, ended: 0, charged: 0, reconciled: 0 };
    if (!this.#shop) return out;
    out.reminded = await this.remind();
    out.ended = await this.endDue();
    for (const orgId of await this.dueRenewals()) {
      try {
        if (await this.renew(orgId)) out.charged++;
      } catch (e) {
        this.#log("billing: renewal failed", e);
      }
    }
    out.reconciled = await this.reconcile();
    return out;
  }

  /** Notice 24 h before the autopayment (billing.yaml#recurring.renewal); the hourly sweep in [end−24h, end−23h). */
  async remind(): Promise<number> {
    const now = this.#now();
    const soon = await this.#d.db
      .selectFrom("platform.subscriptions")
      .select(["org_id", "plan", "current_period_end", "payment_method_id"])
      .where("status", "=", "active")
      .where("cancel_at_period_end", "=", false)
      .where("current_period_end", ">", new Date(now.getTime() + REMIND_BEFORE_MS - 3600_000))
      .where("current_period_end", "<=", new Date(now.getTime() + REMIND_BEFORE_MS))
      .execute();
    let n = 0;
    for (const s of soon) {
      const email = await this.#ownerEmail(this.#d.db, s.org_id);
      if (!email || !this.#d.mailer) continue;
      const when = new Date(s.current_period_end).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
      await this.#d.mailer.send({
        kind: "billing",
        to: email,
        subject: "Wizard: завтра продление подписки",
        text: `${when} (МСК) с привязанной карты будет списано ${PLANS[s.plan].priceRubMonth} ₽ за тариф «${PLAN_RU[s.plan]}» на следующий месяц. Отменить автоплатёж можно в разделе «Тариф и баланс».`,
      });
      n++;
    }
    return n;
  }

  /** Cancelled subscriptions at the period end, and past_due for 7 days after the last attempt → Free. */
  async endDue(): Promise<number> {
    const now = this.#now();
    const ending = await this.#d.db
      .selectFrom("platform.subscriptions")
      .select("org_id")
      .where((eb) =>
        eb.or([
          eb.and([
            eb("status", "=", "active"),
            eb("cancel_at_period_end", "=", true),
            eb("current_period_end", "<=", now),
          ]),
          eb.and([
            eb("status", "=", "past_due"),
            eb(
              "current_period_end",
              "<=",
              new Date(now.getTime() - ((RETRY_DAYS.at(-1) ?? 0) + PAST_DUE_DAYS) * DAY_MS),
            ),
          ]),
        ]),
      )
      .execute();
    let n = 0;
    for (const s of ending) {
      await this.#d.db.transaction().execute(async (trx) => {
        await this.#d.ledger.lock(trx, s.org_id);
        const sub = await this.#sub(trx, s.org_id, true);
        if (sub && sub.status !== "cancelled") {
          await this.#endSubscription(trx, s.org_id);
          n++;
        }
      });
    }
    return n;
  }

  /** Orgs whose next renewal attempt is due. */
  async dueRenewals(): Promise<string[]> {
    const rows = await this.#d.db
      .selectFrom("platform.subscriptions")
      .select("org_id")
      .where("status", "=", "active")
      .where("cancel_at_period_end", "=", false)
      .where("next_charge_at", "<=", this.#now())
      .orderBy("next_charge_at")
      .execute();
    return rows.map((r) => r.org_id);
  }

  /** Pending payments older than 10 minutes are re-read from the API (a lost notification). */
  async reconcile(): Promise<number> {
    if (!this.#shop) return 0;
    const now = this.#now();
    const stale = await this.#d.db
      .selectFrom("platform.payments")
      .select(["id", "provider_payment_id"])
      .where("status", "in", ["pending", "waiting_for_capture"])
      .where("provider_payment_id", "is not", null)
      .where("created_at", "<", new Date(now.getTime() - RECONCILE_AFTER_MS))
      .where("created_at", ">", new Date(now.getTime() - 3 * DAY_MS))
      .limit(100)
      .execute();
    let n = 0;
    for (const r of stale) {
      try {
        const p = await this.#shop.getPayment(r.provider_payment_id as string);
        if (await this.apply(r.id, p)) n++;
      } catch (e) {
        this.#log("billing: reconcile failed", e);
      }
    }
    return n;
  }

  /**
   * One renewal attempt of an org (billing.yaml#recurring.renewal): a payment by payment_method_id with
   * Idempotence-Key renew:<org>:<period> (attempts 2 and 3 — renew:<org>:<period>:<n>). True — a payment was made.
   */
  async renew(orgId: string): Promise<boolean> {
    const shop = this.#requireShop();
    const now = this.#now();
    const prep = await this.#d.db.transaction().execute(async (trx) => {
      await this.#d.ledger.lock(trx, orgId);
      const sub = await this.#sub(trx, orgId, true);
      if (
        sub?.status !== "active" ||
        sub.cancel_at_period_end ||
        !sub.next_charge_at ||
        new Date(sub.next_charge_at).getTime() > now.getTime()
      )
        return null;
      const periodStart = new Date(sub.current_period_end).toISOString();
      const attempt = sub.failed_attempts + 1;
      const key =
        attempt === 1 ? `renew:${orgId}:${periodStart}` : `renew:${orgId}:${periodStart}:${attempt}`;
      const existing = (await trx
        .selectFrom("platform.payments")
        .selectAll()
        .where("idempotence_key", "=", key)
        .executeTakeFirst()) as PaymentRow | undefined;
      let card = sub.payment_method_id
        ? await trx
            .selectFrom("platform.payment_methods")
            .selectAll()
            .where("id", "=", sub.payment_method_id)
            .where("revoked_at", "is", null)
            .executeTakeFirst()
        : undefined;
      card ??= await activeCard(trx, orgId);
      if (existing) {
        // Created before (a crash or an unknown API result): repeat with the same key, or wait for the notice.
        return existing.provider_payment_id === null && card ? { row: existing, card, plan: sub.plan } : null;
      }
      if (!card) {
        await this.#failAttempt(trx, orgId, periodStart);
        return null;
      }
      const row = await this.#insertPayment(trx, {
        orgId,
        kind: "subscription",
        amountKop: priceKop(sub.plan),
        key,
        meta: { plan: sub.plan, mode: "renewal", periodStart, attempt },
      });
      return { row, card, plan: sub.plan };
    });
    if (!prep) return false;
    const email = (await this.#ownerEmail(this.#d.db, orgId, prep.card.bound_by)) ?? "";
    const description = `Подписка Wizard «${PLAN_RU[prep.plan]}», 1 месяц`;
    let p: ShopPayment;
    try {
      p = await this.#create(shop, prep.row, {
        capture: true,
        payment_method_id: prep.card.provider_method_id,
        description,
        receipt: this.#receipt(email, description, Number(prep.row.amount_kop), "subscription"),
      });
    } catch (e) {
      // Refused by the API (e.g. the method is no longer saved): the attempt failed; unknown result — kept pending.
      if (e instanceof ShopError && !e.retryable) {
        await this.#d.db.transaction().execute(async (trx) => {
          await this.#settle(trx, prep.row, "canceled");
          await this.#failAttempt(trx, orgId, String(prep.row.meta.periodStart));
        });
        return true;
      }
      throw e;
    }
    await this.apply(prep.row.id, p);
    return true;
  }

  // ------------------------------------------------------------------------------------------- internals

  async #sub(trx: Trx, orgId: string, forUpdate = true) {
    const q = trx.selectFrom("platform.subscriptions").selectAll().where("org_id", "=", orgId);
    return (forUpdate ? q.forUpdate() : q).executeTakeFirst();
  }

  async #insertPayment(
    trx: Trx,
    i: {
      orgId: string;
      kind: PaymentsTable["kind"];
      amountKop: number;
      key: string;
      packs?: number;
      meta: Record<string, unknown>;
    },
  ): Promise<PaymentRow> {
    return (await trx
      .insertInto("platform.payments")
      .values({
        org_id: i.orgId,
        kind: i.kind,
        amount_kop: i.amountKop,
        status: "pending",
        idempotence_key: i.key,
        packs: i.packs ?? null,
        meta: json(i.meta),
        // The ledger clock (tests move it): per-day limits and reconciliation compare against it.
        created_at: this.#now(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()) as PaymentRow;
  }

  async #settle(trx: Trx, row: Pick<PaymentRow, "id">, status: "succeeded" | "canceled"): Promise<void> {
    await trx
      .updateTable("platform.payments")
      .set({ status, settled_at: this.#now() })
      .where("id", "=", row.id)
      .execute();
  }

  /** POST /payments with the row's idempotence key; the provider id is stored before anything else happens. */
  async #create(shop: PlatformShop, row: PaymentRow, body: Record<string, unknown>): Promise<ShopPayment> {
    let p: ShopPayment;
    try {
      p = await shop.createPayment(
        {
          amount: rubles(Number(row.amount_kop)),
          ...body,
          metadata: { paymentId: row.id, orgId: row.org_id, kind: row.kind },
        },
        row.idempotence_key,
      );
    } catch (e) {
      this.#log("billing: create payment failed", e);
      // The row stays pending: if the payment exists after all, its notification finds it by metadata.paymentId.
      throw e instanceof ShopError ? e : new ShopError("YooKassa call failed", true);
    }
    await this.#d.db
      .updateTable("platform.payments")
      .set({ provider_payment_id: p.id })
      .where("id", "=", row.id)
      .where("provider_payment_id", "is", null)
      .execute();
    return p;
  }

  /** #create for operations of a user: a provider failure is a Russian 500 (the row stays pending). */
  async #createFor(shop: PlatformShop, row: PaymentRow, body: Record<string, unknown>): Promise<ShopPayment> {
    try {
      return await this.#create(shop, row, body);
    } catch {
      throw new ApiError("INTERNAL", "ЮKassa временно недоступна — попробуйте позже");
    }
  }

  #returnUrl(paymentId: string): string {
    return `${this.#d.config.platformOrigin.replace(/\/+$/, "")}/billing?payment=${paymentId}`;
  }

  /**
   * 54-FZ receipt (billing.yaml#recurring.receipts, #tax_note): customer e-mail = owner; one item «Подписка Wizard»
   * with WIZARD_RECEIPT_VAT_CODE, or — with config.receipt.split — software right + hosting summing to the amount.
   */
  #receipt(
    email: string,
    description: string,
    amountKop: number,
    what: "service" | "subscription" | "topup",
  ) {
    const r = this.#d.config.receipt;
    const vat = r.vatCode ?? 1;
    const item = (d: string, kop: number, vatCode: number, subject: string) => ({
      description: d.slice(0, 128),
      quantity: "1",
      amount: rubles(kop),
      vat_code: vatCode,
      payment_mode: "full_payment",
      payment_subject: subject,
    });
    const items =
      r.split && what !== "service"
        ? (() => {
            const soft = Math.round(amountKop * r.split.softwareShare);
            return [
              item("Право использования ПО Wizard", soft, r.split.softwareVatCode, "intellectual_activity"),
              item("Услуги хостинга систем", amountKop - soft, vat, "service"),
            ].filter((x) => kopOf(x.amount) > 0);
          })()
        : [item(description, amountKop, vat, "service")];
    return { customer: { email }, items };
  }

  /** E-mail of the org owner: the one who bound the card while still an owner, else the earliest owner. */
  async #ownerEmail(q: Q, orgId: string, prefer?: string): Promise<string | undefined> {
    const owners = await q
      .selectFrom("platform.memberships as m")
      .innerJoin("platform.users as u", "u.id", "m.user_id")
      .select(["u.id", "u.email"])
      .where("m.org_id", "=", orgId)
      .where("m.role", "=", "owner")
      .where("u.deleted_at", "is", null)
      .orderBy("m.created_at")
      .execute();
    return (owners.find((o) => o.id === prefer) ?? owners[0])?.email;
  }
}
