// Palette of the v3 design system: OKLCH from one brand colour (or from the archetype's hues when there is none) by the
// archetype's palette rules. Pure code, no model. Contrast is kept by construction (WCAG 2.x, tokens/color.ts), the
// accent shades reuse tokens/accent.ts; designLint (lint.ts) checks the result independently. Every value is an
// `oklch()` string; its sRGB hex (`cssHex`) is what contrast is measured on, so CSS and checks never disagree.
import { accentInk, accentStrong, accentText } from "../../tokens/accent.js";
import { blend, contrast, hexToOklch, hexToRgb, type Oklch, oklchToHex } from "../../tokens/color.js";
import { PALETTE } from "../../tokens/tokens.js";
import type { AccentUse, PaletteRules } from "./archetypes.js";
import { pick, rng, within } from "./random.js";

export const COLOR_ROLES = [
  "bg",
  "surface",
  "surfaceAlt",
  "ink",
  "muted",
  "line",
  "border",
  "accent",
  "accentInk",
  "accentText",
  "accentStrong",
  "accentSoft",
  "accentEdge",
  "accent2",
  "accent2Ink",
  "focus",
  "ok",
  "warn",
  "bad",
  "overlay",
  "overlayInk",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
/** Colours of one scheme as CSS `oklch()` strings (overlay carries an alpha). */
export type PaletteScheme = Record<ColorRole, string>;
export type SchemeName = "light" | "dark";

export interface PaletteV3 {
  /** brand — the accent is the client's colour (kept as is in the light scheme); archetype — picked by the seed. */
  source: "brand" | "archetype";
  brandColor?: string;
  /** Scheme the page starts in (the other one is complete too). */
  scheme: SchemeName;
  accentUse: AccentUse;
  light: PaletteScheme;
  dark: PaletteScheme;
}

const DEG = Math.PI / 180;
const MIN_TEXT = 4.5;
const MIN_NON_TEXT = 3;
/** Opacity of the scrim under text on photos (catalog I04). */
export const OVERLAY_ALPHA = 0.62;

const hueDeg = (o: Oklch) => (((o.h / DEG) % 360) + 360) % 360;
/** Decimals of L, C and H: the shortest that renders the same hex (a brand colour stays exactly itself). */
const PRECISION = [
  [3, 3, 1],
  [4, 4, 2],
  [5, 5, 3],
  [6, 6, 4],
] as const;

/** `oklch(L C H)` of a hex colour with the shortest exact precision (achromatic → hue 0). */
export function oklchCss(hex: string, alpha?: number): string {
  const o = hexToOklch(hex);
  const target = hex.toUpperCase();
  const a = alpha === undefined ? "" : ` / ${alpha}`;
  let out = "";
  for (const [dl, dc, dh] of PRECISION) {
    const c = o.c < 1e-5 ? 0 : o.c;
    const h = c === 0 ? 0 : hueDeg(o);
    out = `oklch(${o.l.toFixed(dl)} ${c.toFixed(dc)} ${h.toFixed(dh)}${a})`;
    if (cssHex(out) === target) return out;
  }
  return out;
}

const OKLCH_RE = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/;

/** Parsed `oklch()` string: lightness, chroma, hue in degrees and alpha (1 when absent); null when malformed. */
export function parseOklch(css: string): { l: number; c: number; h: number; alpha: number } | null {
  const m = OKLCH_RE.exec(css.trim());
  if (!m) return null;
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]), alpha: m[4] === undefined ? 1 : Number(m[4]) };
}

/** sRGB hex of an `oklch()` string (alpha ignored), gamut-mapped by chroma like oklchToHex. */
export function cssHex(css: string): string {
  const p = parseOklch(css);
  if (!p) throw new Error(`Bad oklch colour: ${css}`);
  return oklchToHex({ l: p.l, c: p.c, h: p.h * DEG });
}

/** The hex the `oklch()` string of `hex` renders as (fixpoint of hex → oklch string → hex). */
export function quantize(hex: string): string {
  let h = hex.toUpperCase();
  for (let i = 0; i < 4; i++) {
    const n = cssHex(oklchCss(h));
    if (n === h) return h;
    h = n;
  }
  return h;
}

const fromLch = (l: number, c: number, hDeg: number) =>
  quantize(oklchToHex({ l: Math.min(1, Math.max(0, l)), c: Math.max(0, c), h: hDeg * DEG }));

/** Catalog C02: a cream page (min(R,G,B) ≥ 209, R ≥ G ≥ B, 6 ≤ R−B ≤ 48). */
export function isCream(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex).map((x) => Math.round(x * 255)) as [number, number, number];
  return Math.min(r, g, b) >= 209 && r >= g && g >= b && r - b >= 6 && r - b <= 48;
}

/**
 * `hex` with its OKLCH lightness stepped away from the backgrounds until contrast ≥ `min` with all of them (the
 * quantized hex the CSS renders). Starts from accentText (tokens/accent.ts) for text contrast.
 */
export function stepToContrast(
  hex: string,
  backgrounds: readonly string[],
  min: number,
  scheme: SchemeName,
): string {
  const ok = (c: string) => backgrounds.every((b) => contrast(c, b) >= min);
  let start = quantize(hex);
  if (ok(start)) return start;
  if (min === MIN_TEXT) start = quantize(accentText(start, scheme, backgrounds));
  if (ok(start)) return start;
  const base = hexToOklch(start);
  const dir = scheme === "light" ? -1 : 1;
  for (let l = base.l; l >= 0 && l <= 1; l += dir * 0.005) {
    const c = fromLch(l, base.c, hueDeg(base));
    if (ok(c)) return c;
  }
  return scheme === "light" ? fromLch(0.12, 0, 0) : "#FFFFFF";
}

/** Normalised brand colour (#RRGGBB upper case) or undefined when absent or malformed. */
export function normalizeBrand(color: string | undefined | null): string | undefined {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : undefined;
}

/** Accent of the archetype when the client has no brand colour: a hue of the rules, lightness and chroma in range. */
function archetypeAccent(rules: PaletteRules, seed: string, key: string): string {
  const r = rng(seed, `${key}:accent`);
  const hue = pick(rules.hues, r) + (r() * 2 - 1) * 6;
  return fromLch(within(rules.accentL, r), within(rules.accentC, r), hue);
}

/** Hue band of the «AI palette» (catalog C01): violet 260–310°. */
export const isAiViolet = (hDeg: number, c: number) => c >= 0.06 && hDeg >= 260 && hDeg <= 310;

function secondAccent(
  rules: PaletteRules,
  fill: string,
  fallback: string,
  source: PaletteV3["source"],
  seed: string,
  key: string,
): string {
  if (rules.accent2 === "none") return fill;
  const base = hexToOklch(fill);
  const grey = base.c < 0.03;
  const o = grey ? hexToOklch(fallback) : base;
  const r = rng(seed, `${key}:accent2`);
  const sign = r() < 0.5 ? -1 : 1;
  const shift = rules.accent2 === "analogous" ? 32 * sign : rules.accent2 === "complement" ? 180 : 150 * sign;
  let h = (((hueDeg(o) + shift) % 360) + 360) % 360;
  const c = Math.min(o.c, 0.17) * 0.9;
  // The system never picks the violet of the «AI palette» itself (a violet brand colour stays the client's choice).
  if (source !== "brand" || grey) if (isAiViolet(h, c)) h = h - 260 < 310 - h ? 250 : 320;
  return fromLch(o.l, c, h);
}

interface SchemeOpts {
  rules: PaletteRules;
  /** The accent the scheme starts from (brand colour or the archetype's). */
  accent: string;
  /** The archetype's own accent: the second colour's base when the brand colour is grey. */
  fallback: string;
  source: PaletteV3["source"];
  seed: string;
  key: string;
}

function neutral(l: number, c: number, h: number, scheme: SchemeName): string {
  let chroma = c;
  let hex = fromLch(l, chroma, h);
  // Catalog C02: never a cream page by default — lower the chroma until it is not.
  while (scheme === "light" && isCream(hex) && chroma > 0.0005) {
    chroma /= 2;
    hex = fromLch(l, chroma, h);
  }
  return hex;
}

function buildScheme(scheme: SchemeName, o: SchemeOpts): PaletteScheme {
  const { rules } = o;
  const light = scheme === "light";
  const a = hexToOklch(o.accent);
  const nh = rules.neutralHue === "brand" ? (a.c >= 0.03 ? hueDeg(a) : 250) : rules.neutralHue;
  const nc = rules.neutralC;
  const bgL = light ? rules.bgL.light : rules.bgL.dark;
  const bg = neutral(bgL, nc, nh, scheme);
  const surface = neutral(light ? Math.min(1, bgL + 0.016) : bgL + 0.04, nc * 0.6, nh, scheme);

  // Accent fill: the brand colour stays as is in the light scheme; otherwise it is moved to stand out from the page.
  const keepBrand = o.source === "brand" && light;
  const fill = keepBrand
    ? quantize(o.accent)
    : stepToContrast(o.accent, [bg, surface], MIN_NON_TEXT, light ? "light" : "dark");
  const soft = quantize(blend(fill, surface, light ? 0.12 : 0.22));

  let surfaceAlt: string;
  if (rules.band === "tint") {
    surfaceAlt = quantize(blend(fill, surface, light ? 0.08 : 0.14));
    if (light && isCream(surfaceAlt)) surfaceAlt = neutral(bgL - 0.03, nc, nh, scheme);
  } else {
    const d = rules.band === "deep" ? 0.06 : 0.03;
    surfaceAlt = neutral(light ? bgL - d : bgL + d, nc * 1.4, nh, scheme);
  }
  const backs = [bg, surface, surfaceAlt];

  const ink = stepToContrast(
    fromLch(light ? 0.2 : 0.95, Math.min(0.02, nc * 2.5), nh),
    [...backs, soft],
    MIN_TEXT,
    scheme,
  );
  const muted = stepToContrast(
    fromLch(light ? 0.48 : 0.76, Math.min(0.025, nc * 2.5), nh),
    [...backs, soft],
    MIN_TEXT,
    scheme,
  );
  const line = neutral(light ? bgL - 0.075 : bgL + 0.1, nc * 1.5, nh, scheme);
  const border = stepToContrast(fromLch(light ? 0.64 : 0.5, nc * 2, nh), [bg, surface], MIN_NON_TEXT, scheme);

  const accentInkHex = quantize(accentInk(fill));
  const strong = quantize(accentStrong(fill));
  const accentStrongHex = contrast(accentInkHex, strong) >= MIN_TEXT ? strong : fill;
  const text = stepToContrast(fill, [...backs, soft], MIN_TEXT, scheme);
  const edge = backs.every((b) => contrast(fill, b) >= MIN_NON_TEXT) ? fill : text;

  const a2base = secondAccent(rules, fill, o.fallback, o.source, o.seed, o.key);
  const a2 = a2base === fill ? fill : stepToContrast(a2base, [bg, surface], MIN_NON_TEXT, scheme);
  const status = (c: string) => stepToContrast(c, backs, MIN_TEXT, scheme);
  const base = PALETTE[scheme];

  const css = oklchCss;
  return {
    bg: css(bg),
    surface: css(surface),
    surfaceAlt: css(surfaceAlt),
    ink: css(ink),
    muted: css(muted),
    line: css(line),
    border: css(border),
    accent: css(fill),
    accentInk: css(accentInkHex),
    accentText: css(text),
    accentStrong: css(accentStrongHex),
    accentSoft: css(soft),
    accentEdge: css(edge),
    accent2: css(a2),
    accent2Ink: css(quantize(accentInk(a2))),
    focus: css(text),
    ok: css(status(base.ok)),
    warn: css(status(base.warn)),
    bad: css(status(base.bad)),
    overlay: css(fromLch(0.17, 0.01, nh), OVERLAY_ALPHA),
    overlayInk: css("#FFFFFF"),
  };
}

/**
 * Palette of a design system: the accent is the brand colour when given (kept as is in the light scheme; the dark
 * scheme gets a shade that stands out from its page), otherwise the archetype's hue picked by the seed. Neutrals,
 * bands, the second colour and status colours follow the archetype's rules; every text pair keeps ≥ 4.5:1, buttons,
 * borders and the focus ring ≥ 3:1.
 */
export function buildPalette(o: {
  rules: PaletteRules;
  brandColor?: string;
  seed: string;
  key: string;
  accentUse?: AccentUse;
}): PaletteV3 {
  const brand = normalizeBrand(o.brandColor);
  const fallback = archetypeAccent(o.rules, o.seed, o.key);
  const source = brand ? "brand" : "archetype";
  const accent = brand ?? fallback;
  const opts: SchemeOpts = { rules: o.rules, accent, fallback, source, seed: o.seed, key: o.key };
  return {
    source,
    ...(brand ? { brandColor: brand } : {}),
    scheme: o.rules.scheme,
    accentUse: o.accentUse ?? o.rules.accentUse,
    light: buildScheme("light", opts),
    dark: buildScheme("dark", opts),
  };
}

/** Hex values of a scheme (what contrast is measured on). */
export function schemeHex(p: PaletteScheme): Record<ColorRole, string> {
  const out = {} as Record<ColorRole, string>;
  for (const role of COLOR_ROLES) out[role] = cssHex(p[role]);
  return out;
}
