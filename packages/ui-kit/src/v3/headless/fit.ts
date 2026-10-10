// useFitWords (V3-18): a display heading never breaks inside a word. Russian titles carry long words («Стоматологическая»,
// «Екатеринбурге») that at the first screen's size do not fit a phone line; overflow-wrap then cuts them mid-word, and
// hyphenation needs a dictionary the browser may not have. The hook measures the widest word of the heading with its
// own font and, when it is wider than the heading's box, lowers the font size just enough — before the paint (no layout
// shift), again when the box width changes and once the fonts are ready (never larger at the same width). fitWords is
// the CSS-only counterpart for a brand in a header (design/css.ts FIT_WORDS_CSS): no measuring, sized by the face.
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The size (px) at which the widest word of `el` fits its box, or null when it already fits. */
function fittedSize(el: HTMLElement, ctx: CanvasRenderingContext2D): number | null {
  const cs = getComputedStyle(el);
  const size = Number.parseFloat(cs.fontSize);
  const box = el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
  if (!(size > 0) || !(box > 0)) return null;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing;
  const upper = cs.textTransform === "uppercase";
  let widest = 0;
  for (const w of (el.textContent ?? "").split(/\s+/))
    if (w) widest = Math.max(widest, ctx.measureText(upper ? w.toUpperCase() : w).width);
  if (widest <= box) return null;
  // A hair under the exact ratio: glyph overhangs and rounding.
  return Math.floor(((size * box) / widest) * 0.98 * 10) / 10;
}

/** Ref of a display heading whose words each stay on one line (the size goes down only as much as needed). */
export function useFitWords<T extends HTMLElement>(text: string): RefObject<T | null> {
  const ref = useRef<T>(null);
  useBeforePaint(() => {
    const el = ref.current;
    if (!el || typeof document === "undefined") return;
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return;
    let width = -1;
    let applied: number | null = null;
    let alive = true;
    // A later fit at the same width never makes the heading larger again (a measure with a font still loading is
    // narrower): the size only follows a new width (rotation, resize) up.
    const fit = () => {
      const w = el.clientWidth;
      el.style.fontSize = "";
      const size = fittedSize(el, ctx);
      const next =
        w === width && applied !== null ? (size === null ? applied : Math.min(size, applied)) : size;
      width = w;
      applied = next;
      if (next !== null) el.style.fontSize = `${next}px`;
    };
    fit();
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (el.clientWidth !== width) fit();
          });
    resize?.observe(el);
    // The design fonts may finish after the first fit: one more fit with them.
    document.fonts?.ready.then(() => {
      if (alive) fit();
    });
    return () => {
      alive = false;
      resize?.disconnect();
    };
  }, [text]);
  return ref;
}

/** Longest word the fit rules of the design CSS know: data-fit-words takes 1…30 (design/css.ts FIT_WORDS_MAX). */
export const FIT_WORDS_MAX = 30;

/** A word of a display line and its offset in the line (a stable key: words may repeat). */
export interface FitWord {
  at: number;
  text: string;
}

/**
 * fitWords(line) — the words of a display line (a brand from the brief) and the letter count of its longest word for
 * data-fit-words (capped at FIT_WORDS_MAX): the design CSS sizes the line on a phone so that word stays whole (no JS
 * measuring, no layout shift); the pattern sets each word as one unit, wrapped only between words.
 */
export function fitWords(line: string): { words: FitWord[]; chars: number } {
  const words: FitWord[] = [];
  let longest = 1;
  for (const m of line.trim().matchAll(/\S+/g)) {
    words.push({ at: m.index ?? 0, text: m[0] });
    longest = Math.max(longest, [...m[0]].length);
  }
  return { words, chars: Math.min(longest, FIT_WORDS_MAX) };
}
