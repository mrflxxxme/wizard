// designLint (builder-v3.md#C2): independent checks of a design system before it is shown or built — WCAG AA contrast
// of text, buttons, borders and focus in both schemes, Cyrillic in the fonts and no synthetic weights, banned defaults
// (Inter, display faces of the Runet monoculture, the «AI palette», cream page, pure black), the type scale, motion and
// the text measure (design-agent-catalog.md#B). themeLint (themes/lint.ts) runs on the AppSpec projection as well.
// Errors block the design system; warnings only explain.
import { themeLint } from "../../themes/lint.js";
import { blend, contrast, hexToOklch } from "../../tokens/color.js";
import { fontEntry } from "../../tokens/fonts.js";
import {
  cyrillicFace,
  DISPLAY_ONLY_FONTS,
  FORBIDDEN_FONTS,
  NEEDS_REASON_FONTS,
  NOT_DISPLAY_FONTS,
} from "./fonts.js";
import {
  type ColorRole,
  cssHex,
  isAiViolet,
  isCream,
  OVERLAY_ALPHA,
  parseOklch,
  type SchemeName,
  schemeHex,
} from "./palette.js";
import {
  type DesignSystemV3,
  DISPLAY_MAX_PX,
  designSystemTheme,
  SMALL_MIN_PX,
  TYPE_STEPS,
} from "./system.js";

export type DesignLintCode =
  | "UNKNOWN_FONT"
  | "NO_CYRILLIC"
  | "FORBIDDEN_FONT"
  | "DISPLAY_FONT_BANNED"
  | "DISPLAY_FONT_AS_TEXT"
  | "FONT_REASON_MISSING"
  | "THEME_LINT"
  | "TYPE_SCALE_FLAT"
  | "TYPE_STEP_RATIO"
  | "TYPE_SIZE"
  | "TYPE_TRACKING"
  | "TYPE_LEADING"
  | "PURE_BLACK"
  | "CREAM_BG"
  | "TEXT_CONTRAST"
  | "ACCENT_TEXT_CONTRAST"
  | "BUTTON_CONTRAST"
  | "BUTTON_EDGE"
  | "BORDER_CONTRAST"
  | "FOCUS_CONTRAST"
  | "STATUS_CONTRAST"
  | "OVERLAY_CONTRAST"
  | "AI_PALETTE"
  | "ACCENT_GREY"
  | "MOTION_OVERSHOOT"
  | "MOTION_TOO_LONG"
  | "MEASURE"
  | "GUTTER";

export interface DesignLintIssue {
  code: DesignLintCode;
  severity: "error" | "warn";
  /** Scheme of a colour issue. */
  scheme?: SchemeName;
  /** What is checked (token or role). */
  where: string;
  /** Plain Russian for the owner, the critic and the agent. */
  message: string;
}

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;
const fmt = (x: number) => x.toFixed(2).replace(".", ",");
const ROLE_RU: Partial<Record<ColorRole, string>> = {
  bg: "фон страницы",
  surface: "карточка",
  surfaceAlt: "полоса",
  accentSoft: "подложка акцента",
  ink: "основной текст",
  muted: "второстепенный текст",
  accentText: "акцент текстом",
};

/** y of the control points of a cubic-bezier() string; null for keywords. */
function bezierY(easing: string): [number, number] | null {
  const m = /cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(easing);
  return m ? [Number(m[2]), Number(m[4])] : null;
}

function fontIssues(ds: DesignSystemV3, out: DesignLintIssue[]): void {
  const roles = [
    ["display", ds.fonts.display.family, [ds.fonts.display.weight]],
    ["text", ds.fonts.text.family, [400, 700]],
  ] as const;
  for (const [role, family, weights] of roles) {
    const where = `fonts.${role}`;
    if (!fontEntry(family)) {
      out.push({
        code: "UNKNOWN_FONT",
        severity: "error",
        where,
        message: `Шрифта «${family}» нет в каталоге платформы: страница покажет системный шрифт`,
      });
      continue;
    }
    for (const w of weights)
      if (!cyrillicFace(family, w))
        out.push({
          code: "NO_CYRILLIC",
          severity: "error",
          where,
          message: `У шрифта «${family}» нет кириллицы начертания ${w}: буквы подставит браузер, жирный будет поддельным`,
        });
    if (FORBIDDEN_FONTS.has(family))
      out.push({
        code: "FORBIDDEN_FONT",
        severity: "error",
        where,
        message: `«${family}» — шрифт по умолчанию у моделей: с ним сайт выглядит как тысячи других`,
      });
  }
  if (NOT_DISPLAY_FONTS.has(ds.fonts.display.family))
    out.push({
      code: "DISPLAY_FONT_BANNED",
      severity: "error",
      where: "fonts.display",
      message: `«${ds.fonts.display.family}» в заголовках — примета шаблонного рунета: нужен шрифт с характером`,
    });
  if (DISPLAY_ONLY_FONTS.has(ds.fonts.text.family))
    out.push({
      code: "DISPLAY_FONT_AS_TEXT",
      severity: "error",
      where: "fonts.text",
      message: `«${ds.fonts.text.family}» — шрифт только для заголовков: длинный текст им читать тяжело`,
    });
  const needs = [ds.fonts.display.family, ds.fonts.text.family].filter((f) => NEEDS_REASON_FONTS.has(f));
  if (needs.length && !ds.fonts.why?.trim())
    out.push({
      code: "FONT_REASON_MISSING",
      severity: "error",
      where: "fonts.why",
      message: `«${needs.join("», «")}» — частый выбор моделей: нужна строка, почему именно он`,
    });
  for (const n of themeLint(designSystemTheme(ds)))
    if (n.code === "UNKNOWN_FONT" || n.code === "UNKNOWN_PRESET")
      out.push({ code: "THEME_LINT", severity: "error", where: "theme", message: n.message });
}

function typeIssues(ds: DesignSystemV3, out: DesignLintIssue[]): void {
  const t = ds.type.steps;
  if (t.display.max / t.base.max < 2.5)
    out.push({
      code: "TYPE_SCALE_FLAT",
      severity: "error",
      where: "type.display",
      message: "Заголовок первого экрана меньше основного текста в 2,5 раза: иерархии не видно",
    });
  for (let i = 1; i < TYPE_STEPS.length; i++) {
    const a = t[TYPE_STEPS[i - 1] as (typeof TYPE_STEPS)[number]];
    const b = t[TYPE_STEPS[i] as (typeof TYPE_STEPS)[number]];
    if (b.max / a.max < 1.19)
      out.push({
        code: "TYPE_STEP_RATIO",
        severity: "error",
        where: `type.${TYPE_STEPS[i]}`,
        message: "Соседние ступени шрифта почти одного размера: уровни заголовков не различаются",
      });
  }
  if (t.display.max > DISPLAY_MAX_PX)
    out.push({
      code: "TYPE_SIZE",
      severity: "error",
      where: "type.display",
      message: `Заголовок первого экрана больше ${DISPLAY_MAX_PX} px: он займёт весь экран`,
    });
  if (t.sm.min < SMALL_MIN_PX || t.base.min < 16)
    out.push({
      code: "TYPE_SIZE",
      severity: "error",
      where: "type.base",
      message: "Текст на телефоне мельче 16 px (подписи мельче 13 px): читать тяжело",
    });
  for (const s of TYPE_STEPS) {
    if (Number.parseFloat(t[s].tracking) <= -0.05)
      out.push({
        code: "TYPE_TRACKING",
        severity: "error",
        where: `type.${s}`,
        message: "Слишком плотная разрядка: кириллические буквы слипаются",
      });
  }
  if (t.base.lineHeight < 1.5 || t.display.lineHeight < 1.08)
    out.push({
      code: "TYPE_LEADING",
      severity: "error",
      where: "type.base",
      message: "Тесный интерлиньяж: строки наползают, у «д», «й», «ё» обрезаются выносные",
    });
}

function contrastIssue(
  out: DesignLintIssue[],
  code: DesignLintCode,
  scheme: SchemeName,
  where: string,
  ratio: number,
  min: number,
  what: string,
): void {
  if (ratio >= min) return;
  const ru = scheme === "light" ? "в светлой теме" : "в тёмной теме";
  out.push({
    code,
    severity: "error",
    scheme,
    where,
    message: `${what} ${ru}: контраст ${fmt(ratio)}:1, нужно не меньше ${fmt(min)}:1`,
  });
}

function colorIssues(ds: DesignSystemV3, scheme: SchemeName, out: DesignLintIssue[]): void {
  const h = schemeHex(ds.palette[scheme]);
  const backs: ColorRole[] = ["bg", "surface", "surfaceAlt", "accentSoft"];
  for (const role of ["bg", "surface", "surfaceAlt", "ink", "muted"] as const)
    if (h[role] === "#000000")
      out.push({
        code: "PURE_BLACK",
        severity: "error",
        scheme,
        where: `palette.${scheme}.${role}`,
        message: "Чистый чёрный режет глаз: нужен почти чёрный из палитры",
      });
  if (scheme === "light")
    for (const role of ["bg", "surface", "surfaceAlt"] as const)
      if (isCream(h[role]))
        out.push({
          code: "CREAM_BG",
          severity: "error",
          scheme,
          where: `palette.light.${role}`,
          message: "Кремовый фон — примета шаблонных сайтов: нужен фон из палитры направления",
        });
  for (const fg of ["ink", "muted", "accentText"] as const)
    for (const bg of backs)
      contrastIssue(
        out,
        fg === "accentText" ? "ACCENT_TEXT_CONTRAST" : "TEXT_CONTRAST",
        scheme,
        `palette.${scheme}.${fg}/${bg}`,
        contrast(h[fg], h[bg]),
        AA_TEXT,
        `${ROLE_RU[fg]} на фоне «${ROLE_RU[bg]}»`,
      );
  contrastIssue(
    out,
    "BUTTON_CONTRAST",
    scheme,
    `palette.${scheme}.accentInk`,
    Math.min(contrast(h.accentInk, h.accent), contrast(h.accentInk, h.accentStrong)),
    AA_TEXT,
    "Надпись на кнопке",
  );
  contrastIssue(
    out,
    "BUTTON_CONTRAST",
    scheme,
    `palette.${scheme}.accent2Ink`,
    contrast(h.accent2Ink, h.accent2),
    AA_TEXT,
    "Надпись на втором цвете",
  );
  for (const bg of ["bg", "surface"] as const) {
    contrastIssue(
      out,
      "BUTTON_EDGE",
      scheme,
      `palette.${scheme}.accentEdge/${bg}`,
      contrast(h.accentEdge, h[bg]),
      AA_NON_TEXT,
      "Край кнопки",
    );
    contrastIssue(
      out,
      "BORDER_CONTRAST",
      scheme,
      `palette.${scheme}.border/${bg}`,
      contrast(h.border, h[bg]),
      AA_NON_TEXT,
      "Рамка поля ввода",
    );
    contrastIssue(
      out,
      "FOCUS_CONTRAST",
      scheme,
      `palette.${scheme}.focus/${bg}`,
      contrast(h.focus, h[bg]),
      AA_NON_TEXT,
      "Рамка фокуса",
    );
  }
  for (const s of ["ok", "warn", "bad"] as const)
    for (const bg of ["bg", "surface", "surfaceAlt"] as const)
      contrastIssue(
        out,
        "STATUS_CONTRAST",
        scheme,
        `palette.${scheme}.${s}/${bg}`,
        contrast(h[s], h[bg]),
        AA_TEXT,
        "Цвет статуса",
      );
  // Text on a photo sits on the scrim: checked over the brightest photo (white).
  const alpha = parseOklch(ds.palette[scheme].overlay)?.alpha ?? OVERLAY_ALPHA;
  contrastIssue(
    out,
    "OVERLAY_CONTRAST",
    scheme,
    `palette.${scheme}.overlay`,
    contrast(h.overlayInk, blend(h.overlay, "#FFFFFF", alpha)),
    AA_TEXT,
    "Текст на фото с подложкой",
  );
}

function paletteIssues(ds: DesignSystemV3, out: DesignLintIssue[]): void {
  const p = ds.palette;
  const deg = (hex: string) => {
    const o = hexToOklch(hex);
    return { h: ((((o.h * 180) / Math.PI) % 360) + 360) % 360, c: o.c };
  };
  const a = deg(cssHex(p.light.accent));
  const a2 = deg(cssHex(p.light.accent2));
  const cyan = (x: { h: number; c: number }) => x.c >= 0.06 && x.h >= 160 && x.h <= 200;
  const violet = (x: { h: number; c: number }) => isAiViolet(x.h, x.c);
  const pairAi =
    p.light.accent2 !== p.light.accent && (violet(a) || violet(a2)) && (violet(a2) || cyan(a2) || cyan(a));
  if (p.source === "archetype" && (violet(a) || pairAi))
    out.push({
      code: "AI_PALETTE",
      severity: "error",
      where: "palette.accent",
      message: "Фиолетовый акцент или пара «фиолетовый — циан» — примета сайтов, собранных ИИ по умолчанию",
    });
  else if (p.source === "brand" && pairAi)
    out.push({
      code: "AI_PALETTE",
      severity: "warn",
      where: "palette.accent2",
      message: "Второй цвет вместе с фирменным даёт пару «фиолетовый — циан»: градиентов из них не делаем",
    });
  if (a.c < 0.03)
    out.push({
      code: "ACCENT_GREY",
      severity: "warn",
      where: "palette.accent",
      message: "Фирменный цвет почти серый: характер странице дадут шрифт, сетка и фото",
    });
}

function motionIssues(ds: DesignSystemV3, out: DesignLintIssue[]): void {
  const m = ds.motion;
  for (const [name, easing] of Object.entries(m.easing)) {
    const y = bezierY(easing);
    if (y?.some((v) => v < 0 || v > 1))
      out.push({
        code: "MOTION_OVERSHOOT",
        severity: "error",
        where: `motion.easing.${name}`,
        message: "Пружинящая кривая движения выглядит дёшево и отвлекает",
      });
  }
  const d = m.durations;
  if (Math.max(d.state, d.element, d.overlay) > 320 || d.hero > 600 || d.reveal > 400)
    out.push({
      code: "MOTION_TOO_LONG",
      severity: "error",
      where: "motion.durations",
      message: "Анимации дольше 320 мс (вход первого экрана — 600 мс) заставляют ждать",
    });
}

function gridIssues(ds: DesignSystemV3, out: DesignLintIssue[]): void {
  if (ds.grid.measure < 40 || ds.grid.measure > 75)
    out.push({
      code: "MEASURE",
      severity: "error",
      where: "grid.measure",
      message: "Строка текста короче 40 или длиннее 75 знаков: читать неудобно",
    });
  if (ds.grid.gutter.mobile < 16)
    out.push({
      code: "GUTTER",
      severity: "error",
      where: "grid.gutter",
      message: "Поля на телефоне меньше 16 px: текст прилипает к краю экрана",
    });
}

/** Issues of a design system in both schemes; no error means it can be shown and built. */
export function designLint(ds: DesignSystemV3): DesignLintIssue[] {
  const out: DesignLintIssue[] = [];
  fontIssues(ds, out);
  typeIssues(ds, out);
  for (const scheme of ["light", "dark"] as const) colorIssues(ds, scheme, out);
  paletteIssues(ds, out);
  motionIssues(ds, out);
  gridIssues(ds, out);
  return out;
}

/** Only the blocking issues of designLint. */
export const designLintErrors = (ds: DesignSystemV3): DesignLintIssue[] =>
  designLint(ds).filter((i) => i.severity === "error");
