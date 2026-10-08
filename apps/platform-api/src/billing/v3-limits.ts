// Model spend limits for the time of milestone V3 (V3-01; product.yaml#decisions.D77_v3 (18б), docs/plans/2026-10-08-v3.md
// §5): the defaults of config.ts, the founder's own monthly pool and the v3 development budget. The founder's pool is
// the spend of staff orgs (platform.orgs.kind = staff, B2-01): with it staff spend leaves the monthly cap of clients and
// eval, and clients and eval never use the pool. The v3 budget is the eval spend (probes, measurements) since its first
// Moscow day; from that day it replaces the beta v2 budget (llm-spend.ts B2-04). The per-run journal with the
// pre-registration and the wave plan is tools/deploy/spend.mjs (docs/progress/v3-spend.json).
import { sql } from "kysely";
import type { Db } from "../db/index.js";
import { alertOnce, type OpsAlertFn } from "../ops/alert.js";
import { llmSpentByKindRub, moscowDayStart } from "./llm-spend.js";

/** Limits of the time of V3 (D77 (18б)); config.ts takes its defaults from here. */
export const V3_LIMITS = {
  /** WIZARD_LLM_DAILY_CAP_RUB: platform spend per Moscow day (D75 had 700 ₽). */
  dailyCapRub: 3000,
  /** WIZARD_LLM_MONTHLY_CAP_RUB: spend of clients and eval per Moscow month (D26 had 6 000 ₽). */
  monthlyCapRub: 15000,
  /** WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB: the founder's (staff orgs') own pool per Moscow month. */
  founderMonthlyCapRub: 2500,
  /** WIZARD_V3_BUDGET_RUB: eval spend of the v3 development (B2-04 had 1 000 ₽). */
  budgetRub: 12000,
  /** WIZARD_V3_BUDGET_SINCE: the first Moscow day of the v3 budget (D77). */
  budgetSince: "2026-10-08",
} as const;

/** Shares of a cap or budget that warn the founder: once per period and share, only the highest one reached. */
export const V3_ALERT_SHARES: readonly number[] = [0.5, 0.8];

/** The highest of `shares` that `spent` reached against `cap`, in % (50, 80); none — null. */
export function reachedSharePercent(
  spent: number,
  cap: number,
  shares: readonly number[] = V3_ALERT_SHARES,
): number | null {
  const hit = shares.filter((s) => spent >= s * cap);
  return hit.length ? Math.round(100 * Math.max(...hit)) : null;
}

/** Σ billable cost_rub of paid LLM calls of every org except staff ones in [start, end), ₽ (clients and eval). */
export async function llmSpentWithoutStaffRub(db: Db, start: Date, end: Date): Promise<number> {
  const r = await db
    .selectFrom("platform.llm_calls as c")
    .leftJoin("platform.orgs as o", "o.id", "c.org_id")
    .select(sql<string>`coalesce(sum(c.cost_rub), 0)`.as("rub"))
    .where("c.billable", "=", true)
    .where("c.mode", "in", ["live", "record"])
    .where(sql<boolean>`coalesce(o.kind, 'client') <> 'staff'`)
    .where("c.created_at", ">=", start)
    .where("c.created_at", "<", end)
    .executeTakeFirstOrThrow();
  return Number(r.rub);
}

export interface V3BudgetOptions {
  /** WIZARD_V3_BUDGET_RUB. */
  budgetRub: number;
  /** WIZARD_V3_BUDGET_SINCE, yyyy-mm-dd (Moscow). */
  since: string;
}

export interface V3BudgetStatus {
  since: string;
  spentRub: number;
  budgetRub: number;
  sharePercent: number;
  /** The highest alert share reached (50, 80), none — null. */
  warnPercent: number | null;
  /** ≥ 100 %: new eval runs are refused. */
  reached: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

/** Eval spend since the first day of the v3 budget against the budget. */
export async function v3BudgetStatus(db: Db, o: V3BudgetOptions): Promise<V3BudgetStatus> {
  const spentRub = await llmSpentByKindRub(db, "eval", moscowDayStart(o.since));
  return {
    since: o.since,
    spentRub: round2(spentRub),
    budgetRub: o.budgetRub,
    sharePercent: Math.floor((100 * spentRub) / o.budgetRub),
    warnPercent: reachedSharePercent(spentRub, o.budgetRub),
    reached: spentRub >= o.budgetRub,
  };
}

/**
 * The v3 budget with the founder alerts: 50 % and 80 % — one warning each, 100 % — one error per window and budget
 * (alertOnce; the keys carry both, so raising the budget arms them again). No personal data in the texts.
 */
export async function checkV3Budget(
  db: Db,
  o: V3BudgetOptions & { alert?: OpsAlertFn | undefined },
): Promise<V3BudgetStatus> {
  const s = await v3BudgetStatus(db, o);
  const reason = `${s.since}: ${s.spentRub} of ${s.budgetRub} RUB`;
  if (s.reached)
    await alertOnce(db, `v3_budget_100:${s.since}:${s.budgetRub}`, o.alert, {
      level: "error",
      event: "v3_budget_reached",
      text: `Wizard: бюджет разработки v3 на модели исчерпан — ${rub(s.spentRub)} из ${rub(s.budgetRub)} с ${s.since} (МСК). Новые пробы и замеры отклоняются до повышения WIZARD_V3_BUDGET_RUB.`,
      fields: { code: "V3_BUDGET_EXHAUSTED", reason },
    });
  else if (s.warnPercent !== null)
    await alertOnce(db, `v3_budget_${s.warnPercent}:${s.since}:${s.budgetRub}`, o.alert, {
      level: "warn",
      event: "v3_budget_warning",
      text: `Wizard: израсходовано ${s.sharePercent} % бюджета разработки v3 на модели — ${rub(s.spentRub)} из ${rub(s.budgetRub)} с ${s.since} (МСК).`,
      fields: { code: "V3_BUDGET_WARNING", reason },
    });
  return s;
}
