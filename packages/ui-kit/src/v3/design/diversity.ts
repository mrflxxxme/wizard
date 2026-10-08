// Diversity of design systems (V3-07 acceptance 3, D77 (16) «разнообразие»): a distance between two systems over
// the archetype and the tokens, and the summary over a set of briefs. A token-level metric; the screenshot metric of
// the template gate (V3-14) comes on top of it.
import { hexToOklch } from "../../tokens/color.js";
import { cssHex } from "./palette.js";
import type { DesignSystemV3 } from "./system.js";

const lab = (css: string) => {
  const o = hexToOklch(cssHex(css));
  return [o.l, o.c * Math.cos(o.h), o.c * Math.sin(o.h)] as const;
};
const deltaE = (a: string, b: string) => {
  const x = lab(a);
  const y = lab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

/** The combination two systems must not share: archetype, font pair, accent, scale, radius, density, motion. */
export function designKey(ds: DesignSystemV3): string {
  return [
    ds.archetype,
    ds.fonts.display.family,
    ds.fonts.text.family,
    cssHex(ds.palette.light.accent),
    ds.type.scale,
    ds.radius.set,
    ds.grid.rhythm.density,
    ds.motion.profile,
  ].join("|");
}

/**
 * Distance 0…1: the mean of twelve parts — archetype, display font, text font, accent colour (OKLab ΔE / 0.2, capped),
 * page colour (ΔE / 0.05), type scale, radius set, density, grid layout, motion profile, image treatment, scheme.
 */
export function designDistance(a: DesignSystemV3, b: DesignSystemV3): number {
  const parts = [
    a.archetype !== b.archetype,
    a.fonts.display.family !== b.fonts.display.family,
    a.fonts.text.family !== b.fonts.text.family,
    Math.min(1, deltaE(a.palette.light.accent, b.palette.light.accent) / 0.2),
    Math.min(1, deltaE(a.palette.light.bg, b.palette.light.bg) / 0.05),
    a.type.scale !== b.type.scale,
    a.radius.set !== b.radius.set,
    a.grid.rhythm.density !== b.grid.rhythm.density,
    a.grid.layout !== b.grid.layout,
    a.motion.profile !== b.motion.profile,
    a.imagery.treatment !== b.imagery.treatment,
    a.palette.scheme !== b.palette.scheme,
  ].map(Number);
  return Math.round((parts.reduce((s, x) => s + x, 0) / parts.length) * 1000) / 1000;
}

export interface DesignDiversity {
  count: number;
  /** Different archetypes. */
  archetypes: number;
  /** Different font pairs. */
  fontPairs: number;
  /** Different designKey combinations; comboShare = uniqueCombos / count (1 — no two systems alike). */
  uniqueCombos: number;
  comboShare: number;
  minDistance: number;
  meanDistance: number;
  /** The closest pair (indexes in the list). */
  closest: [number, number] | null;
}

export function designDiversity(list: readonly DesignSystemV3[]): DesignDiversity {
  const round = (x: number) => Math.round(x * 1000) / 1000;
  let min = Number.POSITIVE_INFINITY;
  let closest: [number, number] | null = null;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const d = designDistance(list[i] as DesignSystemV3, list[j] as DesignSystemV3);
      sum += d;
      n += 1;
      if (d < min) {
        min = d;
        closest = [i, j];
      }
    }
  const unique = new Set(list.map(designKey)).size;
  return {
    count: list.length,
    archetypes: new Set(list.map((d) => d.archetype)).size,
    fontPairs: new Set(list.map((d) => `${d.fonts.display.family}+${d.fonts.text.family}`)).size,
    uniqueCombos: unique,
    comboShare: list.length ? round(unique / list.length) : 0,
    minDistance: n ? min : 0,
    meanDistance: n ? round(sum / n) : 0,
    closest,
  };
}
