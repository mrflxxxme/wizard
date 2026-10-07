// Light / dark choice of the platform v2 screens (B2-33, ui-kit.yaml#platform_v2): one stored choice shared with the
// canvas screen (screens/canvas reads the same key), «auto» — by prefers-color-scheme.
import type { PlatformThemeMode } from "@wizard/ui-kit/v2";
import { useEffect, useState } from "react";

/** localStorage key of the explicit choice; the canvas screen (B2-25) uses the same one. */
export const THEME_KEY = "wz.canvas.theme";

export function readThemeMode(): PlatformThemeMode {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function writeThemeMode(mode: PlatformThemeMode): void {
  try {
    if (mode === "auto") window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, mode);
  } catch {
    // Private mode: the choice lives for this tab.
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
}

/** True while the system asks for the dark scheme (follows changes). */
export function useDarkScheme(): boolean {
  const [dark, setDark] = useState(() => darkQuery()?.matches ?? false);
  useEffect(() => {
    const q = darkQuery();
    if (!q) return;
    const on = () => setDark(q.matches);
    q.addEventListener?.("change", on);
    return () => q.removeEventListener?.("change", on);
  }, []);
  return dark;
}

/** The scheme actually shown for a mode. */
export const isDark = (mode: PlatformThemeMode, systemDark: boolean): boolean =>
  mode === "dark" || (mode === "auto" && systemDark);
