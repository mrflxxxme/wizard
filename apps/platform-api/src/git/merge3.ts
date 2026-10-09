// Line-level three-way merge (V3-32, the item V3-31 left: «построчное слияние»). Both sides are diffed against their
// common base (Myers, diff.ts); the changed line ranges of the two sides are merged when they are apart. It is safe by
// construction: two hunks that overlap or touch (no unchanged base line between them) are a conflict unless both sides
// made exactly the same change, and a diff too large to compute is a conflict too — the file is then left for a human,
// as before (file-level). Nothing is ever resolved by guessing.
import { type Edit, type Line, myers, splitLines } from "./diff.js";

/** Largest edit distance per side (a larger rewrite is a conflict, not a slow merge). */
const MAX_D = 4000;

interface Hunk {
  /** Base lines [start, end) the side replaced. */
  start: number;
  end: number;
  lines: Line[];
  side: "ours" | "theirs";
}

/** ok: the merged text and the hunks taken from each side; otherwise the conflicting base ranges. */
export type Merge3 =
  | { ok: true; text: string; ours: number; theirs: number }
  | {
      ok: false;
      /** Conflicting ranges in base line numbers (1-based, inclusive; an insertion has from = to + 1). */
      conflicts: { from: number; to: number }[];
    };

/** Changed ranges of `edits` (a diff of base → side) as hunks over the base. */
function hunksOf(edits: readonly Edit[], side: Hunk["side"]): Hunk[] {
  const out: Hunk[] = [];
  let base = 0;
  let cur: Hunk | null = null;
  for (const e of edits) {
    if (e.op === " ") {
      if (cur) out.push(cur);
      cur = null;
      base = e.a + 1;
      continue;
    }
    if (!cur) cur = { start: base, end: base, lines: [], side };
    if (e.op === "-") {
      cur.end = e.a + 1;
      base = e.a + 1;
    } else cur.lines.push(e.line);
  }
  if (cur) out.push(cur);
  return out;
}

const sameLines = (a: readonly Line[], b: readonly Line[]) =>
  a.length === b.length && a.every((l, i) => l.text === b[i]?.text && l.eol === b[i]?.eol);

const render = (lines: readonly Line[]) => lines.map((l) => (l.eol ? `${l.text}\n` : l.text)).join("");

/** Three-way merge of texts; `ok: false` lists the conflicting base ranges. */
export function merge3(base: string, ours: string, theirs: string): Merge3 {
  if (ours === theirs) return { ok: true, text: ours, ours: 0, theirs: 0 };
  if (ours === base) return { ok: true, text: theirs, ours: 0, theirs: 1 };
  if (theirs === base) return { ok: true, text: ours, ours: 1, theirs: 0 };
  const b = splitLines(base);
  const eo = myers(b, splitLines(ours), MAX_D);
  const et = myers(b, splitLines(theirs), MAX_D);
  if (!eo || !et) return { ok: false, conflicts: [{ from: 1, to: b.length }] };
  const all = [...hunksOf(eo, "ours"), ...hunksOf(et, "theirs")].sort(
    (x, y) => x.start - y.start || x.end - y.end,
  );
  // Groups of colliding hunks (transitively). Sorted by start, a hunk collides with a member of the open group exactly
  // when it starts before the group's end; earlier groups all end before it.
  const groups: Hunk[][] = [];
  let groupEnd = -1;
  for (const h of all) {
    const g = groups.at(-1);
    if (g && h.start <= groupEnd) {
      g.push(h);
      groupEnd = Math.max(groupEnd, h.end);
    } else {
      groups.push([h]);
      groupEnd = h.end;
    }
  }
  const conflicts: { from: number; to: number }[] = [];
  const chosen: Hunk[] = [];
  let nOurs = 0;
  let nTheirs = 0;
  for (const g of groups) {
    const sides = new Set(g.map((h) => h.side));
    if (sides.size === 1) {
      chosen.push(...g);
      if (g[0]?.side === "ours") nOurs += g.length;
      else nTheirs += g.length;
      continue;
    }
    // Both sides here: only the very same change on both is taken (once).
    const [x, y] = g;
    if (g.length === 2 && x && y && x.start === y.start && x.end === y.end && sameLines(x.lines, y.lines)) {
      chosen.push(x);
      continue;
    }
    const from = Math.min(...g.map((h) => h.start)) + 1;
    const to = Math.max(...g.map((h) => h.end));
    conflicts.push({ from, to });
  }
  if (conflicts.length) return { ok: false, conflicts };
  const out: Line[] = [];
  let at = 0;
  for (const h of chosen.sort((x, y) => x.start - y.start || x.end - y.end)) {
    out.push(...b.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  out.push(...b.slice(at));
  return { ok: true, text: render(out), ours: nOurs, theirs: nTheirs };
}
