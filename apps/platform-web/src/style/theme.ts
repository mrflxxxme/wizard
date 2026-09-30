// «Стиль» (platform-screens.yaml S5): options of AppSpec.theme and tokens for apply-theme-tokens (ui-kit themeToTokens).
import { THEME_DEFAULTS, themeToTokens } from "@wizard/ui-kit";
import type { Theme } from "../api/types.js";

export const ACCENT_PRESETS = ["#2F46D8", "#C2410C", "#0A7D3E", "#9D174D"] as const;
export const FONTS = ["Onest", "Inter Tight", "Manrope", "PT Sans", "IBM Plex Sans"] as const;
export const RADII = [0, 4, 8, 12, 16] as const;
export const DENSITIES = ["compact", "regular"] as const;
export const MODES = ["light", "dark", "auto"] as const;
export const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

export type ThemeMode = (typeof MODES)[number];

export function withDefaults(theme: Theme | undefined | null): Required<Omit<Theme, "logoFile">> & Theme {
  return { ...THEME_DEFAULTS, ...(theme ?? {}) };
}

/** Tokens for the preview: one scheme (light/dark forced; auto → the platform's prefers-color-scheme). */
export function previewTokens(
  theme: Theme,
  prefersDark: boolean,
): { tokens: Record<string, string>; mode: ThemeMode } {
  const mode = theme.mode ?? THEME_DEFAULTS.mode;
  const scheme = mode === "dark" || (mode === "auto" && prefersDark) ? "dark" : "light";
  return { tokens: themeToTokens(theme, scheme), mode };
}

export const hexId = (hex: string): string => hex.replace("#", "").toLowerCase();
