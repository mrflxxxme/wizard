// Model spend by purpose (B2-04; product.yaml#decisions.D76_beta_v2 (10, 14), docs/reviews/grill-6.md № 12, 18). The
// purpose of an llm_call is the kind of its org (platform.orgs.kind, migration 0031): client, staff (the founder's own
// orgs) or eval (probes and measurements run from eval orgs). Only paid calls count: billable live/record, cost_rub ₽.
// The beta v2 development budget (WIZARD_B2_BUDGET_RUB since WIZARD_B2_BUDGET_SINCE, Moscow) is the eval spend of that
// window: 70 % and 100 % alert the founder once (alertOnce), 100 % refuses new eval runs (llm-cap.ts).
import { sql } from "kysely";
import type { Db } from "../db/index.js";
import type { OrgKind } from "../db/types.js";
import { alertOnce, type OpsAlertFn } from "../ops/alert.js";

/** Kinds of an org = purposes of its LLM calls, in report order. */
export const ORG_KINDS: readonly OrgKind[] = ["client", "staff", "eval"];

export const isOrgKind = (v: unknown): v is OrgKind => (ORG_KINDS as readonly unknown[]).includes(v);

/** Share of the B2 budget that triggers the warning alert (grill-6 № 18). */
export const B2_BUDGET_WARN_SHARE = 0.7;

/** Moscow has no DST since 2014: UTC+3. */
const MSK_OFFSET_MS = 3 * 3600_000;
const DAY_MS = 86_400_000;

const dayKey = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Calendar day of `now` in Europe/Moscow: key yyyy-mm-dd and its [start, end) instants. */
export function moscowDay(now: Date): { key: string; start: Date; end: Date } {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const y = msk.getUTCFullYear();
  const m = msk.getUTCMonth();
  const d = msk.getUTCDate();
  return {
    key: dayKey(y, m, d),
    start: new Date(Date.UTC(y, m, d) - MSK_OFFSET_MS),
    end: new Date(Date.UTC(y, m, d + 1) - MSK_OFFSET_MS),
  };
}

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

/** Start of the Moscow day yyyy-mm-dd. */
export const moscowDayStart = (key: string): Date => new Date(Date.parse(`${key}T00:00:00Z`) - MSK_OFFSET_MS);

/** Kind of an org; a missing org counts as client. */
export async function orgKind(db: Db, orgId: string): Promise<OrgKind> {
  const o = await db.selectFrom("platform.orgs").select("kind").where("id", "=", orgId).executeTakeFirst();
  return isOrgKind(o?.kind) ? o.kind : "client";
}

/** Σ billable cost_rub of paid LLM calls of the orgs of `kind` since `start` (until `end`), ₽. */
export async function llmSpentByKindRub(db: Db, kind: OrgKind, start: Date, end?: Date): Promise<number> {
  let q = db
    .selectFrom("platform.llm_calls as c")
    .innerJoin("platform.orgs as o", "o.id", "c.org_id")
    .select(sql<string>`coalesce(sum(c.cost_rub), 0)`.as("rub"))
    .where("c.billable", "=", true)
    .where("c.mode", "in", ["live", "record"])
    .where("o.kind", "=", kind)
    .where("c.created_at", ">=", start);
  if (end) q = q.where("c.created_at", "<", end);
  const r = await q.executeTakeFirstOrThrow();
  return Number(r.rub);
}

export interface B2BudgetOptions {
  /** WIZARD_B2_BUDGET_RUB. */
  budgetRub: number;
  /** WIZARD_B2_BUDGET_SINCE, yyyy-mm-dd (Moscow). */
  since: string;
}

export interface B2BudgetStatus {
  since: string;
  spentRub: number;
  budgetRub: number;
  sharePercent: number;
  /** ≥ 70 %: the founder is warned. */
  warn: boolean;
  /** ≥ 100 %: new eval runs are refused. */
  reached: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const rub = (n: number) => `${Math.round(n).toLocaleString("ru-RU")} ₽`;

/** Eval spend since the start of the B2 budget window against the budget. */
export async function b2BudgetStatus(db: Db, o: B2BudgetOptions): Promise<B2BudgetStatus> {
  const spentRub = await llmSpentByKindRub(db, "eval", moscowDayStart(o.since));
  return {
    since: o.since,
    spentRub: round2(spentRub),
    budgetRub: o.budgetRub,
    sharePercent: Math.floor((100 * spentRub) / o.budgetRub),
    warn: spentRub >= B2_BUDGET_WARN_SHARE * o.budgetRub,
    reached: spentRub >= o.budgetRub,
  };
}

/**
 * B2 budget with the founder alerts: 70 % — one warning, 100 % — one error per window and budget (alertOnce; the
 * keys carry both, so raising the budget arms them again). No personal data in the texts.
 */
export async function checkB2Budget(
  db: Db,
  o: B2BudgetOptions & { alert?: OpsAlertFn | undefined },
): Promise<B2BudgetStatus> {
  const s = await b2BudgetStatus(db, o);
  const reason = `${s.since}: ${s.spentRub} of ${s.budgetRub} RUB`;
  if (s.reached)
    await alertOnce(db, `b2_budget_100:${s.since}:${s.budgetRub}`, o.alert, {
      level: "error",
      event: "b2_budget_reached",
      text: `Wizard: бюджет разработки беты v2 на модели исчерпан — ${rub(s.spentRub)} из ${rub(s.budgetRub)} с ${s.since} (МСК). Новые пробы и замеры отклоняются до повышения WIZARD_B2_BUDGET_RUB.`,
      fields: { code: "B2_BUDGET_EXHAUSTED", reason },
    });
  else if (s.warn)
    await alertOnce(db, `b2_budget_70:${s.since}:${s.budgetRub}`, o.alert, {
      level: "warn",
      event: "b2_budget_warning",
      text: `Wizard: израсходовано ${s.sharePercent} % бюджета разработки беты v2 на модели — ${rub(s.spentRub)} из ${rub(s.budgetRub)} с ${s.since} (МСК).`,
      fields: { code: "B2_BUDGET_WARNING", reason },
    });
  return s;
}

export interface LlmSpendDay {
  /** yyyy-mm-dd (Moscow). */
  day: string;
  client: number;
  staff: number;
  eval: number;
  total: number;
}

export interface LlmSpendReport {
  days: LlmSpendDay[];
  b2: B2BudgetStatus;
}

/** Upper bound of the report window, days. */
export const LLM_SPEND_DAYS_MAX = 92;

/**
 * Spend by purpose for the last `days` Moscow days up to `now` (oldest first, days without calls as zeros) and the
 * B2 budget — GET /admin/llm-spend and the daily summary of the «Бета v2» page.
 */
export async function llmSpendByDay(
  db: Db,
  o: { days: number; now: Date; b2: B2BudgetOptions },
): Promise<LlmSpendReport> {
  const n = Math.min(Math.max(1, Math.floor(o.days)), LLM_SPEND_DAYS_MAX);
  const today = moscowDay(o.now);
  const start = new Date(today.start.getTime() - (n - 1) * DAY_MS);
  const rows = await db
    .selectFrom("platform.llm_calls as c")
    .leftJoin("platform.orgs as o", "o.id", "c.org_id")
    .select([
      sql<string>`to_char(c.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD')`.as("day"),
      sql<string>`coalesce(o.kind, 'client')`.as("kind"),
      sql<string>`coalesce(sum(c.cost_rub), 0)`.as("rub"),
    ])
    .where("c.billable", "=", true)
    .where("c.mode", "in", ["live", "record"])
    .where("c.created_at", ">=", start)
    .where("c.created_at", "<", today.end)
    .groupBy([sql`1`, sql`2`])
    .execute();
  const days: LlmSpendDay[] = [];
  for (let i = 0; i < n; i++) {
    const key = moscowDay(new Date(start.getTime() + i * DAY_MS)).key;
    const at = (k: OrgKind) =>
      round2(rows.filter((r) => r.day === key && r.kind === k).reduce((s, r) => s + Number(r.rub), 0));
    const d = { day: key, client: at("client"), staff: at("staff"), eval: at("eval") };
    days.push({ ...d, total: round2(d.client + d.staff + d.eval) });
  }
  return { days, b2: await b2BudgetStatus(db, o.b2) };
}
