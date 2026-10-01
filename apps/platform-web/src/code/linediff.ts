// Line diff of one file between two revisions for «изменения ревизии» in the «Код» tab (S-code).

export interface DiffLine {
  t: "same" | "add" | "del";
  text: string;
  /** 1-based line number in the new file (same/add) or in the old file (del). */
  n: number;
}

export type DiffRow = DiffLine | { t: "gap"; skipped: number };

/** LCS table limit: bigger files are shown whole (the caller says so). */
export const MAX_CELLS = 4_000_000;

/** Longest-common-subsequence line diff; null when the files are too big to compare. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // Common prefix and suffix first: typical edits touch a few lines of a big file.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf])
    suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if ((am.length + 1) * (bm.length + 1) > MAX_CELLS) return null;
  const w = bm.length + 1;
  const lcs = new Uint32Array((am.length + 1) * w);
  for (let i = am.length - 1; i >= 0; i--)
    for (let j = bm.length - 1; j >= 0; j--)
      lcs[i * w + j] =
        am[i] === bm[j]
          ? (lcs[(i + 1) * w + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number);
  const out: DiffLine[] = [];
  for (let k = 0; k < pre; k++) out.push({ t: "same", text: b[k] as string, n: k + 1 });
  let i = 0;
  let j = 0;
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) {
      out.push({ t: "same", text: bm[j] as string, n: pre + j + 1 });
      i++;
      j++;
    } else if (
      j < bm.length &&
      (i >= am.length || (lcs[i * w + j + 1] as number) >= (lcs[(i + 1) * w + j] as number))
    ) {
      out.push({ t: "add", text: bm[j] as string, n: pre + j + 1 });
      j++;
    } else {
      out.push({ t: "del", text: am[i] as string, n: pre + i + 1 });
      i++;
    }
  }
  for (let k = b.length - suf; k < b.length; k++) out.push({ t: "same", text: b[k] as string, n: k + 1 });
  return out;
}

/** Keeps `context` unchanged lines around changes; longer unchanged runs become one gap row. */
export function hunks(lines: readonly DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.t === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ t: "gap", skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped > 0) out.push({ t: "gap", skipped });
  return out;
}
