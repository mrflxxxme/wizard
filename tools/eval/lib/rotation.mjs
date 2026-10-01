// Smoke subset (specs/quality/eval.yaml#live_cadence.nightly_smoke): n briefs rotating by run period (UTC day, or
// a week with periodDays = 7), at least one per segment and at least one with canaries.
export const SEGMENTS = ["events", "made_to_order", "horizontal"];

/** Periods are counted from this UTC Monday (weekly periods = ISO weeks); earlier dates fold onto period 0. */
const EPOCH_DAY = Date.parse("2025-12-29T00:00:00Z") / 864e5;
const byId = (a, b) => (a.id < b.id ? -1 : 1);
const rules = [(b) => Boolean(b.canaries?.length), ...SEGMENTS.map((s) => (b) => b.segment === s)];

/** One least-recently-picked round: each rule is met first, then the oldest briefs fill the rest (ties by id). */
function round(sorted, last, n) {
  const oldest = (ok, pick) =>
    sorted
      .filter((b) => ok(b) && !pick.includes(b))
      .sort((a, b) => last.get(a.id) - last.get(b.id) || byId(a, b))[0];
  const pick = [];
  for (const ok of rules) {
    if (pick.some(ok)) continue;
    const b = oldest(ok, pick);
    if (b) pick.push(b);
  }
  while (pick.length < Math.min(n, sorted.length)) pick.push(oldest(() => true, pick));
  return pick;
}

/**
 * Deterministic subset for `date` (YYYY-MM-DD or Date), sorted by id: the period's round of a least-recently-picked
 * rotation simulated from EPOCH_DAY, so consecutive runs cover the whole set in about ceil(N / n) runs.
 * `periodDays` = 7 for a weekly smoke (one new subset per week).
 */
export function nightlyBriefs(briefs, date, n = 5, periodDays = 1) {
  const iso = date instanceof Date ? date.toISOString() : String(date);
  const day = Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 864e5);
  const period = Math.max(0, Math.floor((day - EPOCH_DAY) / periodDays));
  const sorted = [...briefs].sort(byId);
  const last = new Map(sorted.map((b) => [b.id, -1]));
  let pick = [];
  for (let p = 0; p <= period; p++) {
    pick = round(sorted, last, n);
    for (const b of pick) last.set(b.id, p);
  }
  return pick.sort(byId);
}
