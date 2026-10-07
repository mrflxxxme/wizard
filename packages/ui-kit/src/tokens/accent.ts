// Accent shades with a guaranteed contrast (ui-kit.yaml#tokens): text on the fill, the accent as text, hover fill.
// Shared by the --w-* tokens of systems, their cabinet look (cabinet.ts) and the platform v2 business colour.
import { contrast, hexToOklch, oklchToHex } from "./color.js";

type Scheme = "light" | "dark";

const INK_LIGHT = "#FFFFFF";
const INK_DARK = "#111318";
const MIN_CONTRAST = 4.5;

/** Text on the accent fill: the better of white and #111318; pure black when neither reaches 4.5:1. */
export function accentInk(accent: string): string {
  const best = contrast(INK_LIGHT, accent) >= contrast(INK_DARK, accent) ? INK_LIGHT : INK_DARK;
  return contrast(best, accent) >= MIN_CONTRAST ? best : "#000000";
}

/** Accent for text: step OKLCH lightness away from the backgrounds until contrast ≥ 4.5 with all of them. */
export function accentText(accent: string, scheme: Scheme, backgrounds: readonly string[]): string {
  const ok = (c: string) => backgrounds.every((b) => contrast(c, b) >= MIN_CONTRAST);
  if (ok(accent)) return accent;
  const base = hexToOklch(accent);
  const dir = scheme === "light" ? -1 : 1;
  for (let l = base.l; l >= 0 && l <= 1; l += dir * 0.01) {
    const c = oklchToHex({ ...base, l });
    if (ok(c)) return c;
  }
  return scheme === "light" ? "#000000" : "#FFFFFF";
}

/** Hover/pressed fill: the accent moved away from its ink, so contrast with --w-accent-ink only grows. */
export function accentStrong(accent: string): string {
  const ink = accentInk(accent);
  const base = hexToOklch(accent);
  const dir = ink === INK_LIGHT ? -1 : 1;
  const c = oklchToHex({ ...base, l: Math.min(1, Math.max(0, base.l + dir * 0.07)) });
  return contrast(ink, c) >= contrast(ink, accent) ? c : accent;
}
