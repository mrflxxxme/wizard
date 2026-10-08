// Layered layout of a brief diagram (V3-06; graphs of briefDiagrams, builder-v3.md §3 C1): our own code, no graph
// library and no Mermaid. Ranks top → bottom by the longest path (cycles broken by DFS), sources pulled down next to
// their first successor, a rank wider than the container is split into several, long edges get lanes (virtual nodes),
// a few barycenter sweeps order the ranks. Node labels wrap inside their boxes; edge labels sit in the band between two
// ranks on their own edge, stacked in rows when they would collide — so nodes never overlap nodes, labels never overlap
// nodes or other labels, and nothing is wider than the container (390 px phones included). Text widths are estimated
// from an Inter advance table (no DOM): the layout is a pure function, the browser test checks the real glyphs fit.
import type { BriefGraph, BriefNodeKind } from "@wizard/appspec";

export interface LayoutOptions {
  /** Width available for the diagram, px (the container's inner width). */
  width: number;
}

export interface LaidNode {
  id: string;
  label: string;
  kind: BriefNodeKind;
  /** The label wrapped into lines that fit the box. */
  lines: string[];
  /** Top-left corner and size, px. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidEdge {
  from: string;
  to: string;
  label: string;
  /** The edge label wrapped into lines (empty — no label box). */
  lines: string[];
  /** SVG path from the source to the target (through its lanes and its label). */
  d: string;
  /** Label box: top-left corner and size, px (zero size when there is no label). */
  lx: number;
  ly: number;
  lw: number;
  lh: number;
  /** The edge was reversed to break a cycle: the arrow is drawn at the start of the path. */
  reversed: boolean;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: LaidNode[];
  edges: LaidEdge[];
}

/** Geometry of the layout (px). Font sizes match BriefDiagram.module.css. */
export const BRIEF_LAYOUT = {
  pad: 4,
  nodeFont: 13,
  nodeLine: 17,
  nodePadX: 12,
  nodePadY: 9,
  nodeMinW: 112,
  nodeMaxW: 280,
  /** Below this a node in an overcrowded rank never shrinks (the rank is split instead). */
  nodeFloorW: 72,
  nodeMaxLines: 10,
  edgeFont: 11.5,
  edgeLine: 14,
  edgePadX: 7,
  edgePadY: 3,
  edgeMaxLines: 3,
  edgeMaxW: 190,
  gapX: 14,
  lane: 10,
  laneGap: 6,
  bandMin: 34,
  bandPad: 10,
  labelGap: 6,
} as const;

const L = BRIEF_LAYOUT;

// ——— text measure ———

const NARROW = new Set([..."ijlI|!.,:;'`ıí"]);
const WIDE_LATIN = new Set([..."mwMW@%"]);
const WIDE_CYR_LOWER = new Set([..."жмшщюыфЖМШЩЮЫФ"]);
const SPECIAL: Record<string, number> = {
  " ": 0.28,
  f: 0.34,
  r: 0.4,
  t: 0.38,
  "—": 0.92,
  "–": 0.62,
  "…": 0.9,
  "·": 0.3,
  "«": 0.52,
  "»": 0.52,
  "(": 0.38,
  ")": 0.38,
  "-": 0.42,
  "/": 0.42,
  "→": 0.9,
  "₽": 0.68,
  "№": 1.1,
};

/** Advance width of one character in em (Inter 400–500, rounded up). */
function charEm(c: string): number {
  const special = SPECIAL[c];
  if (special !== undefined) return special;
  if (NARROW.has(c)) return 0.3;
  if (WIDE_LATIN.has(c)) return 0.92;
  if (WIDE_CYR_LOWER.has(c)) return c === c.toLowerCase() ? 0.84 : 1.0;
  if (/[0-9]/.test(c)) return 0.64;
  if (/[a-zа-яё]/.test(c)) return 0.6;
  if (/[A-ZА-ЯЁ]/.test(c)) return 0.76;
  return 0.7;
}

/** Estimated width of a text line, px, at the given font size (a little wider than Inter draws it). */
export function textWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const c of text) em += charEm(c);
  return em * fontSize * 1.03;
}

/** Greedy word wrap into lines no wider than `max` px; a word longer than a line is cut; over `maxLines` ends in «…». */
export function wrapText(text: string, max: number, fontSize: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const push = (s: string) => lines.push(s);
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, fontSize) <= max) {
      line = next;
      continue;
    }
    if (line) push(line);
    line = "";
    let rest = word;
    while (textWidth(rest, fontSize) > max) {
      let cut = 1;
      while (cut < rest.length && textWidth(rest.slice(0, cut + 1), fontSize) <= max) cut++;
      push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1] ?? ""}…`;
  while (textWidth(last, fontSize) > max && last.length > 1) last = `${last.slice(0, -2)}…`;
  kept[maxLines - 1] = last;
  return kept;
}

// ——— graph ———

interface Item {
  /** Index of a real node, or -1 for a lane (virtual node of a long edge). */
  node: number;
  /** Edge index of a lane. */
  edge: number;
  rank: number;
  x: number;
  w: number;
}

interface Link {
  /** Upper and lower node (after cycle breaking). */
  u: number;
  v: number;
  label: string;
  reversed: boolean;
  from: string;
  to: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Lays out a brief graph for a container of `width` px: positions of nodes and label boxes, SVG paths of edges, the
 * height. Deterministic; any graph (empty, cyclic, with unknown edge ends) gives a layout without overlaps.
 */
export function layoutBriefGraph(graph: BriefGraph, opts: LayoutOptions): GraphLayout {
  const width = Math.max(200, Math.round(opts.width));
  const avail = width - 2 * L.pad;
  // Nodes with unique ids, in the order of the graph.
  const nodes: { id: string; label: string; kind: BriefNodeKind }[] = [];
  const index = new Map<string, number>();
  for (const n of graph.nodes) {
    if (index.has(n.id)) continue;
    index.set(n.id, nodes.length);
    nodes.push({ id: n.id, label: n.label || "—", kind: n.kind });
  }
  if (nodes.length === 0) return { width, height: 2 * L.pad, nodes: [], edges: [] };
  // Edges between known distinct nodes; the same pair twice is one edge with both labels.
  const pairs = new Map<string, { a: number; b: number; labels: string[]; from: string; to: string }>();
  for (const e of graph.edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    const key = `${a}>${b}`;
    const p = pairs.get(key) ?? { a, b, labels: [], from: e.from, to: e.to };
    if (e.label && !p.labels.includes(e.label)) p.labels.push(e.label);
    pairs.set(key, p);
  }
  // Cycle breaking: DFS in node order, an edge back into the stack is reversed.
  const out = nodes.map(() => [] as { a: number; b: number }[]);
  for (const p of pairs.values()) out[p.a]?.push(p);
  const state = nodes.map(() => 0); // 0 new, 1 on stack, 2 done
  const back = new Set<string>();
  const dfs = (start: number) => {
    const stack: { n: number; i: number }[] = [{ n: start, i: 0 }];
    state[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1] as { n: number; i: number };
      const next = out[top.n]?.[top.i++];
      if (!next) {
        state[top.n] = 2;
        stack.pop();
        continue;
      }
      if (state[next.b] === 1) back.add(`${next.a}>${next.b}`);
      else if (state[next.b] === 0) {
        state[next.b] = 1;
        stack.push({ n: next.b, i: 0 });
      }
    }
  };
  nodes.forEach((_, i) => {
    if (state[i] === 0) dfs(i);
  });
  const links: Link[] = [];
  const seenLink = new Map<string, Link>();
  for (const p of pairs.values()) {
    const reversed = back.has(`${p.a}>${p.b}`);
    const u = reversed ? p.b : p.a;
    const v = reversed ? p.a : p.b;
    const label = p.labels.join("; ");
    const dup = seenLink.get(`${u}>${v}`);
    if (dup) {
      // a → b and b → a: one line, both labels.
      if (label && !dup.label.includes(label)) dup.label = dup.label ? `${dup.label}; ${label}` : label;
      continue;
    }
    const link = { u, v, label, reversed, from: p.from, to: p.to };
    seenLink.set(`${u}>${v}`, link);
    links.push(link);
  }
  const preds = nodes.map(() => [] as number[]);
  const succs = nodes.map(() => [] as number[]);
  for (const l of links) {
    preds[l.v]?.push(l.u);
    succs[l.u]?.push(l.v);
  }
  // Longest-path ranks (Kahn order over the DAG).
  const rank = nodes.map(() => 0);
  const indeg = preds.map((p) => p.length);
  const queue = nodes.map((_, i) => i).filter((i) => indeg[i] === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const n = queue[qi] as number;
    for (const m of succs[n] ?? []) {
      rank[m] = Math.max(rank[m] ?? 0, (rank[n] ?? 0) + 1);
      indeg[m] = (indeg[m] ?? 0) - 1;
      if (indeg[m] === 0) queue.push(m);
    }
  }
  // Sources sit right above their first successor (an actor next to its first scenario, not all at the top).
  nodes.forEach((_, i) => {
    if ((preds[i]?.length ?? 0) > 0 || (succs[i]?.length ?? 0) === 0) return;
    rank[i] = Math.max(0, Math.min(...(succs[i] ?? []).map((m) => rank[m] ?? 0)) - 1);
  });
  // A rank with more nodes than fit side by side is split: the rest moves to a new rank right below.
  const cap = Math.max(1, Math.floor((avail + L.gapX) / (L.nodeMinW + L.gapX)));
  for (let r = 0; r <= Math.max(...rank); r++) {
    const inRank = nodes.map((_, i) => i).filter((i) => rank[i] === r);
    if (inRank.length <= cap) continue;
    const moved = new Set(inRank.slice(cap));
    nodes.forEach((_, i) => {
      if ((rank[i] ?? 0) > r || moved.has(i)) rank[i] = (rank[i] ?? 0) + 1;
    });
  }
  const maxRank = Math.max(...rank);
  // Ranks with lanes of long edges.
  const ranks: Item[][] = Array.from({ length: maxRank + 1 }, () => []);
  nodes.forEach((_, i) => {
    ranks[rank[i] ?? 0]?.push({ node: i, edge: -1, rank: rank[i] ?? 0, x: 0, w: 0 });
  });
  const chains: Item[][] = links.map((l, ei) => {
    const chain: Item[] = [];
    for (let r = (rank[l.u] ?? 0) + 1; r < (rank[l.v] ?? 0); r++) {
      const lane: Item = { node: -1, edge: ei, rank: r, x: 0, w: L.lane };
      ranks[r]?.push(lane);
      chain.push(lane);
    }
    return chain;
  });
  // Barycenter ordering: neighbours of an item in the rank above / below.
  const upper = new Map<Item, Item[]>();
  const lower = new Map<Item, Item[]>();
  const realItem = new Map<number, Item>();
  for (const row of ranks) for (const it of row) if (it.node >= 0) realItem.set(it.node, it);
  const link = (a: Item, b: Item) => {
    lower.set(a, [...(lower.get(a) ?? []), b]);
    upper.set(b, [...(upper.get(b) ?? []), a]);
  };
  links.forEach((l, ei) => {
    const path = [realItem.get(l.u), ...(chains[ei] ?? []), realItem.get(l.v)].filter(Boolean) as Item[];
    for (let i = 1; i < path.length; i++) link(path[i - 1] as Item, path[i] as Item);
  });
  const pos = new Map<Item, number>();
  const renumber = () => {
    for (const row of ranks)
      row.forEach((it, i) => {
        pos.set(it, i);
      });
  };
  renumber();
  const sweep = (row: Item[], near: Map<Item, Item[]>) => {
    const key = new Map<Item, number>();
    for (const it of row) {
      const ns = near.get(it) ?? [];
      key.set(it, ns.length ? ns.reduce((s, n) => s + (pos.get(n) ?? 0), 0) / ns.length : (pos.get(it) ?? 0));
    }
    row.sort((a, b) => (key.get(a) ?? 0) - (key.get(b) ?? 0) || (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
    row.forEach((it, i) => {
      pos.set(it, i);
    });
  };
  for (let it = 0; it < 4; it++) {
    for (let r = 1; r <= maxRank; r++) sweep(ranks[r] ?? [], upper);
    for (let r = maxRank - 1; r >= 0; r--) sweep(ranks[r] ?? [], lower);
  }
  // Widths, lines and x of every item; each rank is centred.
  const lines = new Map<number, string[]>();
  const heights = new Map<number, number>();
  let widest = 0;
  for (const row of ranks) {
    const real = row.filter((it) => it.node >= 0);
    const lanes = row.length - real.length;
    const gaps = Math.max(0, real.length - 1) * L.gapX + lanes * L.laneGap;
    const share = real.length ? (avail - lanes * L.lane - gaps) / real.length : avail;
    const boxMax = Math.max(L.nodeFloorW, Math.min(L.nodeMaxW, share));
    for (const it of real) {
      const n = nodes[it.node] as (typeof nodes)[number];
      const one = textWidth(n.label, L.nodeFont) + 2 * L.nodePadX;
      const w = Math.min(boxMax, Math.max(Math.min(boxMax, 64), Math.ceil(one)));
      it.w = w;
      const ls = wrapText(n.label, w - 2 * L.nodePadX, L.nodeFont, L.nodeMaxLines);
      lines.set(it.node, ls);
      heights.set(it.node, ls.length * L.nodeLine + 2 * L.nodePadY);
    }
    const gapBefore = (i: number) =>
      i === 0 ? 0 : (row[i]?.node ?? -1) >= 0 && (row[i - 1]?.node ?? -1) >= 0 ? L.gapX : L.laneGap;
    const total = row.reduce((sum, it, i) => sum + gapBefore(i) + it.w, 0);
    widest = Math.max(widest, total);
    let x = L.pad + Math.max(0, (avail - total) / 2);
    row.forEach((it, i) => {
      x += gapBefore(i);
      it.x = x;
      x += it.w;
    });
  }
  // A pathological rank (many lanes on a narrow screen) may need more room: the diagram scrolls inside its frame.
  const W = Math.max(width, Math.ceil(widest + 2 * L.pad));
  // Attach points: edges leave a node's bottom and enter its top spread in the order of their other ends.
  const centre = (it: Item) => it.x + it.w / 2;
  const firstAfter = (ei: number): Item => (chains[ei]?.[0] ?? realItem.get(links[ei]?.v ?? -1)) as Item;
  const lastBefore = (ei: number): Item => {
    const c = chains[ei] ?? [];
    return (c[c.length - 1] ?? realItem.get(links[ei]?.u ?? -1)) as Item;
  };
  const outAt = new Map<number, number>();
  const inAt = new Map<number, number>();
  nodes.forEach((_, i) => {
    const it = realItem.get(i) as Item;
    const outs = links.map((l, ei) => ({ l, ei })).filter(({ l }) => l.u === i);
    outs.sort((a, b) => centre(firstAfter(a.ei)) - centre(firstAfter(b.ei)));
    outs.forEach(({ ei }, k) => {
      outAt.set(ei, it.x + (it.w * (k + 1)) / (outs.length + 1));
    });
    const ins = links.map((l, ei) => ({ l, ei })).filter(({ l }) => l.v === i);
    ins.sort((a, b) => centre(lastBefore(a.ei)) - centre(lastBefore(b.ei)));
    ins.forEach(({ ei }, k) => {
      inAt.set(ei, it.x + (it.w * (k + 1)) / (ins.length + 1));
    });
  });
  // Edge labels belong to the band below the edge's upper end; in a band they are stacked into rows.
  type LabelBox = { ei: number; lines: string[]; w: number; h: number; cx: number; row: number };
  const bandLabels: LabelBox[][] = Array.from({ length: maxRank }, () => []);
  links.forEach((l, ei) => {
    if (!l.label) return;
    const maxW = Math.min(L.edgeMaxW, avail * 0.6);
    const ls = wrapText(l.label, maxW - 2 * L.edgePadX, L.edgeFont, L.edgeMaxLines);
    const w = Math.ceil(Math.max(...ls.map((s) => textWidth(s, L.edgeFont)))) + 2 * L.edgePadX;
    const h = ls.length * L.edgeLine + 2 * L.edgePadY;
    const x1 = outAt.get(ei) ?? 0;
    const x2 = chains[ei]?.[0] ? centre(chains[ei]?.[0] as Item) : (inAt.get(ei) ?? 0);
    const cx = Math.min(W - L.pad - w / 2, Math.max(L.pad + w / 2, (x1 + x2) / 2));
    bandLabels[rank[l.u] ?? 0]?.push({ ei, lines: ls, w, h, cx, row: 0 });
  });
  const bandRows: number[][] = []; // per band: heights of label rows
  bandLabels.forEach((labels, b) => {
    labels.sort((p, q) => p.cx - q.cx || p.ei - q.ei);
    const rows: { l: number; r: number }[][] = [];
    const rowH: number[] = [];
    for (const lb of labels) {
      const l = lb.cx - lb.w / 2 - L.labelGap / 2;
      const r = lb.cx + lb.w / 2 + L.labelGap / 2;
      let row = rows.findIndex((occ) => occ.every((o) => r <= o.l || l >= o.r));
      if (row < 0) {
        row = rows.length;
        rows.push([]);
        rowH.push(0);
      }
      rows[row]?.push({ l, r });
      rowH[row] = Math.max(rowH[row] ?? 0, lb.h);
      lb.row = row;
    }
    bandRows[b] = rowH;
  });
  // y of the ranks and bands.
  const rowTop: number[] = [];
  const rowH: number[] = [];
  const bandTop: number[] = [];
  let y = L.pad;
  for (let r = 0; r <= maxRank; r++) {
    rowTop[r] = y;
    const h = Math.max(
      0,
      ...(ranks[r] ?? []).filter((it) => it.node >= 0).map((it) => heights.get(it.node) ?? 0),
    );
    rowH[r] = h;
    y += h;
    if (r < maxRank) {
      bandTop[r] = y;
      const rows = bandRows[r] ?? [];
      const labels = rows.reduce((s, h2) => s + h2, 0) + Math.max(0, rows.length - 1) * L.labelGap;
      y += Math.max(L.bandMin, labels + 2 * L.bandPad);
    }
  }
  const height = Math.ceil(y + L.pad);
  const laid: LaidNode[] = nodes.map((n, i) => {
    const it = realItem.get(i) as Item;
    const h = heights.get(i) ?? 0;
    const top = (rowTop[it.rank] ?? 0) + ((rowH[it.rank] ?? 0) - h) / 2;
    return {
      id: n.id,
      label: n.label,
      kind: n.kind,
      lines: lines.get(i) ?? [],
      x: round(it.x),
      y: round(top),
      w: round(it.w),
      h,
    };
  });
  const box = (i: number) => laid[i] as LaidNode;
  const edges: LaidEdge[] = links.map((l, ei) => {
    const lb = bandLabels[rank[l.u] ?? 0]?.find((b) => b.ei === ei);
    const start = { x: outAt.get(ei) ?? 0, y: box(l.u).y + box(l.u).h };
    const end = { x: inAt.get(ei) ?? 0, y: box(l.v).y };
    // Points: start → down to the bottom of its rank → (label) → each lane through its rank → the top of the
    // target's rank → end. Curves stay in the bands, so a line never crosses a taller neighbour of its node.
    const pts: { x: number; y: number; straight?: boolean }[] = [start];
    const bottom = (rowTop[rank[l.u] ?? 0] ?? 0) + (rowH[rank[l.u] ?? 0] ?? 0);
    if (bottom - start.y > 0.5) pts.push({ x: start.x, y: bottom, straight: true });
    let label = { lx: 0, ly: 0, lw: 0, lh: 0 };
    if (lb) {
      const rows = bandRows[rank[l.u] ?? 0] ?? [];
      const above = rows.slice(0, lb.row).reduce((s, h2) => s + h2 + L.labelGap, 0);
      const rowsH = rows.reduce((s, h2) => s + h2, 0) + Math.max(0, rows.length - 1) * L.labelGap;
      const bandH = Math.max(L.bandMin, rowsH + 2 * L.bandPad);
      const top = (bandTop[rank[l.u] ?? 0] ?? 0) + (bandH - rowsH) / 2 + above;
      const cy = top + (rows[lb.row] ?? lb.h) / 2;
      label = { lx: round(lb.cx - lb.w / 2), ly: round(cy - lb.h / 2), lw: lb.w, lh: lb.h };
      pts.push({ x: lb.cx, y: cy });
    }
    for (const lane of chains[ei] ?? []) {
      const cx = centre(lane);
      pts.push({ x: cx, y: rowTop[lane.rank] ?? 0 });
      pts.push({ x: cx, y: (rowTop[lane.rank] ?? 0) + (rowH[lane.rank] ?? 0), straight: true });
    }
    const entry = rowTop[rank[l.v] ?? 0] ?? 0;
    if (end.y - entry > 0.5) pts.push({ x: end.x, y: entry });
    pts.push({ ...end, straight: end.y - entry > 0.5 });
    let d = `M${round(start.x)} ${round(start.y)}`;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1] as { x: number; y: number };
      const b = pts[i] as { x: number; y: number; straight?: boolean };
      if (b.straight) d += `L${round(b.x)} ${round(b.y)}`;
      else {
        const k = (b.y - a.y) / 2;
        d += `C${round(a.x)} ${round(a.y + k)} ${round(b.x)} ${round(b.y - k)} ${round(b.x)} ${round(b.y)}`;
      }
    }
    return {
      from: l.from,
      to: l.to,
      label: l.label,
      lines: lb?.lines ?? [],
      d,
      ...label,
      reversed: l.reversed,
    };
  });
  return { width: W, height, nodes: laid, edges };
}

/** Pairs of boxes that overlap (more than `tolerance` px both ways) — empty for every layout; used by the tests. */
export function overlaps(
  boxes: readonly { id: string; x: number; y: number; w: number; h: number }[],
  tolerance = 0.5,
): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i] as (typeof boxes)[number];
      const b = boxes[j] as (typeof boxes)[number];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > tolerance && oy > tolerance) out.push([a.id, b.id]);
    }
  return out;
}
