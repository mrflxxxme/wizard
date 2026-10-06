// Goal-panel math of the module «Отчёты и панель цели» (B2-17, specs/modules/modules.yaml#manifest.metrics). Pure and
// self-contained: the same text goes into a compiled system as functions/lib/goalPanel.ts (the goalMetrics query) and
// ui/lib/goalPanel.ts (the panel page), so it imports nothing and never reads the clock — time comes in as arguments.
// After editing run `node packages/modules/scripts/gen-reports-lib.mjs` (the text copy in ../lib-source.ts).

/** Period of the panel: the last 7 or 30 days up to now, compared with the same span right before it. */
export type Period = "week" | "month";
export const PERIOD_DAYS: Readonly<Record<Period, number>> = { week: 7, month: 30 };
const DAY_MS = 86_400_000;
/** Dates without time ('YYYY-MM-DD') are days in Moscow time (UTC+3, the runtime's default time zone). */
export const DATE_OFFSET_MS = 3 * 3_600_000;

export type Row = Record<string, unknown>;
/** `{field: value | [values]}` — equality or membership (modules.yaml#manifest.metrics.where). */
export type Where = Record<string, unknown>;
export type MetricCompute =
  | { kind: "count"; entity: string; dateField: string; where?: Where }
  | { kind: "ratio"; entity: string; dateField: string; numerator: Where; denominator?: Where }
  | { kind: "sum"; entity: string; field: string; dateField: string; where?: Where }
  | { kind: "avg"; entity: string; field: string; dateField: string; where?: Where }
  | { kind: "repeat_share"; entity: string; by: string; dateField: string }
  | { kind: "function"; name: string };
export type MetricUnit = "count" | "percent" | "rub" | "minutes" | "days";

/** A half-open span of time [from, to) in epoch milliseconds. */
export interface Span {
  from: number;
  to: number;
}
export interface Windows {
  current: Span;
  previous: Span;
}

export function periodWindows(period: Period, nowMs: number): Windows {
  const len = PERIOD_DAYS[period] * DAY_MS;
  return { current: { from: nowMs - len, to: nowMs }, previous: { from: nowMs - 2 * len, to: nowMs - len } };
}

/** The Moscow day of an instant: 'YYYY-MM-DD'. */
export function isoDate(ms: number): string {
  return new Date(ms + DATE_OFFSET_MS).toISOString().slice(0, 10);
}

/** Time of a date ('YYYY-MM-DD' — Moscow midnight) or date-time value; null when empty or unreadable. */
export function rowTime(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v !== "string" || v === "") return null;
  const t = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) - DATE_OFFSET_MS : Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function inSpan(row: Row, field: string, span: Span): boolean {
  const t = rowTime(row[field]);
  return t !== null && t >= span.from && t < span.to;
}

function same(have: unknown, want: unknown): boolean {
  if (want === null) return have === null || have === undefined;
  return have !== null && have !== undefined && String(have) === String(want);
}

/** The row satisfies every condition of `where` (a list — one of its values). */
export function matches(row: Row, where?: Where): boolean {
  if (!where) return true;
  for (const [k, want] of Object.entries(where)) {
    const have = row[k];
    if (Array.isArray(want) ? !want.some((w) => same(have, w)) : !same(have, want)) return false;
  }
  return true;
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function numbers(rows: readonly Row[], field: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r[field];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Value of a data metric over the rows of one period: count — rows; ratio — % of the denominator rows (all without
 * one) that also match the numerator; sum and avg — of the field's numbers (empty values skipped); repeat_share — % of
 * the distinct `by` values met at least twice. null — nothing to divide by; a function metric is computed by its query.
 */
export function computeValue(c: MetricCompute, rows: readonly Row[]): number | null {
  switch (c.kind) {
    case "count":
      return rows.filter((r) => matches(r, c.where)).length;
    case "ratio": {
      const base = rows.filter((r) => matches(r, c.denominator));
      if (base.length === 0) return null;
      return round((base.filter((r) => matches(r, c.numerator)).length / base.length) * 100, 1);
    }
    case "sum":
      return round(
        numbers(
          rows.filter((r) => matches(r, c.where)),
          c.field,
        ).reduce((a, b) => a + b, 0),
        2,
      );
    case "avg": {
      const xs = numbers(
        rows.filter((r) => matches(r, c.where)),
        c.field,
      );
      return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, 2) : null;
    }
    case "repeat_share": {
      const seen = new Map<string, number>();
      for (const r of rows) {
        const v = r[c.by];
        if (v === null || v === undefined || v === "") continue;
        seen.set(String(v), (seen.get(String(v)) ?? 0) + 1);
      }
      if (seen.size === 0) return null;
      let repeat = 0;
      for (const n of seen.values()) if (n >= 2) repeat++;
      return round((repeat / seen.size) * 100, 1);
    }
    case "function":
      return null;
  }
}

/** A data metric over the current and the previous period (rows by the metric's date field). */
export function metricValues(
  c: MetricCompute,
  rows: readonly Row[],
  w: Windows,
): { value: number | null; previous: number | null } {
  if (c.kind === "function") return { value: null, previous: null };
  const field = c.dateField;
  return {
    value: computeValue(
      c,
      rows.filter((r) => inSpan(r, field, w.current)),
    ),
    previous: computeValue(
      c,
      rows.filter((r) => inSpan(r, field, w.previous)),
    ),
  };
}

export interface EntityReport {
  /** Records created in the current and the previous period. */
  total: number;
  previous: number;
  /** Records of the current period by status value (in the order of the status options). */
  byStatus: { value: string; count: number }[];
}

/** Report of an entity: records created in each period and the current period by status. */
export function entityReport(
  rows: readonly Row[],
  status: string | null,
  statuses: readonly string[],
  w: Windows,
): EntityReport {
  const cur = rows.filter((r) => inSpan(r, "created_at", w.current));
  return {
    total: cur.length,
    previous: rows.filter((r) => inSpan(r, "created_at", w.previous)).length,
    byStatus:
      status === null
        ? []
        : statuses.map((value) => ({ value, count: cur.filter((r) => same(r[status], value)).length })),
  };
}

export interface PageLike {
  items: readonly unknown[];
  continueCursor: string | null;
  isDone: boolean;
}

/**
 * Reads pages while the shared row budget lasts (a query reads ≤ 4000 documents, sdk.md §2.1); capped — the source
 * had more rows than the budget allowed, so its numbers cover only the rows read.
 */
export async function collect(
  page: (cursor: string | null, numItems: number) => Promise<PageLike>,
  budget: { left: number },
): Promise<{ rows: Row[]; capped: boolean }> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  for (;;) {
    if (budget.left <= 0) return { rows, capped: true };
    const p = await page(cursor, Math.min(200, budget.left));
    for (const it of p.items) rows.push(it as Row);
    budget.left -= p.items.length;
    if (p.isDone || p.continueCursor === null || p.items.length === 0) return { rows, capped: false };
    cursor = p.continueCursor;
  }
}

export interface Trend {
  /** value − previous; null when either is unknown. */
  delta: number | null;
  direction: "up" | "down" | "flat" | null;
  /** The change goes the way the metric is better (better: up | down); null — no change or unknown. */
  good: boolean | null;
}

export function trendOf(value: number | null, previous: number | null, better: "up" | "down"): Trend {
  if (value === null || previous === null) return { delta: null, direction: null, good: null };
  const delta = round(value - previous, 2);
  if (delta === 0) return { delta, direction: "flat", good: null };
  const direction = delta > 0 ? "up" : "down";
  return { delta, direction, good: direction === better };
}

/** A metric value for people: «12», «38,5 %», «9 900 ₽», «15 мин», «3 дн.»; «—» when unknown. */
export function formatValue(v: number | null, unit: MetricUnit): string {
  if (v === null) return "—";
  const n = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: unit === "count" ? 0 : 2 }).format(v);
  if (unit === "percent") return `${n} %`;
  if (unit === "rub") return `${n} ₽`;
  if (unit === "minutes") return `${n} мин`;
  if (unit === "days") return `${n} дн.`;
  return n;
}

/** «Прошлый период: 10 · рост на 2» — the line under a goal-panel tile. */
export function trendText(
  value: number | null,
  previous: number | null,
  unit: MetricUnit,
  better: "up" | "down",
): string {
  const t = trendOf(value, previous, better);
  const before = `Прошлый период: ${formatValue(previous, unit)}`;
  if (t.delta === null || t.direction === null) return before;
  if (t.direction === "flat") return `${before} · без изменений`;
  const abs = Math.abs(t.delta);
  const change =
    unit === "percent"
      ? `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(abs)} п. п.`
      : formatValue(abs, unit);
  return `${before} · ${t.direction === "up" ? "рост" : "снижение"} на ${change}${t.good ? " — хорошо" : ""}`;
}

/** CSV for spreadsheets (Excel with Russian locale): «;» between cells, quotes doubled, a BOM for UTF-8. */
export function csvOf(rows: readonly (readonly (string | number | null)[])[]): string {
  const cell = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(cell).join(";")).join("\r\n")}\r\n`;
}
