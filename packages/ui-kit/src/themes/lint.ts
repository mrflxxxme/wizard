// themeLint (themes.yaml#lint): plain-Russian notes on a theme before it is saved or published. Tokens already keep AA
// contrast for any brand colour (tokens.ts); lint explains what the derivation changed so the owner is not surprised.
import type { Theme } from "@wizard/appspec";
import { contrast, hexToOklch } from "../tokens/color.js";
import { fontEntry } from "../tokens/fonts.js";
import { resolveTheme, type Scheme, themeToTokens } from "../tokens/tokens.js";
import { themePreset } from "./presets.js";

export type ThemeLintCode =
  | "UNKNOWN_PRESET"
  | "UNKNOWN_FONT"
  | "ACCENT_TEXT_ADJUSTED"
  | "ACCENT_LOW_EDGE"
  | "ACCENT_GREY"
  | "SAME_DISPLAY_FONT";

export interface ThemeLintNote {
  code: ThemeLintCode;
  message: string;
}

/** Notes on a theme; an empty list means nothing to explain. */
export function themeLint(theme: Theme | undefined | null): ThemeLintNote[] {
  const out: ThemeLintNote[] = [];
  if (theme?.preset && !themePreset(theme.preset))
    out.push({ code: "UNKNOWN_PRESET", message: `Темы «${theme.preset}» нет — будет базовая тема` });
  for (const f of [theme?.font, theme?.headingFont]) {
    if (f && !fontEntry(f))
      out.push({ code: "UNKNOWN_FONT", message: `Шрифта «${f}» нет в каталоге — будет системный шрифт` });
  }
  const r = resolveTheme(theme);
  const schemes: Scheme[] = r.mode === "auto" ? ["light", "dark"] : [r.mode];
  for (const scheme of schemes) {
    const t = themeToTokens(theme, scheme);
    const where = scheme === "light" ? "в светлой теме" : "в тёмной теме";
    if (t["--w-accent-text"] !== t["--w-accent"])
      out.push({
        code: "ACCENT_TEXT_ADJUSTED",
        message: `Фирменный цвет ${where} плохо читается как текст: для ссылок взят оттенок ${t["--w-accent-text"]}`,
      });
    if (contrast(t["--w-accent"] as string, t["--w-bg"] as string) < 3)
      out.push({
        code: "ACCENT_LOW_EDGE",
        message: `Кнопки фирменного цвета ${where} почти сливаются с фоном: у них будет контрастная рамка`,
      });
  }
  if (hexToOklch(r.accent).c < 0.03)
    out.push({
      code: "ACCENT_GREY",
      message: "Фирменный цвет почти серый — страница может выглядеть блёкло",
    });
  if (r.preset && r.headingFont === r.font && fontEntry(r.font)?.category !== "serif")
    out.push({
      code: "SAME_DISPLAY_FONT",
      message: "Заголовки и текст одним шрифтом: заголовки выделяются только размером и жирностью",
    });
  return out;
}
