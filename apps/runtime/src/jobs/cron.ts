// 5-field cron (minute hour day-of-month month day-of-week) in an IANA time zone
// (runtime.yaml#workflows.triggers.schedule_cron): parse and find the latest occurrence in a window.

export interface Cron {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  domAny: boolean;
  dowAny: boolean;
}

export const DEFAULT_TIMEZONE = "Europe/Moscow";

const RANGES: readonly [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const MINUTE = 60_000;
/** Search window of lastOccurrence. */
const MAX_LOOKBACK_MIN = 366 * 1440;

function parseField(src: string, [lo, hi]: readonly [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    let a = lo;
    let b = hi;
    if (m[1] !== undefined) {
      a = Number(m[1]);
      b = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? hi : a;
    }
    if (step < 1 || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** null when the expression is not a valid 5-field cron. */
export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (const [i, p] of parts.entries()) {
    const s = parseField(p, RANGES[i] as readonly [number, number]);
    if (!s) return null;
    sets.push(s);
  }
  const [minute, hour, dom, month, dow] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

/** Local wall-clock offset of `tz` at `at`, minutes (invalid zone → Europe/Moscow). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
  } catch {
    return tz === DEFAULT_TIMEZONE ? 180 : tzOffsetMinutes(DEFAULT_TIMEZONE, at);
  }
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, Number(x.value)]));
  const local = Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0);
  return Math.round((local - Math.floor(at.getTime() / MINUTE) * MINUTE) / MINUTE);
}

function matches(c: Cron, l: Date): boolean {
  if (!c.minute.has(l.getUTCMinutes()) || !c.hour.has(l.getUTCHours()) || !c.month.has(l.getUTCMonth() + 1))
    return false;
  const d = c.dom.has(l.getUTCDate());
  const w = c.dow.has(l.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return w;
  if (c.dowAny) return d;
  return d || w;
}

/** Latest occurrence in (after, until] (at most a year back), or null. */
export function lastOccurrence(c: Cron, after: Date, until: Date, tz: string): Date | null {
  let t = Math.floor(until.getTime() / MINUTE) * MINUTE;
  const stop = Math.max(after.getTime(), t - MAX_LOOKBACK_MIN * MINUTE);
  const a = tzOffsetMinutes(tz, new Date(t));
  const fixed = a === tzOffsetMinutes(tz, new Date(stop)) ? a : null;
  for (; t > stop; t -= MINUTE) {
    const off = fixed ?? tzOffsetMinutes(tz, new Date(t));
    if (matches(c, new Date(t + off * MINUTE))) return new Date(t);
  }
  return null;
}
