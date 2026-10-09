// «Стиль» (platform-screens.yaml S5): options of AppSpec.theme and tokens for apply-theme-tokens (ui-kit themeToTokens).
// v2 (M2-42): one of four theme presets and the brand colour; fonts of the theme go to the preview as @font-face data.
import { THEME_FONTS } from "@wizard/appspec";
import {
  fontEntry,
  fontHasRuble,
  RUBLE_FALLBACK_FONT,
  resolveTheme,
  THEME_PRESET_LIST,
  themeFonts,
  themeToTokens,
} from "@wizard/ui-kit";
import type { Theme } from "../api/types.js";

export const ACCENT_PRESETS = ["#2F46D8", "#C2410C", "#0A7D3E", "#9D174D"] as const;
export const FONTS = THEME_FONTS;
export const PRESETS = THEME_PRESET_LIST;
export const RADII = [0, 4, 8, 12, 16] as const;
export const DENSITIES = ["compact", "regular"] as const;
export const MODES = ["light", "dark", "auto"] as const;
export const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export type ThemeMode = (typeof MODES)[number];
type Resolved = Required<Pick<Theme, "accent" | "font" | "headingFont" | "radius" | "density" | "mode">>;

/** The theme with preset and default values filled in (what the system actually shows). */
export function withDefaults(theme: Theme | undefined | null): Resolved & Theme {
  const r = resolveTheme(theme);
  return {
    ...(theme ?? {}),
    accent: r.accent,
    font: r.font as Resolved["font"],
    headingFont: r.headingFont as Resolved["headingFont"],
    radius: r.radius as Resolved["radius"],
    density: r.density,
    mode: r.mode,
  };
}

/** Switching the theme keeps the owner's brand colour, mode, density and logo; fonts and radius come from the theme. */
export function withPreset(theme: Theme, preset: Theme["preset"] | ""): Theme {
  const { preset: _p, font: _f, headingFont: _h, radius: _r, ...rest } = theme;
  return preset ? { ...rest, preset } : rest;
}

export type PreviewFontFace = { family: string; weight: number; file: string; unicodeRange: string };

/** Tokens for the preview: one scheme (light/dark forced; auto → the platform's prefers-color-scheme) and theme fonts. */
export function previewTokens(
  theme: Theme,
  prefersDark: boolean,
): { tokens: Record<string, string>; mode: ThemeMode; fontFaces: PreviewFontFace[] } {
  const mode = theme.mode ?? "auto";
  const scheme = mode === "dark" || (mode === "auto" && prefersDark) ? "dark" : "light";
  const entries = themeFonts(theme).flatMap((name) => fontEntry(name) ?? []);
  // A family without ₽ (Sofia Sans) takes it from RUBLE_FALLBACK_FONT, as fontFaceCss does: its latin-ext faces only.
  const fallback = entries.every(fontHasRuble) ? undefined : fontEntry(RUBLE_FALLBACK_FONT);
  const fontFaces = [
    ...entries.flatMap((f) => f.files.map((x) => ({ family: f.family, x }))),
    ...(fallback && !entries.includes(fallback)
      ? fallback.files.filter((x) => x.subset === "latin-ext").map((x) => ({ family: fallback.family, x }))
      : []),
  ].map(({ family, x }) => ({ family, weight: x.weight, file: x.file, unicodeRange: x.unicodeRange }));
  return { tokens: themeToTokens(theme, scheme), mode, fontFaces };
}

export const hexId = (hex: string): string => hex.replace("#", "").toLowerCase();
