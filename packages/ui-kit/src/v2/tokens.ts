// Platform design system v2 (B2-32, ui-kit.yaml#platform_v2, docs/reviews/grill-7.md, prototype E «Холст»).
// Pure token tables and CSS text; --p-* variables, separate from the --w-* tokens of generated systems.

import { accentInk, accentText } from "../tokens/accent.js";
import { blend, contrast, hexToOklch, hexToRgb, oklchToHex } from "../tokens/color.js";

export type PlatformScheme = "light" | "dark";
export type PlatformTokenName = `--p-${string}`;
export type PlatformTokens = Record<PlatformTokenName, string>;

/** Opaque colours of the warm neutral palette (grill-7 #6, #8): graphite for actions, amber only where something is made. */
export const PLATFORM_COLORS = {
  light: {
    bg: "#F8F7F4",
    surface: "#FFFFFF",
    sunken: "#F2F0EB",
    sunken2: "#E9E6E0",
    ink: "#1D1C1A",
    ink2: "#6B6862",
    ink3: "#A29E96",
    line: "#E9E6E0",
    line2: "#D8D4CB",
    graphite: "#1D1C1A",
    graphiteInk: "#F8F7F4",
    graphiteHover: "#3A3834",
    amber: "#D98A2B",
    amberGlow: "#F2B45C",
    amberInk: "#1D1C1A",
    ok: "#3A7350",
    warn: "#8A5A12",
    bad: "#A0443A",
    bezel: "#2A2926",
    glassSolid: "#FBFAF7",
  },
  dark: {
    bg: "#1B1A18",
    surface: "#252421",
    sunken: "#2D2C29",
    sunken2: "#363430",
    ink: "#EEECE7",
    ink2: "#A6A29A",
    ink3: "#6F6B64",
    line: "#33312D",
    line2: "#47443F",
    graphite: "#EEECE7",
    graphiteInk: "#1B1A18",
    graphiteHover: "#FFFFFF",
    amber: "#E0953A",
    amberGlow: "#F2B45C",
    amberInk: "#1D1C1A",
    ok: "#8DC3A0",
    warn: "#E2B36E",
    bad: "#E59A8F",
    bezel: "#0E0D0C",
    glassSolid: "#282724",
  },
} as const satisfies Record<PlatformScheme, Record<string, string>>;

export type PlatformColor = keyof (typeof PLATFORM_COLORS)["light"];

/** Translucent layers, depth and grain per scheme (prototype E). */
const EFFECTS = {
  light: {
    "--p-amber-soft": "rgba(217, 138, 43, 0.18)",
    "--p-skel": "rgba(60, 52, 40, 0.08)",
    "--p-track": "rgba(29, 28, 26, 0.09)",
    "--p-glass": "rgba(251, 250, 247, 0.72)",
    "--p-glass-edge": "rgba(255, 255, 255, 0.85)",
    "--p-scrim": "rgba(29, 28, 26, 0.18)",
    "--p-sh-1": "0 0 0 1px rgba(48, 40, 28, 0.05), 0 1px 2px rgba(48, 40, 28, 0.05)",
    "--p-sh-2":
      "0 0 0 1px rgba(48, 40, 28, 0.045), 0 1px 2px rgba(48, 40, 28, 0.04), 0 10px 24px -10px rgba(48, 40, 28, 0.09), 0 28px 56px -32px rgba(48, 40, 28, 0.16)",
    "--p-sh-float":
      "0 0 0 1px rgba(48, 40, 28, 0.06), 0 2px 6px rgba(48, 40, 28, 0.05), 0 20px 48px -16px rgba(48, 40, 28, 0.22)",
    "--p-grain": "0.055",
  },
  dark: {
    "--p-amber-soft": "rgba(242, 180, 92, 0.16)",
    "--p-skel": "rgba(238, 236, 231, 0.075)",
    "--p-track": "rgba(238, 236, 231, 0.1)",
    "--p-glass": "rgba(38, 37, 34, 0.72)",
    "--p-glass-edge": "rgba(255, 255, 255, 0.07)",
    "--p-scrim": "rgba(0, 0, 0, 0.35)",
    "--p-sh-1": "0 0 0 1px rgba(255, 255, 255, 0.045), 0 1px 2px rgba(0, 0, 0, 0.3)",
    "--p-sh-2":
      "0 0 0 1px rgba(255, 255, 255, 0.05), 0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 24px -10px rgba(0, 0, 0, 0.4), 0 28px 56px -30px rgba(0, 0, 0, 0.55)",
    "--p-sh-float":
      "0 0 0 1px rgba(255, 255, 255, 0.07), 0 2px 6px rgba(0, 0, 0, 0.3), 0 20px 48px -14px rgba(0, 0, 0, 0.6)",
    "--p-grain": "0.07",
  },
} as const satisfies Record<PlatformScheme, PlatformTokens>;

/** Scheme-independent tokens: fonts, radii, easing and the timing of «материализация». */
export const PLATFORM_CONSTANTS: PlatformTokens = {
  "--p-f-ui": '"Inter", -apple-system, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif',
  "--p-f-serif": '"Source Serif 4", "Literata", Georgia, "Times New Roman", serif',
  "--p-r-xl": "24px",
  "--p-r-lg": "18px",
  "--p-r-md": "13px",
  "--p-r-sm": "10px",
  "--p-r-pill": "999px",
  "--p-spring": "cubic-bezier(0.34, 1.28, 0.64, 1)",
  "--p-ease": "cubic-bezier(0.22, 1, 0.36, 1)",
  "--p-t-fast": "0.25s",
  "--p-t-base": "0.5s",
  "--p-t-slow": "0.8s",
};

/** Milliseconds from «материализация» start to the block being ready: outline → surface → content + amber edge. */
export const MATERIALIZE_MS = 1500;

/** Prototype E demo business colour (clinic «Светлая»). */
export const DEMO_BUSINESS_COLOR = "#0F766E";

const SOFT = { light: 0.09, dark: 0.12 } as const;
const RING = { light: 0.32, dark: 0.4 } as const;
const WASH = { light: 0.1, dark: 0.1 } as const;
const MIN_NON_TEXT = 3;

/** `#RRGGBB` + alpha → `rgba(r, g, b, a)`. */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex).map((x) => Math.round(x * 255)) as [number, number, number];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Business colour tokens resolved for one scheme; `soft` is also given composited over the surface (for contrast checks). */
export interface BusinessColors {
  biz: string;
  bizText: string;
  bizInk: string;
  bizSoft: string;
  bizSoftSolid: string;
  bizRing: string;
  bizWash: string;
}

function normalize(hex: string | null | undefined): string | null {
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex.toUpperCase() : null;
}

/** Moves the colour's OKLCH lightness away from the page until it stands out (≥ 3:1) from bg and surface. */
function visibleFill(hex: string, scheme: PlatformScheme): string {
  const p = PLATFORM_COLORS[scheme];
  const ok = (c: string) => contrast(c, p.bg) >= MIN_NON_TEXT && contrast(c, p.surface) >= MIN_NON_TEXT;
  if (ok(hex)) return hex;
  const base = hexToOklch(hex);
  const dir = scheme === "light" ? -1 : 1;
  for (let l = base.l; l >= 0 && l <= 1; l += dir * 0.01) {
    const c = oklchToHex({ ...base, l });
    if (ok(c)) return c;
  }
  return p.ink;
}

/**
 * Client business colour as the accent (grill-7 #7): fill visible on the page (≥ 3:1), text on it ≥ 4.5:1, coloured text on
 * every platform background and on its soft wash ≥ 4.5:1. No colour (or a malformed one) → graphite, the platform accent.
 */
export function businessColors(hex: string | null | undefined, scheme: PlatformScheme): BusinessColors {
  const p = PLATFORM_COLORS[scheme];
  const n = normalize(hex);
  if (!n) {
    return {
      biz: p.graphite,
      bizText: p.ink,
      bizInk: p.graphiteInk,
      bizSoft: rgba(p.graphite, 0.07),
      bizSoftSolid: blend(p.graphite, p.surface, 0.07),
      bizRing: rgba(p.graphite, 0.18),
      bizWash: p.sunken,
    };
  }
  const biz = visibleFill(n, scheme);
  const softSolid = blend(biz, p.surface, SOFT[scheme]);
  const softOnBg = blend(biz, p.bg, SOFT[scheme]);
  const wash = blend(biz, p.surface, WASH[scheme]);
  const bizText = accentText(biz, scheme, [
    p.bg,
    p.surface,
    p.sunken,
    p.glassSolid,
    softSolid,
    softOnBg,
    wash,
  ]);
  return {
    biz,
    bizText,
    bizInk: accentInk(biz),
    bizSoft: rgba(biz, SOFT[scheme]),
    bizSoftSolid: softSolid,
    bizRing: rgba(biz, RING[scheme]),
    bizWash: wash,
  };
}

function businessTokens(b: BusinessColors): PlatformTokens {
  return {
    "--p-biz": b.biz,
    "--p-biz-text": b.bizText,
    "--p-biz-ink": b.bizInk,
    "--p-biz-soft": b.bizSoft,
    "--p-biz-ring": b.bizRing,
    "--p-biz-wash": b.bizWash,
  };
}

const kebab = (s: string) => s.replace(/[A-Z0-9]+/g, (m) => `-${m.toLowerCase()}`);

/** All --p-* tokens of a scheme (business colour = graphite until a client system appears). Pure. */
export function platformTokens(scheme: PlatformScheme, business?: string | null): PlatformTokens {
  const p = PLATFORM_COLORS[scheme];
  const colors = Object.fromEntries(
    Object.entries(p).map(([k, v]) => [`--p-${kebab(k)}`, v]),
  ) as PlatformTokens;
  return {
    ...colors,
    ...EFFECTS[scheme],
    ...businessTokens(businessColors(business, scheme)),
    // Tint: graphite by default, the business colour once the root has data-p-biz (see platformThemeCss).
    "--p-tint": "var(--p-graphite)",
    "--p-tint-text": "var(--p-ink)",
    "--p-tint-soft": rgba(p.graphite, 0.07),
    "--p-tint-ring": rgba(p.graphite, 0.18),
    "--p-color-scheme": scheme,
  };
}

const block = (t: PlatformTokens) =>
  Object.entries(t)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");

/** Root selector of the platform design system: <html data-p-root> or any container (ThemeRoot). */
export const PLATFORM_ROOT = "[data-p-root]";

/**
 * CSS text of the tokens (src/v2/tokens.css is this output, checked by test): light on the root, dark by
 * prefers-color-scheme unless data-p-theme="light", forced by data-p-theme="dark"; data-p-biz switches the tint.
 */
export function platformThemeCss(): string {
  const r = PLATFORM_ROOT;
  const light = { ...PLATFORM_CONSTANTS, ...platformTokens("light") };
  const darkOnly = platformTokens("dark");
  return [
    "/* Generated from src/v2/tokens.ts (platformThemeCss) — do not edit by hand; test/v2-tokens.test.ts checks it. */",
    `${r} {\n${block(light)}\n  color-scheme: light;\n}`,
    `@media (prefers-color-scheme: dark) {\n  ${r}:not([data-p-theme="light"]) {\n${block(darkOnly).replace(/^/gm, "  ")}\n    color-scheme: dark;\n  }\n}`,
    `${r}[data-p-theme="dark"] {\n${block(darkOnly)}\n  color-scheme: dark;\n}`,
    `${r}[data-p-biz] {\n  --p-tint: var(--p-biz);\n  --p-tint-text: var(--p-biz-text);\n  --p-tint-soft: var(--p-biz-soft);\n  --p-tint-ring: var(--p-biz-ring);\n}`,
    ...businessSchemeCss(),
    "",
  ].join("\n\n");
}

/** Business tokens without the scheme suffix (--p-biz, --p-biz-text, …). */
const BIZ_TOKENS = [
  "--p-biz",
  "--p-biz-text",
  "--p-biz-ink",
  "--p-biz-soft",
  "--p-biz-ring",
  "--p-biz-wash",
] as const;

/**
 * The business colour set by applyPlatformTheme as CSS variables per scheme (--p-biz-light, --p-biz-text-dark, …) is
 * picked by the same selectors as the theme: the attribute is repeated so these rules win over the token blocks above.
 */
function businessSchemeCss(): string[] {
  const r = PLATFORM_ROOT;
  const sel = `${r}[data-p-biz][data-p-biz]`;
  const pick = (scheme: PlatformScheme, indent: string) =>
    BIZ_TOKENS.map((t) => `${indent}${t}: var(${t}-${scheme});`).join("\n");
  return [
    `${sel} {\n${pick("light", "  ")}\n}`,
    `@media (prefers-color-scheme: dark) {\n  ${sel}:not([data-p-theme="light"]) {\n${pick("dark", "    ")}\n  }\n}`,
    `${sel}[data-p-theme="dark"] {\n${pick("dark", "  ")}\n}`,
  ];
}

/** CSS variables of a business colour for both schemes (--p-biz-light … --p-biz-wash-dark), for an inline style. */
export function businessVars(hex: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const scheme of ["light", "dark"] as const)
    for (const [k, v] of Object.entries(businessTokens(businessColors(hex, scheme))))
      out[`${k}-${scheme}`] = v;
  return out;
}

/** CSS of a business colour for one root (both schemes, same selectors as platformThemeCss). */
export function businessCss(hex: string, scope: string): string {
  const light = block(businessTokens(businessColors(hex, "light")));
  const dark = block(businessTokens(businessColors(hex, "dark")));
  return (
    `${scope} {\n${light}\n}\n` +
    `@media (prefers-color-scheme: dark) {\n  ${scope}:not([data-p-theme="light"]) {\n${dark.replace(/^/gm, "  ")}\n  }\n}\n` +
    `${scope}[data-p-theme="dark"] {\n${dark}\n}\n`
  );
}

export type PlatformThemeMode = "auto" | "light" | "dark";
export interface PlatformThemeOptions {
  /** auto — by prefers-color-scheme (default). */
  theme?: PlatformThemeMode;
  /** Client business colour #RRGGBB; null/undefined — platform graphite. */
  business?: string | null;
  /** false forces the solid glass fallback (no backdrop-filter), e.g. on weak devices. */
  glass?: boolean;
  /** Paper grain on the background (default on). */
  grain?: boolean;
}

/**
 * Marks `root` as a platform root and applies theme, business colour, glass and grain without a reload. The business
 * colour goes in as CSS variables of the root (CSSOM): the platform CSP forbids an injected <style> (B2-25, B2-34).
 */
export function applyPlatformTheme(root: HTMLElement, opts: PlatformThemeOptions = {}): void {
  root.setAttribute("data-p-root", "");
  const theme = opts.theme ?? "auto";
  if (theme === "auto") root.removeAttribute("data-p-theme");
  else root.setAttribute("data-p-theme", theme);
  if (opts.glass === false) root.setAttribute("data-p-glass", "off");
  else root.removeAttribute("data-p-glass");
  if (opts.grain === false) root.removeAttribute("data-p-grain");
  else root.setAttribute("data-p-grain", "");
  const hex = normalize(opts.business);
  if (!hex) {
    root.removeAttribute("data-p-biz");
    for (const t of BIZ_TOKENS) for (const sc of ["light", "dark"]) root.style.removeProperty(`${t}-${sc}`);
    return;
  }
  for (const [k, v] of Object.entries(businessVars(hex))) root.style.setProperty(k, v);
  root.setAttribute("data-p-biz", hex);
}
