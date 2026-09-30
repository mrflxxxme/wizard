// Design tokens (ui-kit.yaml#tokens): pure theme → CSS variables, plus DOM application.
import type { Theme } from "@wizard/appspec";
import { blend, contrast, hexToOklch, oklchToHex } from "./color.js";

export type Scheme = "light" | "dark";
export type TokenName = `--w-${string}`;
export type Tokens = Record<TokenName, string>;
export type ThemeInput = Theme | undefined | null;

export const THEME_DEFAULTS = {
  accent: "#2F46D8",
  font: "Onest",
  radius: 8,
  density: "regular",
  mode: "auto",
} as const satisfies Required<Omit<Theme, "logoFile">>;

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

const INK_LIGHT = "#FFFFFF";
const INK_DARK = "#111318";
const MIN_CONTRAST = 4.5;
const SOFT_ALPHA = { light: 0.12, dark: 0.22 } as const;
const TONE_SOFT_ALPHA = { light: 0.12, dark: 0.16 } as const;

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

function normalizeAccent(accent: string | undefined): string {
  return accent && /^#[0-9a-f]{6}$/i.test(accent) ? accent.toUpperCase() : THEME_DEFAULTS.accent;
}

/** Pure: same result in runtime bundles and platform-web; no DOM access. */
export function themeToTokens(theme: ThemeInput, scheme: Scheme): Tokens {
  const p = PALETTE[scheme];
  const accent = normalizeAccent(theme?.accent ?? undefined);
  const font = theme?.font ?? THEME_DEFAULTS.font;
  const radius = theme?.radius ?? THEME_DEFAULTS.radius;
  const compact = (theme?.density ?? THEME_DEFAULTS.density) === "compact";
  const accentSoft = blend(accent, p.surface, SOFT_ALPHA[scheme]);
  const text = accentText(accent, scheme, [p.bg, p.surface, accentSoft]);
  const toneSoft = (c: string) => blend(c, p.surface, TONE_SOFT_ALPHA[scheme]);
  return {
    "--w-accent": accent,
    "--w-accent-ink": accentInk(accent),
    "--w-accent-text": text,
    "--w-accent-soft": accentSoft,
    "--w-bg": p.bg,
    "--w-surface": p.surface,
    "--w-ink": p.ink,
    "--w-muted": p.muted,
    "--w-line": p.line,
    "--w-ok": p.ok,
    "--w-warn": p.warn,
    "--w-bad": p.bad,
    "--w-neutral-soft": toneSoft(p.muted),
    "--w-ok-soft": toneSoft(p.ok),
    "--w-warn-soft": toneSoft(p.warn),
    "--w-bad-soft": toneSoft(p.bad),
    "--w-focus": text,
    "--w-radius": `${radius}px`,
    "--w-radius-sm": `${Math.min(radius, 6)}px`,
    "--w-font": `"${font}", system-ui, -apple-system, "Segoe UI", sans-serif`,
    "--w-font-size": "16px",
    "--w-font-size-sm": "14px",
    "--w-font-size-lg": "20px",
    "--w-font-size-xl": "28px",
    "--w-density-pad": compact ? "8px 12px" : "12px 16px",
    "--w-density-gap": compact ? "8px" : "16px",
    "--w-density-control": compact ? "36px" : "44px",
    "--w-density-row": compact ? "40px" : "52px",
    "--w-color-scheme": scheme,
  };
}

const block = (t: Tokens) =>
  Object.entries(t)
    .map(([k, v]) => `${k}:${v};`)
    .join("");

/** tokens.css (ui-kit.yaml#tokens.css_output); `scope` replaces :root for a non-document root. */
export function tokensToCss(theme: ThemeInput, scope?: string): string {
  const light = block(themeToTokens(theme, "light"));
  const dark = block(themeToTokens(theme, "dark"));
  const root = scope ?? ":root";
  const on = (mode: string) => (scope ? `${scope}[data-wz-mode=${mode}]` : `[data-wz-mode=${mode}]`);
  return (
    `${root}{${light}}\n${on("dark")}{${dark}}\n` +
    `@media (prefers-color-scheme: dark){${on("auto")}{${dark}}}\n`
  );
}

let scopeSeq = 0;

/** Sets light+dark variables and data-wz-mode on `root` without a reload (one <style> per root). */
export function applyTokens(root: HTMLElement, theme: ThemeInput): void {
  const doc = root.ownerDocument;
  const isDoc = root === doc.documentElement;
  let key = root.getAttribute("data-wz-tokens");
  if (!key) {
    key = isDoc ? "root" : `s${++scopeSeq}`;
    root.setAttribute("data-wz-tokens", key);
  }
  const css = tokensToCss(theme, isDoc ? undefined : `[data-wz-tokens="${key}"]`);
  let style = doc.head.querySelector<HTMLStyleElement>(`style[data-wz-tokens-for="${key}"]`);
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute("data-wz-tokens-for", key);
    doc.head.appendChild(style);
  }
  if (style.textContent !== css) style.textContent = css;
  root.setAttribute("data-wz-mode", theme?.mode ?? THEME_DEFAULTS.mode);
}
