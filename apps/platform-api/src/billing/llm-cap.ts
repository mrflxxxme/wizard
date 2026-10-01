// Platform LLM spend cap of a calendar month (M2-15; product.yaml#decisions.D20_eval_budget, D23_pilot): Σ billable
// cost_rub of live/record llm_calls since the 1st of the month in Europe/Moscow. Reaching WIZARD_LLM_MONTHLY_CAP_RUB
// refuses new LLM runs (interview turns, builds, table imports) with 503 LLM_BUDGET_EXHAUSTED and alerts the founder
// once a month; 80 % sends a warning once a month (db.yaml#ops_alerts). Live eval runs in CI on its own database and
// has its own budget (eval.yaml#live_cadence.budget), fixture calls cost nothing here.
import { sql } from "kysely";
import type { Db } from "../db/index.js";
import { ApiError } from "../errors.js";
import { alertOnce, type OpsAlertFn } from "../ops/alert.js";

/** api.yaml#Error LLM_BUDGET_EXHAUSTED */
export const LLM_BUDGET_EXHAUSTED_RU =
  "Месячный лимит платформы на работу моделей исчерпан. Новые сборки и ответы в чате снова будут доступны с 1-го числа следующего месяца — команда Wizard уже знает об этом";

/** Share of the cap that triggers the warning alert. */
export const LLM_CAP_WARN_SHARE = 0.8;

/** Moscow has no DST since 2014: UTC+3. */
const MSK_OFFSET_MS = 3 * 3600_000;

/** Calendar month of `now` in Europe/Moscow: key yyyy-mm and its [start, end) instants. */
export function moscowMonth(now: Date): { key: string; start: Date; end: Date } {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const y = msk.getUTCFullYear();
  const m = msk.getUTCMonth();
  return {
    key: `${y}-${String(m + 1).padStart(2, "0")}`,
    start: new Date(Date.UTC(y, m, 1) - MSK_OFFSET_MS),
    end: new Date(Date.UTC(y, m + 1, 1) - MSK_OFFSET_MS),
  };
}

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

  /** Before a new LLM run: ≥ cap → 503 LLM_BUDGET_EXHAUSTED (+ the monthly alert); ≥ 80 % → the monthly warning. */
  async assert(): Promise<void> {
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
    if (s.spentRub >= LLM_CAP_WARN_SHARE * s.capRub)
      await this.#once(`llm_cap_80:${s.month}`, {
        level: "warn",
        event: "llm_monthly_cap_warning",
        text: `Wizard: израсходовано ${Math.floor((100 * s.spentRub) / s.capRub)} % месячного лимита на модели — ${rub(s.spentRub)} из ${rub(s.capRub)} за ${s.month} (МСК).`,
        fields: { code: "LLM_BUDGET_WARNING", reason: `${s.month}: ${s.spentRub} of ${s.capRub} RUB` },
      });
  }

  /** Sends the alert only for the first claim of `key` (ops/alert.ts alertOnce; outside the caller's transaction). */
  async #once(key: string, a: Parameters<OpsAlertFn>[0]): Promise<void> {
    await alertOnce(this.#o.db, key, this.#o.alert, a);
  }
}
