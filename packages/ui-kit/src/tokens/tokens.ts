// Design tokens (ui-kit.yaml#tokens): pure theme → CSS variables, plus DOM application.
// v2 (M2-42): presets (themes.yaml), heading font, type scale, depth, rhythm and shades derived from one brand colour.
import type { Theme } from "@wizard/appspec";
import { type ThemePreset, themePreset } from "../themes/presets.js";
import { accentInk, accentStrong, accentText } from "./accent.js";
import { CABINET_TOKENS, cabinetTokens } from "./cabinet.js";
import { blend, contrast } from "./color.js";
import { FONTS_BASE, fontEntry, fontFaceCss, fontStack } from "./fonts.js";

export type Scheme = "light" | "dark";
export { accentInk, accentStrong, accentText };
export type TokenName = `--w-${string}`;
export type Tokens = Record<TokenName, string>;
export type ThemeInput = Theme | undefined | null;

export const THEME_DEFAULTS = {
  accent: "#2F46D8",
  font: "Onest",
  radius: 8,
  density: "regular",
  mode: "auto",
} as const satisfies Required<Pick<Theme, "accent" | "font" | "radius" | "density" | "mode">>;

export const PALETTE = {
  light: {
    bg: "#F6F6F4",
    surface: "#FFFFFF",
    ink: "#16171B",
    muted: "#5A5E69",
    line: "#E1E2E6",
    ok: "#1E7A4C",
    warn: "#9A5205",
    bad: "#B3261E",
  },
  dark: {
    bg: "#0F1115",
    surface: "#171A21",
    ink: "#ECEEF3",
    muted: "#A3A9B6",
    line: "#2A2F3A",
    ok: "#62CC93",
    warn: "#F0A657",
    bad: "#F08A80",
  },
} as const;

/** Alternate section band of a theme without preset (v1): the surface, so v1 accent-text needs no new background. */
const V1_SURFACE_ALT = { light: PALETTE.light.surface, dark: PALETTE.dark.surface } as const;

const MIN_NON_TEXT = 3;
const SOFT_ALPHA = { light: 0.12, dark: 0.22 } as const;
const TINT_ALPHA = { light: 0.06, dark: 0.1 } as const;
const TONE_SOFT_ALPHA = { light: 0.12, dark: 0.16 } as const;

const SHADOWS: Record<ThemePreset["depth"], Record<Scheme, readonly [string, string]>> = {
  flat: { light: ["none", "none"], dark: ["none", "none"] },
  soft: {
    light: ["0 1px 2px rgba(17,24,39,0.06), 0 1px 3px rgba(17,24,39,0.08)", "0 6px 20px rgba(17,24,39,0.08)"],
    dark: ["0 1px 2px rgba(0,0,0,0.4)", "0 8px 24px rgba(0,0,0,0.45)"],
  },
  lifted: {
    light: [
      "0 2px 4px rgba(17,24,39,0.08), 0 1px 2px rgba(17,24,39,0.06)",
      "0 14px 36px rgba(17,24,39,0.14)",
    ],
    dark: ["0 2px 6px rgba(0,0,0,0.5)", "0 16px 40px rgba(0,0,0,0.55)"],
  },
};
const SECTION_SPACE = { regular: "clamp(48px, 7vw, 88px)", airy: "clamp(64px, 9vw, 120px)" } as const;

function normalizeAccent(accent: string | undefined): string {
  return accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toUpperCase() : THEME_DEFAULTS.accent;
}

/** Theme with defaults applied: explicit fields win over the preset, the preset over THEME_DEFAULTS. */
export interface ResolvedTheme {
  accent: string;
  font: string;
  headingFont: string;
  radius: number;
  density: "compact" | "regular";
  mode: "light" | "dark" | "auto";
  preset: ThemePreset | undefined;
}

export function resolveTheme(theme: ThemeInput): ResolvedTheme {
  const preset = themePreset(theme?.preset);
  const font = theme?.font ?? preset?.defaults.font ?? THEME_DEFAULTS.font;
  return {
    accent: normalizeAccent(theme?.accent ?? preset?.defaults.accent),
    font,
    headingFont: theme?.headingFont ?? preset?.defaults.headingFont ?? font,
    radius: theme?.radius ?? preset?.defaults.radius ?? THEME_DEFAULTS.radius,
    density: theme?.density ?? preset?.defaults.density ?? THEME_DEFAULTS.density,
    mode: theme?.mode ?? THEME_DEFAULTS.mode,
    preset,
  };
}

/** v2 tokens (M2-42) a theme without them never had: landing blocks and Image use them. */
export const V2_TOKENS: readonly TokenName[] = [
  "--w-font-heading",
  "--w-heading-weight",
  "--w-heading-tracking",
  "--w-font-size-display",
  "--w-font-size-h2",
  "--w-font-size-h3",
  "--w-radius-lg",
  "--w-shadow-sm",
  "--w-shadow-md",
  "--w-surface-alt",
  "--w-accent-strong",
  "--w-accent-tint",
  "--w-accent-edge",
  "--w-overlay",
  "--w-overlay-ink",
  "--w-section-space",
  "--w-container",
  // B2-34: the cabinet look (cabinet.ts) — warm neutrals and the brand colour with the v2 contrast.
  ...CABINET_TOKENS,
];

/**
 * Pure: same result in runtime bundles and platform-web; no DOM access. A theme without preset and headingFont (v1)
 * keeps every token it had before v2 with the same value; v2 only adds V2_TOKENS.
 */
export function themeToTokens(theme: ThemeInput, scheme: Scheme): Tokens {
  const r = resolveTheme(theme);
  const p = PALETTE[scheme];
  const n = r.preset?.palette[scheme];
  const bg = n?.bg ?? p.bg;
  const surface = n?.surface ?? p.surface;
  const surfaceAlt = n?.surfaceAlt ?? V1_SURFACE_ALT[scheme];
  const muted = n?.muted ?? p.muted;
  const { accent, radius } = r;
  const compact = r.density === "compact";
  const accentSoft = blend(accent, surface, SOFT_ALPHA[scheme]);
  const accentTint = blend(accent, surface, TINT_ALPHA[scheme]);
  // v1 keeps its exact accent-text (three backgrounds); presets also guard the section bands.
  const text = accentText(
    accent,
    scheme,
    r.preset ? [bg, surface, surfaceAlt, accentSoft, accentTint] : [bg, surface, accentSoft],
  );
  // Fill edge of primary buttons and accent bands: the accent when it stands out from the page (≥ 3:1), else accent-text.
  const edge =
    contrast(accent, bg) >= MIN_NON_TEXT && contrast(accent, surface) >= MIN_NON_TEXT ? accent : text;
  const toneSoft = (c: string) => blend(c, surface, TONE_SOFT_ALPHA[scheme]);
  const [shadowSm, shadowMd] = SHADOWS[r.preset?.depth ?? "soft"][scheme];
  const wide = r.headingFont === "Unbounded";
  return {
    "--w-accent": accent,
    "--w-accent-ink": accentInk(accent),
    "--w-accent-text": text,
    "--w-accent-soft": accentSoft,
    "--w-bg": bg,
    "--w-surface": surface,
    "--w-ink": n?.ink ?? p.ink,
    "--w-muted": muted,
    "--w-line": n?.line ?? p.line,
    "--w-ok": p.ok,
    "--w-warn": p.warn,
    "--w-bad": p.bad,
    "--w-neutral-soft": toneSoft(muted),
    "--w-ok-soft": toneSoft(p.ok),
    "--w-warn-soft": toneSoft(p.warn),
    "--w-bad-soft": toneSoft(p.bad),
    "--w-focus": text,
    "--w-radius": `${radius}px`,
    "--w-radius-sm": `${Math.min(radius, 6)}px`,
    "--w-font":
      fontEntry(r.font)?.category === "serif"
        ? fontStack(r.font)
        : `"${r.font}", system-ui, -apple-system, "Segoe UI", sans-serif`,
    "--w-font-size": "16px",
    "--w-font-size-sm": "14px",
    "--w-font-size-lg": "20px",
    "--w-font-size-xl": "28px",
    "--w-density-pad": compact ? "8px 12px" : "12px 16px",
    "--w-density-gap": compact ? "8px" : "16px",
    "--w-density-control": compact ? "36px" : "44px",
    "--w-density-row": compact ? "40px" : "52px",
    "--w-color-scheme": scheme,
    "--w-font-heading": fontStack(r.headingFont),
    "--w-heading-weight": String(r.preset?.heading.weight ?? 700),
    "--w-heading-tracking": r.preset?.heading.tracking ?? "-0.01em",
    "--w-font-size-display": wide ? "clamp(28px, 2.4vw + 18px, 48px)" : "clamp(32px, 3vw + 20px, 56px)",
    "--w-font-size-h2": wide ? "clamp(24px, 1.4vw + 16px, 34px)" : "clamp(26px, 1.6vw + 18px, 38px)",
    "--w-font-size-h3": "20px",
    "--w-radius-lg": `${Math.min(radius * 2, 24)}px`,
    "--w-shadow-sm": shadowSm,
    "--w-shadow-md": shadowMd,
    "--w-surface-alt": surfaceAlt,
    "--w-accent-strong": accentStrong(accent),
    "--w-accent-tint": accentTint,
    "--w-accent-edge": edge,
    "--w-overlay": "rgba(0, 0, 0, 0.55)",
    "--w-overlay-ink": "#FFFFFF",
    "--w-section-space": SECTION_SPACE[r.preset?.space ?? "regular"],
    "--w-container": "1200px",
    ...cabinetTokens(accent, scheme),
  };
}

const block = (t: Tokens) =>
  Object.entries(t)
    .map(([k, v]) => `${k}:${v};`)
    .join("");

/** Families a theme needs (text and headings), for @font-face. */
export function themeFonts(theme: ThemeInput): string[] {
  const r = resolveTheme(theme);
  return [...new Set([r.font, r.headingFont])];
}

/**
 * tokens.css (ui-kit.yaml#tokens.css_output); `scope` replaces :root for a non-document root. With `fonts` the
 * @font-face rules of the theme fonts (served by the runtime from /_wizard/fonts) come first.
 */
export function tokensToCss(
  theme: ThemeInput,
  scope?: string,
  opts: { fonts?: boolean; fontBase?: string } = {},
): string {
  const light = block(themeToTokens(theme, "light"));
  const dark = block(themeToTokens(theme, "dark"));
  const root = scope ?? ":root";
  const on = (mode: string) => (scope ? `${scope}[data-wz-mode=${mode}]` : `[data-wz-mode=${mode}]`);
  const faces = opts.fonts ? fontFaceCss(themeFonts(theme), opts.fontBase ?? FONTS_BASE) : "";
  return (
    (faces ? `${faces}\n` : "") +
    `${root}{${light}}\n${on("dark")}{${dark}}\n` +
    `@media (prefers-color-scheme: dark){${on("auto")}{${dark}}}\n`
  );
}

let scopeSeq = 0;

/**
 * Sets light+dark variables, the theme's @font-face rules and data-wz-mode on `root` without a reload (one <style> per
 * root). `fontBase` — where the woff2 files are served (default /_wizard/fonts/ of the runtime).
 */
export function applyTokens(root: HTMLElement, theme: ThemeInput, opts: { fontBase?: string } = {}): void {
  const doc = root.ownerDocument;
  const isDoc = root === doc.documentElement;
  let key = root.getAttribute("data-wz-tokens");
  if (!key) {
    key = isDoc ? "root" : `s${++scopeSeq}`;
    root.setAttribute("data-wz-tokens", key);
  }
  const css = tokensToCss(theme, isDoc ? undefined : `[data-wz-tokens="${key}"]`, {
    fonts: true,
    ...(opts.fontBase ? { fontBase: opts.fontBase } : {}),
  });
  let style = doc.head.querySelector<HTMLStyleElement>(`style[data-wz-tokens-for="${key}"]`);
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute("data-wz-tokens-for", key);
    doc.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
  root.setAttribute("data-wz-mode", theme?.mode ?? THEME_DEFAULTS.mode);
}
