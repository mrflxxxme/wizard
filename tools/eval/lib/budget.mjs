// Live-eval budget (specs/quality/eval.yaml#live_cadence.budget, product.yaml#decisions.D20_eval_budget).
// Spend of a calendar month (UTC) = Σ cost_rub of the ledger (CI runs) ∪ live reports in tools/eval/results/.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** D20_eval_budget (revised 01.10.2026, D23_pilot): ≤ 4 000 ₽ per month for live eval. */
export const MONTHLY_BUDGET_RUB = 4_000;
/**
 * Forecast per (brief, model) pair until the ledger has MIN_HISTORY real runs; conservative on purpose (golden
 * fixtures estimate 8–16 ₽ a pair; 60 ₽ keeps a full run + the weekly reserve within 4 000 ₽, M2-16).
 */
export const DEFAULT_PAIR_RUB = 60;
export const MIN_HISTORY = 3;
/** Safety margin on the historical average cost per pair. */
export const FORECAST_MARGIN = 1.25;
/** live_cadence.nightly_smoke (weekly since D23_pilot; the key name is kept): 5 briefs × the default model. */
export const NIGHTLY_PAIRS = 5;
/** UTC weekday of the scheduled smoke: Sunday 23:17 UTC = Monday 02:17 MSK (.github/workflows/eval-live.yml). */
export const SMOKE_WEEKDAY_UTC = 0;

export const monthOf = (iso) => String(iso).slice(0, 7);
export const emptyLedger = () => ({ v: 1, entries: [] });

export function loadLedger(file) {
  if (!file || !existsSync(file)) return emptyLedger();
  const l = JSON.parse(readFileSync(file, "utf8"));
  if (l?.v !== 1 || !Array.isArray(l.entries)) throw new Error(`журнал бюджета ${file}: неизвестный формат`);
  return l;
}

/** Evaluated pairs of a result (harness: non-skipped runs; spec_only: runs). */
export const resultPairs = (result) => (result.runs ?? []).filter((r) => !r.skipped).length;
export const resultCost = (result) => round2((result.runs ?? []).reduce((a, r) => a + (r.cost_rub ?? 0), 0));
/** Only runs that spent money: harness live/record, spec_only without --dry-run. */
export const isPaid = (result) =>
  result.mode === "harness" ? result.llm_mode === "live" || result.llm_mode === "record" : !result.dry_run;

/** Ledger entry of a finished run. */
export function entryFromResult(result, meta = {}) {
  return {
    id: result.started_at,
    date: result.started_at.slice(0, 10),
    month: monthOf(result.started_at),
    kind: meta.kind ?? "manual",
    pairs: resultPairs(result),
    cost_rub: resultCost(result),
    estimated: false,
    ...(meta.runUrl ? { run_url: meta.runUrl } : {}),
    ...(meta.commit ? { commit: meta.commit } : {}),
  };
}

/** Fail-safe entry when a run produced no result (crash, timeout): the forecast is booked as spent. */
export function estimatedEntry(now, meta) {
  const iso = now.toISOString();
  return {
    id: `${iso}#estimated`,
    date: iso.slice(0, 10),
    month: monthOf(iso),
    kind: meta.kind ?? "manual",
    pairs: meta.pairs ?? 0,
    cost_rub: round2(meta.forecastRub ?? 0),
    estimated: true,
    ...(meta.runUrl ? { run_url: meta.runUrl } : {}),
  };
}

export function addEntry(ledger, entry) {
  return { v: 1, entries: [...ledger.entries.filter((e) => e.id !== entry.id), entry] };
}

/** Paid runs among result JSON files of a folder (committed live reports: results/<date>-harness.json). */
export function resultsEntries(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    let r;
    try {
      r = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!r?.started_at || !Array.isArray(r.runs) || !isPaid(r)) continue;
    out.push(entryFromResult(r, { kind: "report" }));
  }
  return out;
}

/** Ledger ∪ reports, deduplicated by run id (started_at). */
export function mergeEntries(...lists) {
  const m = new Map();
  for (const e of lists.flat()) if (!m.has(e.id)) m.set(e.id, e);
  return [...m.values()];
}

export const monthSpent = (entries, month) =>
  round2(entries.filter((e) => e.month === month).reduce((a, e) => a + e.cost_rub, 0));

/** Forecast ₽ per pair: margin × average of the last 10 real runs, or DEFAULT_PAIR_RUB with too little history. */
export function costPerPair(entries) {
  const real = entries
    .filter((e) => !e.estimated && e.pairs > 0)
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(-10);
  if (real.length < MIN_HISTORY) return DEFAULT_PAIR_RUB;
  const pairs = real.reduce((a, e) => a + e.pairs, 0);
  const cost = real.reduce((a, e) => a + e.cost_rub, 0);
  return round2((cost / pairs) * FORECAST_MARGIN);
}

/** Scheduled weekly smokes left in the month after `now` (UTC days after today that fall on SMOKE_WEEKDAY_UTC). */
export function smokesLeft(now) {
  const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  let n = 0;
  for (let d = now.getUTCDate() + 1; d <= days; d++)
    if (new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d)).getUTCDay() === SMOKE_WEEKDAY_UTC) n++;
  return n;
}

/**
 * Whether a live run may start (live_cadence.budget).
 *   nightly: spent + forecast ≤ budget.
 *   full:    spent + forecast + reserve for the remaining weekly smokes ≤ budget (the smoke keeps running).
 * maxCostRub caps the run itself (the harness stops starting briefs once it is reached).
 */
export function decide({ kind, pairs, entries, now = new Date(), budget = MONTHLY_BUDGET_RUB }) {
  const month = monthOf(now.toISOString());
  const spent = monthSpent(entries, month);
  const perPair = costPerPair(entries);
  const forecast = round2(pairs * perPair);
  const reserve = kind === "full" ? round2(NIGHTLY_PAIRS * perPair * smokesLeft(now)) : 0;
  const maxCostRub = round2(budget - spent - reserve);
  const run = pairs > 0 && forecast <= maxCostRub;
  const base = { kind, month, budget, spent, perPair, pairs, forecast, reserve, maxCostRub, run };
  if (run) return { ...base, reason: "" };
  if (pairs <= 0) return { ...base, reason: "нет брифов для прогона" };
  return {
    ...base,
    reason:
      kind === "full"
        ? `полный прогон не стартует: израсходовано ${spent} ₽ из ${budget} ₽ за ${month}, прогноз ${forecast} ₽ и резерв еженедельных прогонов ${reserve} ₽ превышают остаток — нужна эскалация E-MONEY (specs/escalation.yaml)`
        : `еженедельный прогон не стартует: израсходовано ${spent} ₽ из ${budget} ₽ за ${month}, прогноз ${forecast} ₽ превышает остаток`,
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}
