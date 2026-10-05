// Credits ledger: specs/platform/billing.yaml#ledger, #run_charging, #credits_cap; db.yaml#credit_ledger.
// Amounts are milli-credits. Every balance change runs inside a transaction under the org advisory lock; one
// logical operation (idempotency key K) is one row per bucket, keyed K, K#2, K#3… (docs/reviews/impl-notes/M1-03.md).
import { type Kysely, sql, type Transaction } from "kysely";
import type { CreditLedgerTable, DB } from "../db/types.js";
import { ApiError, notFound } from "../errors.js";
import {
  BUCKET_ORDER,
  type Bucket,
  DAY_MS,
  FREE_PERIOD_DAYS,
  type PaidPlan,
  PILOT_GRANT_DAYS,
  PLANS,
  type PlanLimit,
  assertPlanLimit as planLimit,
  TOPUP,
  WELCOME,
} from "./plans.js";

type Trx = Transaction<DB>;
type Kind = CreditLedgerTable["kind"];

export interface BucketBalance {
  bucket: Bucket;
  expiresAt: Date | null;
  /** Milli-credits. */
  remaining: number;
}

/** Milli-credits; api.yaml#CreditBalance divides by 1000. */
export interface BalanceMilli {
  balance: number;
  held: number;
  available: number;
  buckets: BucketBalance[];
}

export interface RunOutcome {
  status: "succeeded" | "failed" | "cancelled";
  code?: string;
}

export interface RunCharge {
  usedMilli: number;
  chargedMilli: number;
  refundedMilli: number;
}

export interface GrantInput {
  kind?: "grant" | "adjustment";
  bucket: Bucket;
  amountMilli: number;
  expiresAt: Date | null;
  key: string;
  note: string;
  createdBy?: string | null;
  paymentId?: string | null;
}

interface Row {
  kind: Kind;
  amountMilli: number;
  bucket: Bucket;
  expiresAt: Date | null;
  runId?: string | null;
  systemId?: string | null;
  paymentId?: string | null;
  note?: string | null;
  createdBy?: string | null;
}

/** billing.yaml#run_charging.build.refunds: platform failures refund the whole charge. */
export const REFUND_CODES: ReadonlySet<string> = new Set([
  "INTERNAL",
  "WORKER_RESTARTED",
  "LLM_UNAVAILABLE",
  "MIGRATION_FAILED",
]);

export const fmtCredits = (milli: number): string =>
  (Math.round(milli / 100) / 10).toLocaleString("ru-RU", { maximumFractionDigits: 1 });

/**
 * billing.yaml#rub_model.internal_guard.org_allowance (D31, D70): credits are the internal guard, the client never
 * sees them — the text asks to write to the team (the founder raises the org's credits in /admin).
 */
export const INSUFFICIENT_CREDITS_RU =
  "Сейчас не получается продолжить сборку: закончился внутренний запас организации. Напишите команде, и мы быстро его пополним.";

export function insufficient(availableMilli: number, requiredMilli: number): ApiError {
  return new ApiError("INSUFFICIENT_CREDITS", INSUFFICIENT_CREDITS_RU, {
    available: Math.max(0, availableMilli) / 1000,
    required: requiredMilli / 1000,
  });
}

const expiryMs = (b: { expiresAt: Date | null }) => b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
/** Nearest expiry first, then plan credits before topup (billing.yaml#ledger.rules). */
const byDebitOrder = (a: BucketBalance, b: BucketBalance) =>
  expiryMs(a) - expiryMs(b) || BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);

function allocate(buckets: BucketBalance[], amount: number): { b: BucketBalance; take: number }[] {
  const out: { b: BucketBalance; take: number }[] = [];
  let left = amount;
  for (const b of buckets) {
    if (left <= 0) break;
    const take = Math.min(b.remaining, left);
    if (take > 0) {
      out.push({ b, take });
      left -= take;
    }
  }
  return out;
}

const sumOf = (xs: { take: number }[]) => xs.reduce((s, x) => s + x.take, 0);

export interface BillingOptions {
  now?: () => Date;
  /**
   * Orgs without plan limits whose missing credits are granted as a ledger adjustment (the M0 local org on a dev
   * stand, config.billingExemptOrgs). The ledger itself is written as usual.
   */
  exemptOrgs?: Iterable<string>;
  /** Platform LLM cap of the month (M2-15): checked before every new LLM run (insertRun). */
  llmCap?: { assert(): Promise<void> };
}

export class Billing {
  readonly now: () => Date;
  readonly #exempt: ReadonlySet<string>;
  readonly #llmCap: BillingOptions["llmCap"];

  constructor(o: BillingOptions = {}) {
    this.now = o.now ?? (() => new Date());
    this.#exempt = new Set(o.exemptOrgs ?? []);
    this.#llmCap = o.llmCap;
  }

  /** M2-15: 503 LLM_BUDGET_EXHAUSTED once the platform LLM spend of the month reaches WIZARD_LLM_MONTHLY_CAP_RUB. */
  async assertLlmBudget(): Promise<void> {
    await this.#llmCap?.assert();
  }

  isExempt(orgId: string): boolean {
    return this.#exempt.has(orgId);
  }

  /** billing.yaml#ledger.rules: balance changes of an org are serialized by pg_advisory_xact_lock. */
  async lock(trx: Trx, orgId: string): Promise<void> {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}::text))`.execute(trx);
  }

  /** Lock + due grants (Free welcome/monthly) + expiry of buckets (lazy credits_cron). Idempotent. */
  async settleOrg(trx: Trx, orgId: string): Promise<void> {
    await this.lock(trx, orgId);
    const now = this.now();
    const org = await trx
      .selectFrom("platform.orgs")
      .select(["plan", "created_at"])
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) throw notFound("Организация");
    if (org.plan === "free") {
      const created = new Date(org.created_at).getTime();
      const period = FREE_PERIOD_DAYS * DAY_MS;
      const k = Math.floor((now.getTime() - created) / period);
      if (k < 1)
        await this.#grantOnce(trx, orgId, `grant:free_welcome:${orgId}`, {
          kind: "grant",
          bucket: "free_welcome",
          amountMilli: WELCOME.milli,
          expiresAt: new Date(created + period),
          note: "Приветственные кредиты тарифа Free",
        });
      else {
        // 25 credits from day 31; each monthly bucket expires when the next one is granted (no accumulation).
        const start = new Date(created + k * period);
        await this.#grantOnce(trx, orgId, `grant:free_monthly:${orgId}:${start.toISOString().slice(0, 10)}`, {
          kind: "grant",
          bucket: "free_monthly",
          amountMilli: PLANS.free.monthlyMilli,
          expiresAt: new Date(created + (k + 1) * period),
          note: "Ежемесячные кредиты тарифа Free",
        });
      }
    }
    await this.#expire(trx, orgId, now);
  }

  /** Current balance; call after settleOrg in the same transaction. */
  async balance(trx: Trx, orgId: string): Promise<BalanceMilli> {
    const r = await trx
      .selectFrom("platform.credit_ledger")
      .select([
        sql<string>`coalesce(sum(amount_milli), 0)`.as("available"),
        sql<string>`coalesce(-sum(amount_milli) filter (where kind in ('hold','release')), 0)`.as("held"),
      ])
      .where("org_id", "=", orgId)
      .executeTakeFirstOrThrow();
    const available = Number(r.available);
    const held = Number(r.held);
    const buckets = (await this.#liveBuckets(trx, orgId)).sort(byDebitOrder);
    return { balance: available + held, held, available, buckets };
  }

  /** Settled balance in its own transaction (GET /orgs/:id/credits, raise_cap). */
  async readBalance(db: Kysely<DB>, orgId: string): Promise<BalanceMilli> {
    return db.transaction().execute(async (trx) => {
      await this.settleOrg(trx, orgId);
      return this.balance(trx, orgId);
    });
  }

  /** hold(−amount) of a run from buckets with the nearest expiry; INSUFFICIENT_CREDITS when available < amount. */
  async hold(
    trx: Trx,
    h: {
      orgId: string;
      runId: string;
      systemId?: string | null;
      amountMilli: number;
      key: string;
      note?: string;
    },
  ): Promise<void> {
    await this.settleOrg(trx, h.orgId);
    if (await this.#exists(trx, h.orgId, h.key)) return;
    let live = await this.#liveBuckets(trx, h.orgId);
    const avail = live.reduce((s, b) => s + b.remaining, 0);
    if (avail < h.amountMilli) {
      if (!this.isExempt(h.orgId)) throw insufficient(avail, h.amountMilli);
      await this.#devTopUp(trx, h.orgId, h.amountMilli - avail, h.key);
      live = await this.#liveBuckets(trx, h.orgId);
    }
    const parts = allocate(live.sort(byDebitOrder), h.amountMilli);
    await this.#insert(
      trx,
      h.orgId,
      h.key,
      parts.map(({ b, take }) => ({
        kind: "hold",
        amountMilli: -take,
        bucket: b.bucket,
        expiresAt: b.expiresAt,
        runId: h.runId,
        systemId: h.systemId ?? null,
        note: h.note ?? "Резерв на прогон",
      })),
    );
  }

  /** Interview turn gate (billing.yaml#run_charging.interview_turn): available ≤ 0 → 402 INSUFFICIENT_CREDITS. */
  async requireForTurn(trx: Trx, orgId: string, turnCapMilli: number): Promise<void> {
    await this.settleOrg(trx, orgId);
    const { available } = await this.balance(trx, orgId);
    if (this.isExempt(orgId)) {
      if (available < turnCapMilli)
        await this.#devTopUp(trx, orgId, turnCapMilli - available, `turn:${this.now().toISOString()}`);
      return;
    }
    if (available <= 0) throw insufficient(available, 1);
  }

  /**
   * Terminal run settlement in the finalize transaction (billing.yaml#run_charging.build.finish): release(+held),
   * charge(−min(used, cap)) with used = Σ llm_calls.credits_milli (billable), refund on platform failure or when no
   * revision of a build passed G0. Idempotent per run.
   */
  async settleRun(
    trx: Trx,
    run: {
      id: string;
      org_id: string;
      system_id: string | null;
      kind: string;
      credits_cap_milli: string | null;
    },
    outcome: RunOutcome,
  ): Promise<RunCharge> {
    const releaseKey = `release:${run.id}`;
    const chargeKey = `charge:${run.id}`;
    await this.settleOrg(trx, run.org_id);
    if ((await this.#exists(trx, run.org_id, releaseKey)) || (await this.#exists(trx, run.org_id, chargeKey)))
      return { usedMilli: 0, chargedMilli: 0, refundedMilli: 0 };
    const heldRows = await trx
      .selectFrom("platform.credit_ledger")
      .select(["bucket", "bucket_expires_at", sql<string>`-sum(amount_milli)`.as("held")])
      .where("org_id", "=", run.org_id)
      .where("run_id", "=", run.id)
      .where("kind", "=", "hold")
      .groupBy(["bucket", "bucket_expires_at"])
      .execute();
    const held: BucketBalance[] = heldRows
      .map((r) => ({
        bucket: r.bucket as Bucket,
        expiresAt: r.bucket_expires_at ? new Date(r.bucket_expires_at) : null,
        remaining: Number(r.held),
      }))
      .filter((b) => b.remaining > 0)
      .sort(byDebitOrder);
    const totalHeld = held.reduce((s, b) => s + b.remaining, 0);
    const usage = await trx
      .selectFrom("platform.llm_calls")
      .select(sql<string>`coalesce(sum(credits_milli), 0)`.as("used"))
      .where("run_id", "=", run.id)
      .where("billable", "=", true)
      .executeTakeFirstOrThrow();
    const used = Number(usage.used);
    const capMilli =
      totalHeld > 0 ? totalHeld : run.credits_cap_milli !== null ? Number(run.credits_cap_milli) : used;
    const toCharge = Math.min(used, capMilli);
    const base = { runId: run.id, systemId: run.system_id };

    if (totalHeld > 0)
      await this.#insert(
        trx,
        run.org_id,
        releaseKey,
        held.map((b) => ({
          ...base,
          kind: "release",
          amountMilli: b.remaining,
          bucket: b.bucket,
          expiresAt: b.expiresAt,
          note: "Снятие резерва",
        })),
      );
    let parts: { b: BucketBalance; take: number }[] = [];
    if (toCharge > 0) {
      if (totalHeld > 0) parts = allocate(held, toCharge);
      else {
        let live = (await this.#liveBuckets(trx, run.org_id)).sort(byDebitOrder);
        const avail = live.reduce((s, b) => s + b.remaining, 0);
        if (avail < toCharge && this.isExempt(run.org_id)) {
          await this.#devTopUp(trx, run.org_id, toCharge - avail, chargeKey);
          live = (await this.#liveBuckets(trx, run.org_id)).sort(byDebitOrder);
        }
        // Without a hold (interview turn) the charge never exceeds what is available; the platform bears the rest.
        parts = allocate(live, toCharge);
      }
      await this.#insert(
        trx,
        run.org_id,
        chargeKey,
        parts.map(({ b, take }) => ({
          ...base,
          kind: "charge",
          amountMilli: -take,
          bucket: b.bucket,
          expiresAt: b.expiresAt,
          note:
            run.kind === "interview_turn"
              ? "Списание за ход интервью"
              : run.kind === "import_table"
                ? "Списание за импорт таблицы по факту"
                : "Списание за сборку по факту",
        })),
      );
    }
    const charged = sumOf(parts);
    let refunded = 0;
    if (charged > 0 && (await this.#refundable(trx, run, outcome))) {
      await this.#insert(
        trx,
        run.org_id,
        `refund:${run.id}`,
        parts.map(({ b, take }) => ({
          ...base,
          kind: "refund",
          amountMilli: take,
          bucket: b.bucket,
          expiresAt: b.expiresAt,
          note:
            outcome.status === "failed" && outcome.code && REFUND_CODES.has(outcome.code)
              ? "Возврат: сбой платформы"
              : "Возврат: ни одна версия не прошла проверки",
        })),
      );
      refunded = charged;
    }
    // A hold could sit in a bucket that expired meanwhile: its released remainder expires now.
    await this.#expire(trx, run.org_id, this.now());
    return { usedMilli: used, chargedMilli: charged, refundedMilli: refunded };
  }

  /**
   * billing.yaml#run_charging.runtime_ai (M3-02): charge of one runtime AI call by fact, keyed
   * ai:<systemId>:<yyyy-mm-ddThh>:<callId> — the hour bucket of the spec (hour of the call's journal row) plus the call
   * id, so a repeated call never charges twice. Like an interview turn it never exceeds what is available (the
   * platform bears the rest); an exempt org (dev stand) is topped up. Returns the charged milli-credits (0 on a repeat).
   */
  async chargeAi(
    trx: Trx,
    c: { orgId: string; systemId: string; callId: string; at: Date; amountMilli: number; action: string },
  ): Promise<number> {
    await this.settleOrg(trx, c.orgId);
    const key = `ai:${c.systemId}:${c.at.toISOString().slice(0, 13)}:${c.callId}`;
    if (c.amountMilli <= 0 || (await this.#exists(trx, c.orgId, key))) return 0;
    let live = (await this.#liveBuckets(trx, c.orgId)).sort(byDebitOrder);
    const avail = live.reduce((s, b) => s + b.remaining, 0);
    if (avail < c.amountMilli && this.isExempt(c.orgId)) {
      await this.#devTopUp(trx, c.orgId, c.amountMilli - avail, key);
      live = (await this.#liveBuckets(trx, c.orgId)).sort(byDebitOrder);
    }
    const parts = allocate(live, c.amountMilli);
    await this.#insert(
      trx,
      c.orgId,
      key,
      parts.map(({ b, take }) => ({
        kind: "charge",
        amountMilli: -take,
        bucket: b.bucket,
        expiresAt: b.expiresAt,
        systemId: c.systemId,
        note: `ИИ-действие «${c.action}»`,
      })),
    );
    return sumOf(parts);
  }

  /** grant / positive adjustment into a bucket; false when the key was already used. */
  async grant(trx: Trx, orgId: string, g: GrantInput): Promise<boolean> {
    await this.settleOrg(trx, orgId);
    if (g.amountMilli <= 0) throw new Error("grant amount must be positive");
    return this.#grantOnce(trx, orgId, g.key, { kind: g.kind ?? "grant", ...g });
  }

  /** Topup packs (billing.yaml#plans.topup): 60 credits each, 365 days. M1: staff grant; M2: payment webhook. */
  async grantTopup(
    trx: Trx,
    orgId: string,
    t: { packs: number; key: string; createdBy?: string | null; paymentId?: string | null },
  ): Promise<boolean> {
    return this.grant(trx, orgId, {
      bucket: "topup",
      amountMilli: t.packs * TOPUP.milli,
      expiresAt: new Date(this.now().getTime() + TOPUP.days * DAY_MS),
      key: t.key,
      note: `Докупка кредитов: ${t.packs} × ${TOPUP.milli / 1000}`,
      createdBy: t.createdBy ?? null,
      paymentId: t.paymentId ?? null,
    });
  }

  /**
   * Pilot credits granted by the founder's CLI (billing.yaml#plans.pilot.grants.manual): bucket topup, reason
   * pilot_grant (idempotency key pilot_grant:<reference>), 365 days.
   */
  async grantPilot(
    trx: Trx,
    orgId: string,
    g: { credits: number; reference: string; createdBy?: string | null },
  ): Promise<boolean> {
    return this.grant(trx, orgId, {
      bucket: "topup",
      amountMilli: Math.round(g.credits * 1000),
      expiresAt: new Date(this.now().getTime() + PILOT_GRANT_DAYS * DAY_MS),
      key: `pilot_grant:${g.reference}`,
      note: `Кредиты пилота от команды Wizard: ${g.credits}`,
      createdBy: g.createdBy ?? null,
    });
  }

  /** Monthly credits of a paid plan for one period; they expire at the end of the period (D10_interpretations). */
  async grantPlanPeriod(
    trx: Trx,
    orgId: string,
    p: { plan: PaidPlan; start: Date; end: Date; createdBy?: string | null },
  ): Promise<boolean> {
    return this.grant(trx, orgId, {
      bucket: "plan_monthly",
      amountMilli: PLANS[p.plan].monthlyMilli,
      expiresAt: p.end,
      key: `grant:plan_monthly:${orgId}:${p.start.toISOString()}`,
      note: `Кредиты тарифа «${p.plan === "start" ? "Старт" : "Бизнес"}» за период`,
      createdBy: p.createdBy ?? null,
    });
  }

  /** Staff adjustment ± (billing.yaml#ledger.kinds.adjustment); a debit goes by the nearest expiry. */
  async adjust(
    trx: Trx,
    orgId: string,
    a: { amountMilli: number; key: string; note: string; createdBy?: string | null },
  ): Promise<boolean> {
    if (a.amountMilli > 0)
      return this.grant(trx, orgId, {
        kind: "adjustment",
        bucket: "adjustment",
        amountMilli: a.amountMilli,
        expiresAt: null,
        key: a.key,
        note: a.note,
        createdBy: a.createdBy ?? null,
      });
    await this.settleOrg(trx, orgId);
    if (await this.#exists(trx, orgId, a.key)) return false;
    const live = (await this.#liveBuckets(trx, orgId)).sort(byDebitOrder);
    const avail = live.reduce((s, b) => s + b.remaining, 0);
    if (avail < -a.amountMilli) throw insufficient(avail, -a.amountMilli);
    await this.#insert(
      trx,
      orgId,
      a.key,
      allocate(live, -a.amountMilli).map(({ b, take }) => ({
        kind: "adjustment",
        amountMilli: -take,
        bucket: b.bucket,
        expiresAt: b.expiresAt,
        note: a.note,
        createdBy: a.createdBy ?? null,
      })),
    );
    return true;
  }

  /** 402 PLAN_LIMIT unless the org is exempt; call under the org lock (settleOrg/lock) in the creating transaction. */
  async assertLimit(trx: Trx, orgId: string, limit: PlanLimit, current: number): Promise<void> {
    if (this.isExempt(orgId)) return;
    const org = await trx
      .selectFrom("platform.orgs")
      .select("plan")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    planLimit(org.plan, limit, current);
  }

  /** credits_cron: grants and expiry of every org (hourly; each org in its own transaction). */
  async sweep(db: Kysely<DB>): Promise<number> {
    const orgs = await db.selectFrom("platform.orgs").select("id").execute();
    for (const o of orgs) await db.transaction().execute((trx) => this.settleOrg(trx, o.id));
    return orgs.length;
  }

  // -------------------------------------------------------------------------------------------------

  async #exists(trx: Trx, orgId: string, key: string): Promise<boolean> {
    const r = await trx
      .selectFrom("platform.credit_ledger")
      .select("id")
      .where("org_id", "=", orgId)
      .where("idempotency_key", "=", key)
      .executeTakeFirst();
    return !!r;
  }

  async #groups(trx: Trx, orgId: string): Promise<BucketBalance[]> {
    const rows = await trx
      .selectFrom("platform.credit_ledger")
      .select(["bucket", "bucket_expires_at", sql<string>`sum(amount_milli)`.as("remaining")])
      .where("org_id", "=", orgId)
      .groupBy(["bucket", "bucket_expires_at"])
      .execute();
    return rows.map((r) => ({
      bucket: r.bucket as Bucket,
      expiresAt: r.bucket_expires_at ? new Date(r.bucket_expires_at) : null,
      remaining: Number(r.remaining),
    }));
  }

  async #liveBuckets(trx: Trx, orgId: string): Promise<BucketBalance[]> {
    const now = this.now().getTime();
    return (await this.#groups(trx, orgId)).filter((b) => b.remaining > 0 && expiryMs(b) > now);
  }

  async #expire(trx: Trx, orgId: string, now: Date): Promise<void> {
    for (const g of await this.#groups(trx, orgId)) {
      if (!g.expiresAt || g.expiresAt.getTime() > now.getTime() || g.remaining <= 0) continue;
      const prev = await trx
        .selectFrom("platform.credit_ledger")
        .select(sql<string>`count(*)`.as("n"))
        .where("org_id", "=", orgId)
        .where("kind", "=", "expire")
        .where("bucket", "=", g.bucket)
        .where("bucket_expires_at", "=", g.expiresAt)
        .executeTakeFirstOrThrow();
      await this.#insert(
        trx,
        orgId,
        `expire:${g.bucket}:${g.expiresAt.toISOString()}:${Number(prev.n) + 1}`,
        [
          {
            kind: "expire",
            amountMilli: -g.remaining,
            bucket: g.bucket,
            expiresAt: g.expiresAt,
            note: "Срок действия кредитов истёк",
          },
        ],
      );
    }
  }

  async #grantOnce(
    trx: Trx,
    orgId: string,
    key: string,
    g: Omit<GrantInput, "key"> & { kind: "grant" | "adjustment" },
  ): Promise<boolean> {
    if (g.expiresAt && g.expiresAt.getTime() <= this.now().getTime()) return false;
    if (await this.#exists(trx, orgId, key)) return false;
    await this.#insert(trx, orgId, key, [
      {
        kind: g.kind,
        amountMilli: g.amountMilli,
        bucket: g.bucket,
        expiresAt: g.expiresAt,
        paymentId: g.paymentId ?? null,
        note: g.note,
        createdBy: g.createdBy ?? null,
      },
    ]);
    return true;
  }

  /** Exempt org (dev stand): the shortfall is granted as an adjustment so that the ledger stays consistent. */
  async #devTopUp(trx: Trx, orgId: string, amountMilli: number, key: string): Promise<void> {
    await this.#grantOnce(trx, orgId, `dev:${key}`, {
      kind: "adjustment",
      bucket: "adjustment",
      amountMilli,
      expiresAt: null,
      note: "Локальный стенд: пополнение без оплаты",
    });
  }

  async #insert(trx: Trx, orgId: string, key: string, rows: Row[]): Promise<void> {
    if (rows.length === 0) return;
    await trx
      .insertInto("platform.credit_ledger")
      .values(
        rows.map((r, i) => ({
          org_id: orgId,
          kind: r.kind,
          amount_milli: r.amountMilli,
          bucket: r.bucket,
          bucket_expires_at: r.expiresAt,
          run_id: r.runId ?? null,
          system_id: r.systemId ?? null,
          payment_id: r.paymentId ?? null,
          idempotency_key: i === 0 ? key : `${key}#${i + 1}`,
          note_ru: r.note ?? null,
          created_by: r.createdBy ?? null,
        })),
      )
      .execute();
  }

  async #refundable(trx: Trx, run: { id: string; kind: string }, o: RunOutcome): Promise<boolean> {
    if (o.status === "failed" && o.code && REFUND_CODES.has(o.code)) return true;
    if (run.kind !== "build") return false;
    const g0 = await trx
      .selectFrom("platform.gate_reports")
      .select("run_id")
      .where("run_id", "=", run.id)
      .where("level", "=", "G0")
      .where("passed", "=", true)
      .executeTakeFirst();
    return !g0;
  }
}
