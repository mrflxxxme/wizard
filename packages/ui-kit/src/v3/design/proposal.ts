// V4-07 (D79, grill-9 §3 «Арт-директор на модели»): the model proposes the design system — palette, a font pair of the
// self-hosted OFL catalog, type scale, grid, rhythm, motion and imagery; code checks it (WCAG AA contrast, licences and
// Cyrillic of the fonts, banned defaults, tokens) and sends issues back for a fix, but never chooses for the model.
// designFromProposal turns an accepted proposal into a DesignSystemV3 (the same tokens, CSS and lint as the archetypes);
// pickDistinct takes the most different directions of a verbalized-sampling answer.
import { accentInk } from "../../tokens/accent.js";
import { contrast, hexToOklch, oklchToHex } from "../../tokens/color.js";
import { FONT_CATALOG, fontEntry } from "../../tokens/fonts.js";
import {
  ARCHETYPE_IDS,
  type ArchetypeId,
  archetype as archetypeById,
  type Density,
  type DesignVoice,
  type GridLayout,
  type ImageTreatment,
  type MotionProfile,
  type PaletteRules,
  type RadiusSetId,
  type TypeScaleId,
} from "./archetypes.js";
import { designDistance } from "./diversity.js";
import {
  cyrillicFace,
  DISPLAY_ONLY_FONTS,
  FORBIDDEN_FONTS,
  NEEDS_REASON_FONTS,
  NOT_DISPLAY_FONTS,
} from "./fonts.js";
import { designLint } from "./lint.js";
import {
  buildPalette,
  isAiViolet,
  isCream,
  normalizeBrand,
  oklchCss,
  type PaletteScheme,
  type PaletteV3,
  quantize,
  type SchemeName,
  schemeHex,
  stepToContrast,
} from "./palette.js";
import {
  type DesignSystemV3,
  designSystemV3,
  font,
  GUTTER,
  IMAGE_FILTERS,
  motion,
  RADIUS_SETS,
  SECTION_SPACE,
  typeScale,
} from "./system.js";

export const PROPOSAL_SCALES = ["calm", "classic", "dramatic"] as const satisfies readonly TypeScaleId[];
export const PROPOSAL_RADII = ["sharp", "crisp", "soft", "round"] as const satisfies readonly RadiusSetId[];
export const PROPOSAL_DENSITIES = ["compact", "regular", "airy"] as const satisfies readonly Density[];
export const PROPOSAL_LAYOUTS = [
  "symmetric",
  "asymmetric",
  "modular",
  "centered",
  "split",
] as const satisfies readonly GridLayout[];
export const PROPOSAL_MOTIONS = ["still", "calm", "lively"] as const satisfies readonly MotionProfile[];
export const PROPOSAL_TREATMENTS = [
  "natural",
  "warm-grade",
  "soft-grade",
  "high-contrast",
  "monochrome",
] as const satisfies readonly ImageTreatment[];

/** One direction proposed by the model (the tool answer of the art director, V4-07). */
export interface DesignProposal {
  /** Russian name of the direction for the owner. */
  name: string;
  /** Why it fits the business, in Russian. */
  why: string;
  /** Verbalized sampling: how typical the model finds this direction for the brief, 0…1. */
  probability: number;
  /** The closest archetype: structure defaults the proposal does not set (columns, measure, image frame). */
  base: ArchetypeId;
  scheme: SchemeName;
  /** 3–5 colours of the starting scheme, #RRGGBB: page, text, accent and an optional second accent. */
  colors: { bg: string; ink: string; accent: string; accent2?: string };
  /** `why` — required for the faces models default to (fonts.ts NEEDS_REASON_FONTS): why exactly this face. */
  fonts: { display: string; text: string; why?: string };
  type: { scale: TypeScaleId; upper: boolean };
  radius: RadiusSetId;
  density: Density;
  layout: GridLayout;
  motion: MotionProfile;
  imagery: { style: string; treatment: ImageTreatment };
}

export interface ProposalIssue {
  /** Path of the field in the proposal (colors.ink, fonts.display…). */
  path: string;
  code: string;
  /** Plain Russian for the model: what is wrong and what would pass. */
  message: string;
}

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;
const HEX = /^#[0-9a-f]{6}$/i;
const fmt = (x: number) => x.toFixed(2).replace(".", ",");
const DEG = 180 / Math.PI;

/** Families a proposal may use: the self-hosted catalog with a free licence and Cyrillic at 400 and 700. */
export function proposalFonts(): { display: string[]; text: string[] } {
  const ok = FONT_CATALOG.filter(
    (f) =>
      /^(OFL-1\.1|Apache-2\.0)$/.test(f.license) &&
      !FORBIDDEN_FONTS.has(f.family) &&
      cyrillicFace(f.family, 400) &&
      cyrillicFace(f.family, 700),
  ).map((f) => f.family);
  return {
    display: ok.filter((f) => !NOT_DISPLAY_FONTS.has(f)),
    text: ok.filter((f) => !DISPLAY_ONLY_FONTS.has(f)),
  };
}

const hue = (hex: string) => {
  const o = hexToOklch(hex);
  return { l: o.l, c: o.c, h: ((((o.h * DEG) % 360) + 360) % 360) as number };
};

/**
 * Checks of a proposal before it becomes tokens: fonts of the catalog (licence, Cyrillic, roles), WCAG AA of the text
 * and the accent on the page, the scheme matching the page, no cream page, no «AI violet», the brand colour kept as
 * the accent; then designLint errors of the resulting system. Empty — the proposal is accepted as is.
 */
export function proposalIssues(
  p: DesignProposal,
  o: { brandColor?: string; seed?: string | number; niche?: string } = {},
): ProposalIssue[] {
  const out: ProposalIssue[] = [];
  const fonts = proposalFonts();
  if (!fonts.display.includes(p.fonts.display))
    out.push({
      path: "fonts.display",
      code: fontEntry(p.fonts.display) ? "DISPLAY_FONT_BANNED" : "UNKNOWN_FONT",
      message: `Шрифт заголовков «${p.fonts.display}» не подходит: возьмите один из ${fonts.display.join(", ")}.`,
    });
  if (!fonts.text.includes(p.fonts.text))
    out.push({
      path: "fonts.text",
      code: fontEntry(p.fonts.text) ? "TEXT_FONT_BANNED" : "UNKNOWN_FONT",
      message: `Шрифт текста «${p.fonts.text}» не подходит: возьмите один из ${fonts.text.join(", ")}.`,
    });
  const colors = Object.entries(p.colors).filter(([, v]) => v !== undefined) as [string, string][];
  const bad = colors.filter(([, v]) => !HEX.test(v));
  for (const [k, v] of bad)
    out.push({ path: `colors.${k}`, code: "BAD_COLOR", message: `Цвет ${k} «${v}» — не #RRGGBB.` });
  if (bad.length) return out;
  const { bg, ink, accent, accent2 } = p.colors;
  const textRatio = contrast(ink, bg);
  if (textRatio < AA_TEXT)
    out.push({
      path: "colors.ink",
      code: "TEXT_CONTRAST",
      message: `Контраст текста ${ink} на фоне ${bg} — ${fmt(textRatio)}:1, нужно не меньше 4,5:1 (WCAG AA). Сделайте текст ${p.scheme === "light" ? "темнее" : "светлее"}.`,
    });
  const accentRatio = contrast(accent, bg);
  if (accentRatio < AA_NON_TEXT)
    out.push({
      path: "colors.accent",
      code: "ACCENT_CONTRAST",
      message: `Акцент ${accent} на фоне ${bg} — ${fmt(accentRatio)}:1, кнопке нужно не меньше 3:1. Возьмите акцент насыщеннее или ${p.scheme === "light" ? "темнее" : "светлее"}.`,
    });
  const page = hue(bg);
  if ((p.scheme === "light") !== page.l >= 0.6)
    out.push({
      path: "scheme",
      code: "SCHEME_MISMATCH",
      message: `Схема ${p.scheme}, а фон ${bg} ${page.l >= 0.6 ? "светлый" : "тёмный"}: согласуйте схему и фон.`,
    });
  if (p.scheme === "light" && isCream(bg))
    out.push({
      path: "colors.bg",
      code: "CREAM_BG",
      message: `Фон ${bg} — кремовый, это шаблон ИИ-сайтов. Возьмите чистый светлый или окрашенный под направление фон.`,
    });
  const brand = normalizeBrand(o.brandColor);
  for (const [k, v] of [
    ["accent", accent],
    ["accent2", accent2],
  ] as const) {
    if (!v || (brand && v.toUpperCase() === brand)) continue;
    const a = hue(v);
    if (isAiViolet(a.h, a.c))
      out.push({
        path: `colors.${k}`,
        code: "AI_PALETTE",
        message: `${v} — фиолетовый «ИИ-палитры»; без фирменного фиолетового он не нужен. Возьмите другой тон.`,
      });
  }
  if (brand && accent.toUpperCase() !== brand && accent2?.toUpperCase() !== brand)
    out.push({
      path: "colors.accent",
      code: "BRAND_COLOR",
      message: `Фирменный цвет клиента ${brand} не меняется: он должен быть акцентом (accent) или вторым акцентом (accent2).`,
    });
  if (out.length) return out;
  const ds = designFromProposal(p, {
    seed: o.seed ?? 1,
    niche: o.niche ?? "",
    ...(brand ? { brandColor: brand } : {}),
  });
  for (const i of designLint(ds))
    if (i.severity === "error")
      out.push({ path: i.where, code: i.code, message: `${i.message}${i.scheme ? ` (${i.scheme})` : ""}` });
  return out;
}

/**
 * V4-17: deterministic fixes of a proposal before its check — what code can mend without changing the idea: a face
 * outside the catalog → the catalog's nearest of the same kind (serif or sans); the scheme to match the page; a cream
 * page → a clean one of the same hue; the text and the accent stepped to AA on the page; «AI violet» turned away from
 * violet; the client's brand colour as the accent. What it cannot mend (texts, lint of the system) stays for the
 * model's repair. `fixed` names what was changed (paths).
 */
export function autofixProposal(
  p: DesignProposal,
  o: { brandColor?: string } = {},
): { proposal: DesignProposal; fixed: string[] } {
  const fixed: string[] = [];
  const fonts = proposalFonts();
  const nearest = (family: string, list: readonly string[]) => {
    const kind = fontEntry(family)?.category;
    return (
      list.find((f) => !NEEDS_REASON_FONTS.has(f) && fontEntry(f)?.category === kind) ??
      list.find((f) => !NEEDS_REASON_FONTS.has(f)) ??
      (list[0] as string)
    );
  };
  const f = { ...p.fonts };
  if (!fonts.display.includes(f.display)) {
    f.display = nearest(f.display, fonts.display);
    fixed.push("fonts.display");
  }
  if (!fonts.text.includes(f.text)) {
    f.text = nearest(f.text, fonts.text);
    fixed.push("fonts.text");
  }
  const c = { ...p.colors };
  if (![c.bg, c.ink, c.accent, ...(c.accent2 ? [c.accent2] : [])].every((v) => HEX.test(v)))
    return { proposal: { ...p, fonts: f }, fixed };
  let scheme = p.scheme;
  const page = hue(c.bg);
  if ((scheme === "light") !== page.l >= 0.6) {
    scheme = page.l >= 0.6 ? "light" : "dark";
    fixed.push("scheme");
  }
  if (scheme === "light" && isCream(c.bg)) {
    // The same hue, almost no chroma: a clean light page.
    c.bg = quantize(oklchToHex({ l: Math.max(0.97, page.l), c: Math.min(0.003, page.c), h: page.h / DEG }));
    fixed.push("colors.bg");
  }
  const brand = normalizeBrand(o.brandColor);
  if (brand && c.accent.toUpperCase() !== brand && c.accent2?.toUpperCase() !== brand) {
    c.accent = brand;
    fixed.push("colors.accent");
  }
  for (const k of ["accent", "accent2"] as const) {
    const v = c[k];
    if (!v || (brand && v.toUpperCase() === brand)) continue;
    const a = hue(v);
    if (isAiViolet(a.h, a.c)) {
      // Turned well out of 260–310° (the system derives its own shades of it): to blue below or to rose above.
      const h = a.h - 260 < 310 - a.h ? 225 : 345;
      c[k] = quantize(oklchToHex({ l: a.l, c: a.c, h: h / DEG }));
      fixed.push(`colors.${k}`);
    }
  }
  if (contrast(c.ink, c.bg) < AA_TEXT) {
    c.ink = stepToContrast(c.ink, [c.bg], AA_TEXT, scheme);
    fixed.push("colors.ink");
  }
  if (contrast(c.accent, c.bg) < AA_NON_TEXT && !(brand && c.accent.toUpperCase() === brand)) {
    c.accent = stepToContrast(c.accent, [c.bg], AA_NON_TEXT, scheme);
    fixed.push("colors.accent");
  }
  return { proposal: { ...p, scheme, colors: c, fonts: f }, fixed };
}

/** Palette rules of a proposal: the page's hue, chroma and lightness, the base archetype's bands and second colour. */
export function proposalPaletteRules(p: DesignProposal): PaletteRules {
  const a = archetypeById(p.base);
  if (!a) throw new Error(`Unknown archetype: ${p.base}`);
  const page = hue(p.colors.bg);
  const neutralC = Math.min(0.04, page.c);
  return {
    ...a.palette,
    neutralHue: neutralC >= 0.004 ? page.h : a.palette.neutralHue,
    neutralC,
    bgL: {
      light: p.scheme === "light" ? page.l : Math.max(a.palette.bgL.light, 0.96),
      dark: p.scheme === "dark" ? page.l : Math.min(a.palette.bgL.dark, 0.2),
    },
    scheme: p.scheme,
    ...(p.colors.accent2 ? { accent2: "none" as const } : {}),
  };
}

/** The proposal's own colours over a computed scheme where they keep AA (the page, the text, the second accent). */
function withOwnColors(s: PaletteScheme, p: DesignProposal, scheme: SchemeName): PaletteScheme {
  const hex = schemeHex(s);
  const out = { ...s };
  if (scheme === p.scheme) {
    const backs = [quantize(p.colors.bg), hex.surface, hex.surfaceAlt, hex.accentSoft];
    const ink = quantize(p.colors.ink);
    if (backs.every((b) => contrast(ink, b) >= AA_TEXT)) out.ink = oklchCss(ink);
  }
  if (p.colors.accent2) {
    const a2 = stepToContrast(p.colors.accent2, [hex.bg, hex.surface], AA_NON_TEXT, scheme);
    out.accent2 = oklchCss(a2);
    out.accent2Ink = oklchCss(quantize(accentInk(a2)));
  }
  return out;
}

/**
 * The design system of an accepted proposal: the base archetype's system with the proposal's palette (its page, text
 * and accents; the derived roles by the palette rules, AA by construction), fonts, scale, radius, rhythm, layout,
 * motion and imagery. `brandColor` — the client's colour (palette.source "brand").
 */
export function designFromProposal(
  p: DesignProposal,
  o: { seed: string | number; niche: string; brandColor?: string; voice?: DesignVoice },
): DesignSystemV3 {
  const a = archetypeById(p.base);
  if (!a) throw new Error(`Unknown archetype: ${p.base}`);
  const base = designSystemV3({
    archetype: p.base,
    seed: o.seed,
    niche: o.niche,
    ...(o.voice ? { voice: o.voice } : {}),
  });
  const brand = normalizeBrand(o.brandColor);
  const built = buildPalette({
    rules: proposalPaletteRules(p),
    brandColor: p.colors.accent,
    seed: base.seed,
    key: `${p.base}|${base.niche.toLowerCase()}|proposal`,
  });
  const palette: PaletteV3 = {
    source: brand ? "brand" : "archetype",
    ...(brand ? { brandColor: brand } : {}),
    scheme: p.scheme,
    accentUse: built.accentUse,
    light: withOwnColors(built.light, p, "light"),
    dark: withOwnColors(built.dark, p, "dark"),
  };
  const [sm, md, lg] = RADIUS_SETS[p.radius];
  return {
    ...base,
    name: p.name,
    fonts: {
      display: font(p.fonts.display, a.displayWeight),
      text: font(p.fonts.text, 400),
      ...(p.fonts.why ? { why: p.fonts.why } : {}),
    },
    palette,
    type: typeScale(p.type.scale, p.type.upper, a.tracking),
    radius: { set: p.radius, sm, md, lg, control: a.controls === "pill" ? 999 : md },
    grid: {
      ...base.grid,
      layout: p.layout,
      gutter: { ...GUTTER[p.density] },
      rhythm: { density: p.density, section: { ...SECTION_SPACE[p.density] } },
    },
    motion: motion(p.motion, a.motion.entrance, a.motion.hover),
    imagery: {
      ...base.imagery,
      style: p.imagery.style,
      treatment: p.imagery.treatment,
      filter: IMAGE_FILTERS[p.imagery.treatment],
    },
  };
}

/**
 * Verbalized sampling: of k proposed directions take `n` that differ most — the likeliest first, then each time the one
 * farthest (max of the min designDistance) from those taken; ties go to the less typical (lower probability). `key` —
 * a property no two taken may share (the base archetype); fewer than `n` when the list runs out.
 */
export function pickDistinct<T extends { design: DesignSystemV3; probability: number }>(
  list: readonly T[],
  n = 3,
  key?: (x: T) => string,
): T[] {
  const sorted = [...list].sort((x, y) => y.probability - x.probability);
  if (sorted.length === 0) return [];
  const taken: T[] = [sorted[0] as T];
  while (taken.length < n) {
    let best: T | undefined;
    let bestD = -1;
    const keys = new Set(key ? taken.map(key) : []);
    for (const c of sorted) {
      if (taken.includes(c) || (key && keys.has(key(c)))) continue;
      const d = Math.min(...taken.map((t) => designDistance(t.design, c.design)));
      if (d > bestD + 1e-9 || (Math.abs(d - bestD) <= 1e-9 && best && c.probability < best.probability)) {
        best = c;
        bestD = d;
      }
    }
    if (!best) break;
    taken.push(best);
  }
  return taken;
}

/** Archetype ids a proposal may name as its base. */
export const PROPOSAL_BASES: readonly ArchetypeId[] = ARCHETYPE_IDS;
