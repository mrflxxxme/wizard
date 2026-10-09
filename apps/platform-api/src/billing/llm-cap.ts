// Platform LLM spend cap of a calendar month (M2-15; product.yaml#decisions.D20_eval_budget, D23_pilot): Σ billable
// cost_rub of live/record llm_calls since the 1st of the month in Europe/Moscow. Reaching WIZARD_LLM_MONTHLY_CAP_RUB
// refuses new LLM runs (interview turns, builds, table imports) with 503 LLM_BUDGET_EXHAUSTED and alerts the founder
// once a month; 80 % sends a warning once a month (db.yaml#ops_alerts). Live eval runs in CI on its own database and
// has its own budget (eval.yaml#live_cadence.budget), fixture calls cost nothing here.
// B2-01, B2-04 (D76 (10, 14), grill-6 № 12, 18): the run's org kind decides the rest. The daily cap keeps a staff
// reserve: client and eval runs are refused once the day's total reaches cap − WIZARD_LLM_STAFF_RESERVE_RUB, staff runs
// only at the cap. Eval runs also have their own daily cap (eval orgs' spend only) and the B2 development budget.
// V3-01 (D77 (18б), v3-limits.ts): 50 % and 80 % of the daily and of the monthly cap warn the founder once each; the
// founder's own monthly pool (staff orgs) is apart from the monthly cap of clients and eval; the v3 development budget
// replaces the B2 one from its first day.
import { sql } from "kysely";
import type { Config, LlmBalance } from "../config.js";
import type { Db } from "../db/index.js";
import type { OrgKind } from "../db/types.js";
import { ApiError } from "../errors.js";
import { alertOnce, type OpsAlertFn } from "../ops/alert.js";
import {
  checkB2Budget,
  llmSpentByKindRub,
  moscowDay,
  moscowDayStart,
  moscowMonth,
  orgKind,
} from "./llm-spend.js";
import { checkV3Budget, llmSpentWithoutStaffRub, reachedSharePercent } from "./v3-limits.js";

export { moscowDay, moscowMonth } from "./llm-spend.js";

/** api.yaml#Error LLM_BUDGET_EXHAUSTED */
export const LLM_BUDGET_EXHAUSTED_RU =
  "Месячный лимит платформы на работу моделей исчерпан. Новые сборки и ответы в чате снова будут доступны с 1-го числа следующего месяца — команда Born to Build уже знает об этом";

/** api.yaml#Error LLM_BUDGET_EXHAUSTED, the daily cap (D75). */
export const LLM_DAILY_BUDGET_EXHAUSTED_RU =
  "Дневной лимит платформы на работу моделей исчерпан. Новые сборки и ответы в чате снова будут доступны завтра — команда Born to Build уже знает об этом";

/** api.yaml#Error LLM_BUDGET_EXHAUSTED, the daily cap of eval orgs (B2-01). */
export const LLM_EVAL_DAILY_BUDGET_EXHAUSTED_RU =
  "Дневной лимит замеров на работу моделей исчерпан. Новые пробы и замеры снова будут доступны завтра — команда Born to Build уже знает об этом";

/** api.yaml#Error LLM_BUDGET_EXHAUSTED, the beta v2 development budget (B2-04). */
export const LLM_B2_BUDGET_EXHAUSTED_RU =
  "Бюджет разработки беты v2 на работу моделей исчерпан. Новые пробы и замеры будут доступны после того, как основатель поднимет бюджет";

/** api.yaml#Error LLM_BUDGET_EXHAUSTED, the founder's monthly pool (V3-01). */
export const LLM_FOUNDER_BUDGET_EXHAUSTED_RU =
  "Месячный лимит организации основателя на работу моделей исчерпан. Новые сборки и ответы в чате снова будут доступны с 1-го числа следующего месяца или после повышения лимита";

/** api.yaml#Error LLM_BUDGET_EXHAUSTED, the v3 development budget (V3-01). */
export const LLM_V3_BUDGET_EXHAUSTED_RU =
  "Бюджет разработки v3 на работу моделей исчерпан. Новые пробы и замеры будут доступны после того, как основатель поднимет бюджет";

/** Share of the cap that triggers the last warning alert (the first one is 50 %, v3-limits.ts V3_ALERT_SHARES). */
export const LLM_CAP_WARN_SHARE = 0.8;

const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

/** Σ billable cost_rub of paid (live/record) LLM calls in [start, end), ₽ — the whole platform or one org. */
export async function llmSpentRub(db: Db, start: Date, end: Date, orgId?: string): Promise<number> {
  let q = db
    .selectFrom("platform.llm_calls")
    .select(sql<string>`coalesce(sum(cost_rub), 0)`.as("rub"))
    .where("billable", "=", true)
    .where("mode", "in", ["live", "record"])
    .where("created_at", ">=", start)
    .where("created_at", "<", end);
  if (orgId) q = q.where("org_id", "=", orgId);
  const r = await q.executeTakeFirstOrThrow();
  return Number(r.rub);
}

/** Provider names for the founder (models.yaml#providers). */
export const PROVIDER_LABELS: Record<string, string> = {
  zai: "Z.ai",
  cloudru: "Cloud.ru",
  yandex: "Yandex AI Studio",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
};

/** Σ billable cost_rub of paid (live/record) calls of one provider since `since`, ₽ (D76 balance estimate). */
export async function llmProviderSpentRub(db: Db, provider: string, since: Date): Promise<number> {
  const r = await db
    .selectFrom("platform.llm_calls")
    .select(sql<string>`coalesce(sum(cost_rub), 0)`.as("rub"))
    .where("billable", "=", true)
    .where("mode", "in", ["live", "record"])
    .where("provider", "=", provider)
    .where("created_at", ">=", since)
    .executeTakeFirstOrThrow();
  return Number(r.rub);
}

export interface LlmCapStatus {
  month: string;
  spentRub: number;
  capRub: number;
}

export interface LlmMonthlyCapOptions {
  db: Db;
  capRub: number;
  /** WIZARD_LLM_DAILY_CAP_RUB (D75): platform LLM spend per Moscow calendar day; none — no daily cap. */
  dailyCapRub?: number;
  /** WIZARD_LLM_STAFF_RESERVE_RUB (B2-01): the part of the daily cap left to staff orgs; none — 0. */
  staffReserveRub?: number;
  /** WIZARD_LLM_EVAL_DAILY_CAP_RUB (B2-01): eval orgs' own spend per Moscow day; none — no eval cap. */
  evalDailyCapRub?: number;
  /** WIZARD_B2_BUDGET_RUB since WIZARD_B2_BUDGET_SINCE (B2-04): eval spend of the beta v2 development; none — off. */
  b2Budget?: { budgetRub: number; since: string };
  /**
   * WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB (V3-01): the staff orgs' own pool per Moscow month — their spend leaves the
   * monthly cap of clients and eval, which never use the pool; none — one monthly cap for every org.
   */
  founderMonthlyCapRub?: number;
  /**
   * WIZARD_V3_BUDGET_RUB since WIZARD_V3_BUDGET_SINCE (V3-01): eval spend of the v3 development; from its first
   * Moscow day it replaces b2Budget; none — off.
   */
  v3Budget?: { budgetRub: number; since: string };
  now?: () => Date;
  alert?: OpsAlertFn;
  /** D76: provider balances reconciled by hand (WIZARD_LLM_BALANCE_*); none — no balance estimate. */
  balances?: readonly LlmBalance[];
  /** WIZARD_LLM_BALANCE_WARN_RUB: estimated remainder that alerts the founder (once per reconciliation). */
  balanceWarnRub?: number;
}

export class LlmMonthlyCap {
  readonly #o: LlmMonthlyCapOptions;

  constructor(o: LlmMonthlyCapOptions) {
    this.#o = o;
  }

  get capRub(): number {
    return this.#o.capRub;
  }

  /** The monthly cap of the platform; with the founder's pool — the spend of clients and eval only. */
  async status(): Promise<LlmCapStatus> {
    const m = moscowMonth(this.#now());
    const spentRub =
      this.#o.founderMonthlyCapRub === undefined
        ? await llmSpentRub(this.#o.db, m.start, m.end)
        : await llmSpentWithoutStaffRub(this.#o.db, m.start, m.end);
    return { month: m.key, spentRub, capRub: this.#o.capRub };
  }

  /** The founder's monthly pool — the spend of staff orgs; none without WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB. */
  async founderStatus(): Promise<LlmCapStatus | null> {
    const capRub = this.#o.founderMonthlyCapRub;
    if (capRub === undefined) return null;
    const m = moscowMonth(this.#now());
    return { month: m.key, spentRub: await llmSpentByKindRub(this.#o.db, "staff", m.start, m.end), capRub };
  }

  /**
   * Before a new LLM run of `orgId` (none — counted as a client run): the monthly cap (of clients and eval, or the
   * founder's pool for a staff org when it is set) ≥ cap → 503 LLM_BUDGET_EXHAUSTED (+ the monthly alert); the daily
   * cap with the staff reserve; for eval orgs the eval daily cap and the v3 (B2) budget; 50 % and 80 % of the daily
   * and of the monthly cap → one warning each per period (only the highest share reached).
   */
  async assert(orgId?: string): Promise<void> {
    const kind: OrgKind = orgId ? await orgKind(this.#o.db, orgId) : "client";
    const founder = kind === "staff" ? await this.founderStatus() : null;
    const s = founder ?? (await this.status());
    const monthReason = `${s.month}: ${s.spentRub} of ${s.capRub} RUB`;
    if (s.spentRub >= s.capRub) {
      if (founder)
        await this.#once(`llm_founder_cap_100:${s.month}`, {
          level: "error",
          event: "llm_founder_cap_reached",
          text: `Wizard: месячный лимит организации основателя на модели исчерпан — ${rub(s.spentRub)} из ${rub(s.capRub)} за ${s.month} (МСК). Сборки основателя отклоняются до 1-го числа или до повышения WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB; клиенты и замеры работают.`,
          fields: { code: "LLM_BUDGET_EXHAUSTED", reason: monthReason, kind },
        });
      else
        await this.#once(`llm_cap_100:${s.month}`, {
          level: "error",
          event: "llm_monthly_cap_reached",
          text: `Wizard: месячный лимит расходов на модели исчерпан — ${rub(s.spentRub)} из ${rub(s.capRub)} за ${s.month} (МСК). Новые сборки и ответы оркестратора отклоняются до 1-го числа или до повышения WIZARD_LLM_MONTHLY_CAP_RUB.`,
          fields: { code: "LLM_BUDGET_EXHAUSTED", reason: monthReason },
        });
      throw new ApiError(
        "LLM_BUDGET_EXHAUSTED",
        founder ? LLM_FOUNDER_BUDGET_EXHAUSTED_RU : LLM_BUDGET_EXHAUSTED_RU,
      );
    }
    const daily = this.#o.dailyCapRub;
    if (daily !== undefined) {
      const d = moscowDay(this.#now());
      const spent = await llmSpentRub(this.#o.db, d.start, d.end);
      const dayReason = `${d.key}: ${spent} of ${daily} RUB`;
      if (spent >= daily) {
        await this.#once(`llm_daily_cap:${d.key}`, {
          level: "error",
          event: "llm_daily_cap_reached",
          text: `Wizard: дневной лимит расходов на модели исчерпан — ${rub(spent)} из ${rub(daily)} за ${d.key} (МСК). Новые сборки, замеры и ответы оркестратора отклоняются до полуночи МСК или до повышения WIZARD_LLM_DAILY_CAP_RUB.`,
          fields: { code: "LLM_BUDGET_EXHAUSTED", reason: dayReason },
        });
        throw new ApiError("LLM_BUDGET_EXHAUSTED", LLM_DAILY_BUDGET_EXHAUSTED_RU);
      }
      const reserve = Math.min(this.#o.staffReserveRub ?? 0, daily);
      if (kind !== "staff" && reserve > 0 && spent >= daily - reserve) {
        await this.#once(`llm_daily_reserve:${d.key}`, {
          level: "warn",
          event: "llm_daily_reserve_reached",
          text: `Wizard: дневной лимит на модели для клиентов и замеров исчерпан — ${rub(spent)} из ${rub(daily - reserve)} за ${d.key} (МСК). Резерв ${rub(reserve)} оставлен служебной организации; сборки клиентов и замеры отклоняются до полуночи МСК.`,
          fields: {
            code: "LLM_BUDGET_EXHAUSTED",
            reason: `${d.key}: ${spent} of ${daily - reserve} RUB`,
            kind,
          },
        });
        throw new ApiError("LLM_BUDGET_EXHAUSTED", LLM_DAILY_BUDGET_EXHAUSTED_RU);
      }
      const dayPct = reachedSharePercent(spent, daily);
      if (dayPct !== null)
        await this.#once(`llm_daily_${dayPct}:${d.key}`, {
          level: "warn",
          event: "llm_daily_cap_warning",
          text: `Wizard: израсходовано ${Math.floor((100 * spent) / daily)} % дневного лимита на модели — ${rub(spent)} из ${rub(daily)} за ${d.key} (МСК).`,
          fields: { code: "LLM_BUDGET_WARNING", reason: dayReason },
        });
    }
    if (kind === "eval") await this.#assertEval();
    await this.#balances();
    const pct = reachedSharePercent(s.spentRub, s.capRub);
    if (pct === null) return;
    const share = Math.floor((100 * s.spentRub) / s.capRub);
    if (founder)
      await this.#once(`llm_founder_cap_${pct}:${s.month}`, {
        level: "warn",
        event: "llm_founder_cap_warning",
        text: `Wizard: израсходовано ${share} % месячного лимита организации основателя на модели — ${rub(s.spentRub)} из ${rub(s.capRub)} за ${s.month} (МСК).`,
        fields: { code: "LLM_BUDGET_WARNING", reason: monthReason, kind },
      });
    else
      await this.#once(`llm_cap_${pct}:${s.month}`, {
        level: "warn",
        event: "llm_monthly_cap_warning",
        text: `Wizard: израсходовано ${share} % месячного лимита на модели — ${rub(s.spentRub)} из ${rub(s.capRub)} за ${s.month} (МСК).`,
        fields: { code: "LLM_BUDGET_WARNING", reason: monthReason },
      });
  }

  /** Eval runs (probes, measurements): their own daily cap, then the v3 budget (from its first day) or the B2 one. */
  async #assertEval(): Promise<void> {
    const cap = this.#o.evalDailyCapRub;
    if (cap !== undefined) {
      const d = moscowDay(this.#now());
      const spent = await llmSpentByKindRub(this.#o.db, "eval", d.start, d.end);
      if (spent >= cap) {
        await this.#once(`llm_eval_daily_cap:${d.key}`, {
          level: "warn",
          event: "llm_eval_daily_cap_reached",
          text: `Wizard: дневной лимит замеров на модели исчерпан — ${rub(spent)} из ${rub(cap)} за ${d.key} (МСК). Новые пробы и замеры отклоняются до полуночи МСК или до повышения WIZARD_LLM_EVAL_DAILY_CAP_RUB; клиенты и служебная организация работают.`,
          fields: { code: "LLM_BUDGET_EXHAUSTED", reason: `${d.key}: ${spent} of ${cap} RUB`, kind: "eval" },
        });
        throw new ApiError("LLM_BUDGET_EXHAUSTED", LLM_EVAL_DAILY_BUDGET_EXHAUSTED_RU);
      }
    }
    const v3 = this.#o.v3Budget;
    if (v3 && this.#now() >= moscowDayStart(v3.since)) {
      const s = await checkV3Budget(this.#o.db, { ...v3, alert: this.#o.alert });
      if (s.reached) throw new ApiError("LLM_BUDGET_EXHAUSTED", LLM_V3_BUDGET_EXHAUSTED_RU);
      return;
    }
    const b2 = this.#o.b2Budget;
    if (b2) {
      const s = await checkB2Budget(this.#o.db, { ...b2, alert: this.#o.alert });
      if (s.reached) throw new ApiError("LLM_BUDGET_EXHAUSTED", LLM_B2_BUDGET_EXHAUSTED_RU);
    }
  }

  /**
   * D76 «алерт о балансах заранее»: the providers have no balance API for an API key, so the remainder is estimated as
   * the reconciled balance minus our own cost_rub of the provider's calls since then (models.yaml prices: rate and VAT
   * of the price list, so ± a few %). At or below the threshold → one warning per reconciliation (a new
   * WIZARD_LLM_BALANCE_* value re-arms it). The real «balance is zero» comes from the provider (onProviderDegraded).
   */
  async #balances(): Promise<void> {
    const warn = this.#o.balanceWarnRub;
    if (warn === undefined) return;
    for (const b of this.#o.balances ?? []) {
      const spent = await llmProviderSpentRub(this.#o.db, b.provider, b.since);
      const left = b.rub - spent;
      if (left > warn) continue;
      const label = PROVIDER_LABELS[b.provider] ?? b.provider;
      await this.#once(`llm_balance_low:${b.provider}:${b.since.toISOString()}`, {
        level: "warn",
        event: "llm_provider_balance_low",
        text:
          `Wizard: по оценке на балансе ${label} осталось около ${rub(Math.max(0, left))} — порог предупреждения ${rub(warn)}. ` +
          `Сверка: ${rub(b.rub)} на ${b.since.toISOString().slice(0, 16).replace("T", " ")} UTC, с тех пор потрачено ${rub(spent)} по ценам каталога моделей. ` +
          `Пополните баланс и обновите WIZARD_LLM_BALANCE_${b.provider.toUpperCase()}; при нулевом балансе сборки сами уйдут на другого провайдера.`,
        fields: { code: "LLM_BALANCE_LOW", reason: `${b.provider}: ${Math.round(left)} of ${b.rub} RUB` },
      });
    }
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  /** Sends the alert only for the first claim of `key` (ops/alert.ts alertOnce; outside the caller's transaction). */
  async #once(key: string, a: Parameters<OpsAlertFn>[0]): Promise<void> {
    await alertOnce(this.#o.db, key, this.#o.alert, a);
  }
}

/** The cap of a process from its config (platform-api; apps/worker runs the repository agent's tasks under it too). */
export function llmCapOf(config: Config, o: { db: Db; alert?: OpsAlertFn; now?: () => Date }): LlmMonthlyCap {
  return new LlmMonthlyCap({
    db: o.db,
    capRub: config.llmMonthlyCapRub,
    dailyCapRub: config.llmDailyCapRub,
    staffReserveRub: config.llmStaffReserveRub,
    evalDailyCapRub: config.llmEvalDailyCapRub,
    b2Budget: { budgetRub: config.b2BudgetRub, since: config.b2BudgetSince },
    // V3-01: the founder's own monthly pool and the v3 development budget (from its first day instead of B2).
    founderMonthlyCapRub: config.llmFounderMonthlyCapRub,
    v3Budget: { budgetRub: config.v3BudgetRub, since: config.v3BudgetSince },
    ...(o.alert ? { alert: o.alert } : {}),
    balances: config.llmBalances,
    balanceWarnRub: config.llmBalanceWarnRub,
    ...(o.now ? { now: o.now } : {}),
  });
}
