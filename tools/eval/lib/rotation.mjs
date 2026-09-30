// Nightly smoke subset (specs/quality/eval.yaml#live_cadence.nightly_smoke): n briefs rotating by UTC day,
// at least one per segment and at least one with canaries.
export const SEGMENTS = ["events", "made_to_order", "horizontal"];

/** Deterministic subset for `date` (YYYY-MM-DD or Date), sorted by id. */
export function nightlyBriefs(briefs, date, n = 5) {
  const iso = date instanceof Date ? date.toISOString() : String(date);
  const day = Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 864e5);
  const sorted = [...briefs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const pick = [];
  const take = (list) => {
    for (let k = 0; k < list.length; k++) {
      const b = list[(day + k) % list.length];
      if (!pick.includes(b)) return void pick.push(b);
    }
  };
  take(sorted.filter((b) => b.canaries?.length));
  for (const seg of SEGMENTS)
    if (!pick.some((b) => b.segment === seg)) take(sorted.filter((b) => b.segment === seg));
  const rest = sorted.filter((b) => !pick.includes(b));
  const offset = rest.length ? (day * n) % rest.length : 0;
  for (let k = 0; pick.length < n && k < rest.length; k++) pick.push(rest[(offset + k) % rest.length]);
  return pick.sort((a, b) => (a.id < b.id ? -1 : 1));
}
