// Plans, grants and limits: specs/platform/billing.yaml#plans (numbers — product.yaml#decisions.D10_pricing,
// interpretations — D10_interpretations / F5).
import { ApiError } from "../errors.js";

export type PlanId = "free" | "pilot" | "start" | "business";
/** Plans sold through the platform shop (subscriptions, billing.yaml#recurring). */
export type PaidPlan = "start" | "business";
export type PlanLimit = "prod_systems" | "draft_systems" | "members";
export type Bucket = "free_welcome" | "free_monthly" | "plan_monthly" | "topup" | "adjustment";

export const DAY_MS = 24 * 3600_000;
/** billing.yaml#credit.rub_cost_rate: 1 credit ≈ 5 ₽ of LLM cost. */
export const RUB_PER_CREDIT = 5;
/** Free period length (welcome and monthly grants), days. */
export const FREE_PERIOD_DAYS = 30;

export interface PlanDef {
  priceRubMonth: number;
  /** Monthly grant, milli-credits (Free: from day 31, see FREE_PERIOD_DAYS). */
  monthlyMilli: number;
  limits: Record<PlanLimit, number>;
}

export const PLANS: Record<PlanId, PlanDef> = {
  free: { priceRubMonth: 0, monthlyMilli: 25_000, limits: { prod_systems: 1, draft_systems: 3, members: 3 } },
  // billing.yaml#plans.pilot (D24_pilot_free): only the founder's CLI assigns it; credits are granted by hand.
  pilot: { priceRubMonth: 0, monthlyMilli: 0, limits: { prod_systems: 5, draft_systems: 30, members: 30 } },
  start: {
    priceRubMonth: 1990,
    monthlyMilli: 50_000,
    limits: { prod_systems: 2, draft_systems: 10, members: 10 },
  },
  business: {
    priceRubMonth: 6990,
    monthlyMilli: 230_000,
    limits: { prod_systems: 5, draft_systems: 30, members: 30 },
  },
};

/** billing.yaml#plans.free.grants.welcome */
export const WELCOME = { milli: 100_000, days: FREE_PERIOD_DAYS } as const;
/** billing.yaml#plans.topup: one pack = 60 credits for 990 ₽, lives 365 days. */
export const TOPUP = { milli: 60_000, priceRub: 990, days: 365 } as const;

/** Debit order among buckets with the same expiry (billing.yaml#ledger.rules: plan credits before topup). */
export const BUCKET_ORDER: readonly Bucket[] = [
  "free_welcome",
  "free_monthly",
  "plan_monthly",
  "adjustment",
  "topup",
];

export const planOf = (plan: string): PlanDef => PLANS[plan as PlanId] ?? PLANS.free;

/** billing.yaml#plans.*.login_methods: phone_otp only on paid plans (F4); free and pilot — email and Telegram. */
export const phoneOtpAllowed = (plan: string): boolean => plan === "start" || plan === "business";

/** Pilot credits granted by the founder: ledger bucket topup, reason pilot_grant, 365 days (billing.yaml#plans.pilot). */
export const PILOT_GRANT_DAYS = 365;

const LIMIT_RU: Record<PlanLimit, (n: number) => string> = {
  prod_systems: (n) => `На тарифе можно опубликовать не больше ${n} ${n === 1 ? "системы" : "систем"}`,
  draft_systems: (n) => `На тарифе можно держать не больше ${n} черновиков систем`,
  members: (n) => `На тарифе можно до ${n} участников`,
};

/** 402 PLAN_LIMIT {limit, current, plan} when `current` already reaches the plan limit (billing.yaml#plans.enforcement). */
export function assertPlanLimit(plan: string, limit: PlanLimit, current: number): void {
  const max = planOf(plan).limits[limit];
  if (current >= max) throw new ApiError("PLAN_LIMIT", LIMIT_RU[limit](max), { limit: max, current, plan });
}
