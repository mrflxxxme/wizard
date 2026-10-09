// Diff of a commit against its parent (V3-30): changed paths of two flat trees and a unified patch per text file
// (Myers' O(ND) line diff, 3 lines of context, the format of `git diff`).

export type FileStatus = "added" | "modified" | "deleted";

export interface TreeChange {
  path: string;
  status: FileStatus;
  oldOid: string | null;
  newOid: string | null;
}

/** Changed paths between two flat trees (path → blob oid), sorted by path. */
export function diffTrees(
  before: ReadonlyMap<string, { oid: string }>,
  after: ReadonlyMap<string, { oid: string }>,
): TreeChange[] {
  const out: TreeChange[] = [];
  for (const [path, a] of after) {
    const b = before.get(path);
    if (!b) out.push({ path, status: "added", oldOid: null, newOid: a.oid });
    else if (b.oid !== a.oid) out.push({ path, status: "modified", oldOid: b.oid, newOid: a.oid });
  }
  for (const [path, b] of before)
    if (!after.has(path)) out.push({ path, status: "deleted", oldOid: b.oid, newOid: null });
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** A file is binary when its first 8000 bytes hold a NUL (the rule of git). */
export function isBinary(data: Uint8Array): boolean {
  return data.subarray(0, 8000).includes(0);
}

/** One line of a text and whether a newline ends it (the last line of a file may have none). */
export interface Line {
  text: string;
  eol: boolean;
}

/** Lines of a text (the newline of each line kept as a flag). */
export function splitLines(text: string): Line[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const last = parts.pop() as string;
  const out = parts.map((t) => ({ text: t, eol: true }));
  if (last !== "") out.push({ text: last, eol: false });
  return out;
}

const same = (a: Line, b: Line) => a.text === b.text && a.eol === b.eol;

/** One step of a line diff: kept (« »), removed from `a` («-») or added from `b` («+»), with the line indices. */
export type Edit = { op: " " | "-" | "+"; line: Line; a: number; b: number };

/** Myers diff of two line lists; null when it would take more than maxD edits (the caller shows a full rewrite). */
export function myers(a: Line[], b: Line[], maxD: number): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number))
          ? (v[off + k + 1] as number)
          : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && same(a[x] as Line, b[y] as Line)) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d] as Int32Array;
    const at = (k: number) => snap[k + d + 1] as number;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: " ", line: a[x - 1] as Line, a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) edits.push({ op: "+", line: b[y - 1] as Line, a: x, b: y - 1 });
      else edits.push({ op: "-", line: a[x - 1] as Line, a: x - 1, b: y });
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

const range = (start: number, len: number) => (len === 1 ? `${start}` : `${start},${len}`);

export interface Patch {
  /** Hunks only (from the first «@@»); empty when the contents are equal. */
  hunks: string;
  additions: number;
  deletions: number;
}

/** Unified diff hunks of two texts with `context` lines around each change. */
export function unifiedHunks(before: string, after: string, context = 3, maxD = 1500): Patch {
  const a = splitLines(before);
  const b = splitLines(after);
  const edits =
    myers(a, b, maxD) ??
    ([
      ...a.map((line, i) => ({ op: "-", line, a: i, b: 0 })),
      ...b.map((line, i) => ({ op: "+", line, a: a.length, b: i })),
    ] as Edit[]);
  let additions = 0;
  let deletions = 0;
  for (const e of edits) {
    if (e.op === "+") additions++;
    else if (e.op === "-") deletions++;
  }
  // Group changes whose context windows touch into hunks.
  const changed = edits.map((e, i) => (e.op === " " ? -1 : i)).filter((i) => i >= 0);
  const out: string[] = [];
  let i = 0;
  while (i < changed.length) {
    const first = changed[i] as number;
    let last = first;
    while (i + 1 < changed.length && (changed[i + 1] as number) - last <= 2 * context + 1) {
      i++;
      last = changed[i] as number;
    }
    i++;
    const from = Math.max(0, first - context);
    const to = Math.min(edits.length - 1, last + context);
    const slice = edits.slice(from, to + 1);
    const aLen = slice.filter((e) => e.op !== "+").length;
    const bLen = slice.filter((e) => e.op !== "-").length;
    const head = slice[0] as Edit;
    const aStart = aLen === 0 ? head.a : head.a + 1;
    const bStart = bLen === 0 ? head.b : head.b + 1;
    out.push(`@@ -${range(aStart, aLen)} +${range(bStart, bLen)} @@`);
    for (const e of slice) {
      out.push(`${e.op}${e.line.text}`);
      if (!e.line.eol) out.push("\\ No newline at end of file");
    }
  }
  return { hunks: out.length ? `${out.join("\n")}\n` : "", additions, deletions };
}

/** `git diff` text of one file: header lines and hunks. */
export function filePatch(
  path: string,
  status: FileStatus,
  before: string | null,
  after: string | null,
  hunks: string,
): string {
  const head = [`diff --git a/${path} b/${path}`];
  if (status === "added") head.push("new file mode 100644");
  if (status === "deleted") head.push("deleted file mode 100644");
  if (!hunks) return `${head.join("\n")}\n`;
  head.push(before === null ? "--- /dev/null" : `--- a/${path}`);
  head.push(after === null ? "+++ /dev/null" : `+++ b/${path}`);
  return `${head.join("\n")}\n${hunks}`;
}
