// Similarity of two site fingerprints for the template gate (V3-14, D77_v3 (6)) and the verdict against the memory of
// recent sites. Per page three components, each 0…1:
//   structure — the section sequences aligned (same pattern 1, same type and layout family 0.6, same type 0.3);
//   dom       — the rendered section shapes aligned (height, columns, depth, media, text, controls, centring);
//   visual    — perceptual hashes of the first screen and the full page (pHash polarity-invariant, dHash as is).
// A page scores Σ weight × component over the components both sides have; the site — the pages of the current site
// matched by route (the home page counts twice, a page the other site lacks scores 0).
// Thresholds were calibrated on generated near-duplicates (same sections and variants; other texts, palette, fonts,
// spacing) against genuinely different sites of the same niche (other variants of the same section types):
// packages/gates/test/template-similarity.test.ts and apps/platform-api/test/v3-template-gate.browser.test.ts.

import type {
  PageFingerprint,
  PageView,
  SectionShape,
  SectionToken,
  SiteFingerprint,
  TemplateViewportId,
} from "./fingerprint.js";
import { hashSimilarity } from "./image.js";

/** Weights of the page components (renormalised over the components both pages have). */
export const TEMPLATE_WEIGHTS = { structure: 0.4, dom: 0.25, visual: 0.35 } as const;

/** Weights of the four hashes of a view. */
export const VISUAL_WEIGHTS = { firstP: 0.35, firstD: 0.15, fullP: 0.35, fullD: 0.15 } as const;

/**
 * At or above this similarity (structure + DOM + hashes) a site is a near-duplicate of a recent one. Calibration in
 * chromium (8-section pages of one niche, 4 bases): copies with other texts, palette, fonts and spacing score
 * 0.83–0.92, dark copies 0.75–0.79; a site with half of the sections in other variants 0.52–0.62; every section in
 * another variant 0.28–0.37. A site with 7 of 8 sections repeated lands at 0.72–0.81 (a copy too), 6 of 8 at 0.66–0.75.
 */
export const TEMPLATE_THRESHOLD = 0.7;

/**
 * The threshold when either side has no rendered views (no browser): structure alone. A copy scores 1, one section of
 * eight in another pattern 0.91, two 0.83, half 0.65, every section 0.3 (section types only) — over the threshold
 * ≈ 85 % of the sections repeat the recent site's patterns.
 */
export const TEMPLATE_STRUCTURE_THRESHOLD = 0.85;

/** Aligned DOM shapes of unrelated sites score about this much; the DOM component counts from it (0) to 1. */
export const DOM_BASELINE = 0.5;

/** Weight of the home page in the site score (other pages weigh 1). */
export const HOME_WEIGHT = 2;

/** Similarity of two section tokens. */
export function tokenSimilarity(a: SectionToken, b: SectionToken): number {
  if (a.type !== b.type) return 0;
  // Signature sections are free code: two of them never count as one pattern.
  if (a.type === "signature") return 0.3;
  if (a.variant && a.variant === b.variant) return 1;
  if (a.layout && a.layout === b.layout) return 0.6;
  return 0.3;
}

/**
 * Best non-crossing alignment of two sequences (an LCS with weighted matches; gaps score 0), divided by the longer
 * length: 1 — the same sequence, 0 — nothing in common. Two empty sequences are the same.
 */
export function alignment<T>(a: readonly T[], b: readonly T[], score: (x: T, y: T) => number): number {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return 1;
  if (n === 0 || m === 0) return 0;
  let prev = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  for (let i = 1; i <= n; i++) {
    cur[0] = 0;
    for (let j = 1; j <= m; j++) {
      const diag = (prev[j - 1] as number) + score(a[i - 1] as T, b[j - 1] as T);
      cur[j] = Math.max(prev[j] as number, cur[j - 1] as number, diag);
    }
    [prev, cur] = [cur, prev];
  }
  return (prev[m] as number) / Math.max(n, m);
}

const rel = (x: number, y: number, floor: number) =>
  Math.min(1, Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), floor));
const lg = (x: number) => Math.log2(1 + Math.max(0, x));

/** Similarity of two rendered section shapes, 0…1. */
export function shapeSimilarity(a: SectionShape, b: SectionShape): number {
  const diff =
    0.25 * rel(a.h, b.h, 0.2) +
    0.2 * (a.cols === b.cols ? 0 : rel(a.cols, b.cols, 1)) +
    0.1 * rel(a.depth, b.depth, 1) +
    0.15 * rel(a.media, b.media, 1) +
    0.15 * rel(lg(a.text), lg(b.text), 1) +
    0.05 * rel(lg(a.controls), lg(b.controls), 1) +
    0.1 * (a.center === b.center ? 0 : 1);
  return Math.max(0, 1 - diff);
}

/** Similarity of the four hashes of two views of a page. */
export function viewVisualSimilarity(a: PageView, b: PageView): number {
  return (
    VISUAL_WEIGHTS.firstP * hashSimilarity(a.first.p, b.first.p, true) +
    VISUAL_WEIGHTS.firstD * hashSimilarity(a.first.d, b.first.d) +
    VISUAL_WEIGHTS.fullP * hashSimilarity(a.full.p, b.full.p, true) +
    VISUAL_WEIGHTS.fullD * hashSimilarity(a.full.d, b.full.d)
  );
}

export interface PageSimilarity {
  score: number;
  structure: number;
  /** null — no viewport rendered on both sides. */
  dom: number | null;
  visual: number | null;
}

/** Similarity of two pages: structure always, DOM and hashes over the viewports both rendered. */
export function pageSimilarity(a: PageFingerprint, b: PageFingerprint): PageSimilarity {
  const structure = alignment(a.sections, b.sections, tokenSimilarity);
  const doms: number[] = [];
  const visuals: number[] = [];
  for (const id of Object.keys(a.views ?? {}) as TemplateViewportId[]) {
    const va = a.views?.[id];
    const vb = b.views?.[id];
    if (!va || !vb) continue;
    doms.push(alignment(va.shapes, vb.shapes, shapeSimilarity));
    visuals.push(viewVisualSimilarity(va, vb));
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  // Any two pages share much of their DOM shape (one column on phones, a heading and a text per section): the
  // aligned shapes of unrelated sites score ≈ DOM_BASELINE, so the component is rescaled to start there.
  const domRaw = mean(doms);
  const dom = domRaw === null ? null : Math.max(0, (domRaw - DOM_BASELINE) / (1 - DOM_BASELINE));
  const visual = mean(visuals);
  let sum = TEMPLATE_WEIGHTS.structure * structure;
  let weight = TEMPLATE_WEIGHTS.structure;
  if (dom !== null) {
    sum += TEMPLATE_WEIGHTS.dom * dom;
    weight += TEMPLATE_WEIGHTS.dom;
  }
  if (visual !== null) {
    sum += TEMPLATE_WEIGHTS.visual * visual;
    weight += TEMPLATE_WEIGHTS.visual;
  }
  return { score: sum / weight, structure, dom, visual };
}

export interface SiteSimilarity {
  /** 0…1: how much of the current site repeats the other one. */
  score: number;
  /** full — at least one page compared with its rendered views; structure — structure only. */
  mode: "full" | "structure";
  pages: { route: string; similarity: PageSimilarity | null }[];
}

/**
 * How much of site `current` repeats site `other`: the pages of `current` matched by route (the home page weighs
 * HOME_WEIGHT, a page `other` lacks scores 0). Not symmetric on purpose — the question is whether the new site is a
 * copy, and a copy with an extra page is still mostly a copy.
 */
export function siteSimilarity(current: SiteFingerprint, other: SiteFingerprint): SiteSimilarity {
  const byRoute = new Map(other.pages.map((p) => [p.route, p]));
  let sum = 0;
  let weight = 0;
  let full = false;
  const pages: SiteSimilarity["pages"] = [];
  for (const p of current.pages) {
    const w = p.route === "/" ? HOME_WEIGHT : 1;
    weight += w;
    const q = byRoute.get(p.route);
    const sim = q ? pageSimilarity(p, q) : null;
    if (sim) {
      sum += w * sim.score;
      if (sim.dom !== null) full = true;
    }
    pages.push({ route: p.route, similarity: sim });
  }
  return { score: weight ? sum / weight : 0, mode: full ? "full" : "structure", pages };
}

/** The threshold of a comparison by its mode. */
export const thresholdOf = (
  mode: SiteSimilarity["mode"],
  o: { threshold?: number; structureThreshold?: number } = {},
): number =>
  mode === "full"
    ? (o.threshold ?? TEMPLATE_THRESHOLD)
    : (o.structureThreshold ?? TEMPLATE_STRUCTURE_THRESHOLD);

/** A recent site of the memory: its id (system), archetype and fingerprint. */
export interface TemplateMemoryItem {
  id: string;
  archetype: string;
  fingerprint: SiteFingerprint;
}

export interface TemplateMatch {
  id: string;
  archetype: string;
  score: number;
  mode: SiteSimilarity["mode"];
}

export interface TemplateVerdict {
  /** At least one recent site at or above its threshold. */
  over: boolean;
  /** The most similar recent site (null — empty memory). */
  nearest: TemplateMatch | null;
  /** Recent sites at or above the threshold, most similar first. */
  matches: TemplateMatch[];
}

/** The verdict of the template gate: the current site against the recent sites of the memory. */
export function templateVerdict(
  current: SiteFingerprint,
  memory: readonly TemplateMemoryItem[],
  o: { threshold?: number; structureThreshold?: number } = {},
): TemplateVerdict {
  const all = memory
    .map((m) => {
      const s = siteSimilarity(current, m.fingerprint);
      return { id: m.id, archetype: m.archetype, score: s.score, mode: s.mode };
    })
    .sort((a, b) => b.score - a.score);
  const matches = all.filter((m) => m.score >= thresholdOf(m.mode, o));
  return { over: matches.length > 0, nearest: all[0] ?? null, matches };
}
