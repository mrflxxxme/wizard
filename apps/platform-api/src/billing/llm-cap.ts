// Platform LLM spend cap of a calendar month (M2-15; product.yaml#decisions.D20_eval_budget, D23_pilot): Σ billable
// cost_rub of live/record llm_calls since the 1st of the month in Europe/Moscow. Reaching WIZARD_LLM_MONTHLY_CAP_RUB
// refuses new LLM runs (interview turns, builds, table imports) with 503 LLM_BUDGET_EXHAUSTED and alerts the founder
// once a month; 80 % sends a warning once a month (db.yaml#ops_alerts). Live eval runs in CI on its own database and
// has its own budget (eval.yaml#live_cadence.budget), fixture calls cost nothing here.
// B2-01, B2-04 (D76 (10, 14), grill-6 № 12, 18): the run's org kind decides the rest. The daily cap keeps a staff
// reserve: client and eval runs are refused once the day's total reaches cap − WIZARD_LLM_STAFF_RESERVE_RUB, staff runs
// only at the cap. Eval runs also have their own daily cap (eval orgs' spend only) and the B2 development budget.
import { sql } from "kysely";
import type { Db } from "../db/index.js";
import { ApiError } from "../errors.js";
import { alertOnce, type OpsAlertFn } from "../ops/alert.js";
import { checkB2Budget, llmSpentByKindRub, moscowDay, moscowMonth, orgKind } from "./llm-spend.js";

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

/** Share of the cap that triggers the warning alert. */
export const LLM_CAP_WARN_SHARE = 0.8;

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
  now?: () => Date;
  alert?: OpsAlertFn;
}

export class LlmMonthlyCap {
  readonly #o: LlmMonthlyCapOptions;

  constructor(o: LlmMonthlyCapOptions) {
    this.#o = o;
  }

  get capRub(): number {
    return this.#o.capRub;
  }

  async status(): Promise<LlmCapStatus> {
    const m = moscowMonth(this.#o.now?.() ?? new Date());
    return { month: m.key, spentRub: await llmSpentRub(this.#o.db, m.start, m.end), capRub: this.#o.capRub };
  }

  /**
   * Before a new LLM run of `orgId` (none — counted as a client run): ≥ cap → 503 LLM_BUDGET_EXHAUSTED (+ the monthly
   * alert); the daily cap with the staff reserve; for eval orgs the eval daily cap and the B2 budget; ≥ 80 % → the
   * monthly warning.
   */
  async assert(orgId?: string): Promise<void> {
    const s = await this.status();
    const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
    if (s.spentRub >= s.capRub) {
      await this.#once(`llm_cap_100:${s.month}`, {
        level: "error",
        event: "llm_monthly_cap_reached",
        text: `Wizard: месячный лимит расходов на модели исчерпан — ${rub(s.spentRub)} из ${rub(s.capRub)} за ${s.month} (МСК). Новые сборки и ответы оркестратора отклоняются до 1-го числа или до повышения WIZARD_LLM_MONTHLY_CAP_RUB.`,
        fields: { code: "LLM_BUDGET_EXHAUSTED", reason: `${s.month}: ${s.spentRub} of ${s.capRub} RUB` },
      });
      throw new ApiError("LLM_BUDGET_EXHAUSTED", LLM_BUDGET_EXHAUSTED_RU);
    }
    const kind = orgId ? await orgKind(this.#o.db, orgId) : "client";
    const daily = this.#o.dailyCapRub;
    if (daily !== undefined) {
      const d = moscowDay(this.#o.now?.() ?? new Date());
      const spent = await llmSpentRub(this.#o.db, d.start, d.end);
      if (spent >= daily) {
        await this.#once(`llm_daily_cap:${d.key}`, {
          level: "error",
          event: "llm_daily_cap_reached",
          text: `Wizard: дневной лимит расходов на модели исчерпан — ${rub(spent)} из ${rub(daily)} за ${d.key} (МСК). Новые сборки, замеры и ответы оркестратора отклоняются до полуночи МСК или до повышения WIZARD_LLM_DAILY_CAP_RUB.`,
          fields: { code: "LLM_BUDGET_EXHAUSTED", reason: `${d.key}: ${spent} of ${daily} RUB` },
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
    }
    if (kind === "eval") await this.#assertEval();
    if (s.spentRub >= LLM_CAP_WARN_SHARE * s.capRub)
      await this.#once(`llm_cap_80:${s.month}`, {
        level: "warn",
        event: "llm_monthly_cap_warning",
        text: `Wizard: израсходовано ${Math.floor((100 * s.spentRub) / s.capRub)} % месячного лимита на модели — ${rub(s.spentRub)} из ${rub(s.capRub)} за ${s.month} (МСК).`,
        fields: { code: "LLM_BUDGET_WARNING", reason: `${s.month}: ${s.spentRub} of ${s.capRub} RUB` },
      });
  }

  /** Eval runs (probes, measurements): their own daily cap, then the B2 development budget with its alerts. */
  async #assertEval(): Promise<void> {
    const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;
    const cap = this.#o.evalDailyCapRub;
    if (cap !== undefined) {
      const d = moscowDay(this.#o.now?.() ?? new Date());
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
    const b2 = this.#o.b2Budget;
    if (b2) {
      const s = await checkB2Budget(this.#o.db, { ...b2, alert: this.#o.alert });
      if (s.reached) throw new ApiError("LLM_BUDGET_EXHAUSTED", LLM_B2_BUDGET_EXHAUSTED_RU);
    }
  }

  /** Sends the alert only for the first claim of `key` (ops/alert.ts alertOnce; outside the caller's transaction). */
  async #once(key: string, a: Parameters<OpsAlertFn>[0]): Promise<void> {
    await alertOnce(this.#o.db, key, this.#o.alert, a);
  }
}
