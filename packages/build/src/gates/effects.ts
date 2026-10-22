// Effects gate (V5-05, product.yaml#decisions.D80_v5 (4)): one heavy effect per page, ≤ 40 KB gzip JS per effect,
// a still fallback under prefers-reduced-motion, Lighthouse mobile perf ≥ 85 and LCP ≤ 2.5 s on 4G.
// Weight and reduced-motion are static checks; Lighthouse (Apache-2.0, CI devDependency) reports are passed in.
import { gzipSync } from "node:zlib";

export const EFFECT_JS_LIMIT = 40 * 1024;
export const HEAVY_EFFECTS_PER_PAGE = 1;
export const LIGHTHOUSE_PERF_MIN = 85;
export const LCP_MAX_MS = 2500;

export type EffectKind = "heavy" | "light";

/** One effect on a page: its JS source, CSS and weight class. */
export type EffectInput = { id: string; kind: EffectKind; js: string; css?: string };
export type PageEffects = { page: string; effects: readonly EffectInput[] };
/** The part of a Lighthouse mobile report the gate reads (perf score 0..1, LCP in ms). */
export type LighthouseSummary = { performance: number; lcpMs: number };

export type EffectsViolation = {
  code: "heavy-count" | "js-weight" | "reduced-motion" | "lighthouse-perf" | "lighthouse-lcp";
  page: string;
  effect?: string;
  message: string;
};
export type EffectsReport = { ok: boolean; violations: EffectsViolation[] };

/** Gzip size of an effect's JS in bytes. */
export const gzipBytes = (js: string): number => gzipSync(js).length;

const MOTION =
  /\b(?:requestAnimationFrame|animate|motion|useScroll|useTransform|WebGL|getContext)\b|@keyframes|animation\s*:|transition\s*:/;
const REDUCED = /prefers-reduced-motion|useStill|useReducedMotion|stillFrame/;

/** True when an effect that moves also has a branch for prefers-reduced-motion (media query, hook or still helper). */
export const hasReducedMotionFallback = (e: EffectInput): boolean => {
  const src = `${e.js}\n${e.css ?? ""}`;
  return !MOTION.test(src) || REDUCED.test(src);
};

/** Checks every page; `lighthouse` maps page → mobile report and is optional (absent outside CI). */
export function checkEffects(
  pages: readonly PageEffects[],
  lighthouse: Readonly<Record<string, LighthouseSummary>> = {},
): EffectsReport {
  const violations: EffectsViolation[] = [];
  for (const { page, effects } of pages) {
    const heavy = effects.filter((e) => e.kind === "heavy");
    if (heavy.length > HEAVY_EFFECTS_PER_PAGE)
      violations.push({
        code: "heavy-count",
        page,
        message: `${page}: тяжёлых эффектов ${heavy.length}, допустим ${HEAVY_EFFECTS_PER_PAGE} (${heavy.map((e) => e.id).join(", ")})`,
      });
    for (const e of effects) {
      const size = gzipBytes(e.js);
      if (size > EFFECT_JS_LIMIT)
        violations.push({
          code: "js-weight",
          page,
          effect: e.id,
          message: `${page}: эффект ${e.id} весит ${size} Б gzip, лимит ${EFFECT_JS_LIMIT} Б`,
        });
      if (!hasReducedMotionFallback(e))
        violations.push({
          code: "reduced-motion",
          page,
          effect: e.id,
          message: `${page}: у эффекта ${e.id} нет статичного кадра при prefers-reduced-motion`,
        });
    }
    const lh = lighthouse[page];
    if (lh) {
      if (lh.performance * 100 < LIGHTHOUSE_PERF_MIN)
        violations.push({
          code: "lighthouse-perf",
          page,
          message: `${page}: Lighthouse mobile ${Math.round(lh.performance * 100)} < ${LIGHTHOUSE_PERF_MIN}`,
        });
      if (lh.lcpMs > LCP_MAX_MS)
        violations.push({
          code: "lighthouse-lcp",
          page,
          message: `${page}: LCP ${Math.round(lh.lcpMs)} мс > ${LCP_MAX_MS} мс`,
        });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Reads performance and LCP from a Lighthouse JSON report (lhr). */
export function summarizeLighthouse(lhr: {
  categories: { performance: { score: number | null } };
  audits: { "largest-contentful-paint": { numericValue?: number } };
}): LighthouseSummary {
  return {
    performance: lhr.categories.performance.score ?? 0,
    lcpMs: lhr.audits["largest-contentful-paint"].numericValue ?? Number.POSITIVE_INFINITY,
  };
}
