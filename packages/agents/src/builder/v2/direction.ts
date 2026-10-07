// Design direction of the builder v2 (B2-37, builder.yaml#v2.stages.design): the deterministic half of the design
// agent. A direction is data, never CSS: mood, rhythm, voice of the texts, a catalog theme and font pair, the palette
// derived from the accent (the client's brand colour is never changed), the band and the ready layout of every
// landing section, the photo style for the stock search (B2-38). Here: theme defaults (layouts, voice, rhythm), the
// checks (themeLint without errors, ready variants only, contrast), the polish after a merge, the fallback
// (themeForNiche + the theme's layouts) and the diversity metric over several directions.
import { type DESIGN_VOICES, SECTION_CATALOG, type SectionTypeSpec, type SystemPlan } from "@wizard/appspec";
import { type ModuleRegistry, sectionBands } from "@wizard/modules";
import {
  accentInk,
  contrast,
  hexToOklch,
  type ThemePresetId,
  themeForNiche,
  themeLint,
  themePreset,
  themeToTokens,
} from "@wizard/ui-kit/themes";
import type { ToolIssue } from "../../core/tool.js";

export type DesignVoice = (typeof DESIGN_VOICES)[number];
type Rhythm = "airy" | "balanced" | "dense";

/** Voices of the section texts, in plain Russian (the prompt and the canvas). */
export const VOICE_LABELS: Readonly<Record<DesignVoice, string>> = {
  formal: "деловой: коротко, по фактам, на «вы»",
  warm: "тёплый: по-человечески, с заботой о госте",
  bold: "энергичный: короткие фразы, глаголы, призыв к действию",
  calm: "спокойный: мягко, без давления и восклицаний",
  friendly: "дружелюбный: просто, с примерами из жизни",
  refined: "сдержанный: немного слов, без превосходных степеней",
};

/** Voice and rhythm a theme suggests when the agent does not say otherwise. */
const THEME_VOICE: Readonly<Record<ThemePresetId, DesignVoice>> = {
  strict: "formal",
  warm: "warm",
  bright: "bold",
  calm: "calm",
  boutique: "refined",
  bistro: "warm",
  workshop: "bold",
  academy: "friendly",
  poster: "bold",
  care: "calm",
};
const THEME_RHYTHM: Readonly<Record<ThemePresetId, Rhythm>> = {
  strict: "balanced",
  warm: "airy",
  bright: "dense",
  calm: "airy",
  boutique: "airy",
  bistro: "balanced",
  workshop: "dense",
  academy: "balanced",
  poster: "dense",
  care: "airy",
};

/**
 * Layouts a theme prefers per section type (ready variants of the section library, design-agent-catalog.md#D1):
 * the first ready one is the theme's default, the next ones break a repeat of the neighbour's layout.
 */
const THEME_LAYOUTS: Readonly<Record<ThemePresetId, Readonly<Record<string, readonly string[]>>>> = {
  strict: {
    header: ["bar"],
    hero: ["split", "minimal"],
    features: ["grid", "icons"],
    steps: ["numbered", "timeline"],
    services: ["table", "list"],
    pricing: ["table", "compact"],
    booking: ["split", "card"],
    lead_form: ["split", "card"],
    gallery: ["grid"],
    team: ["list", "row"],
    testimonials: ["quote", "cards"],
    stats: ["row", "cards"],
    about: ["split", "centered"],
    faq: ["columns", "accordion"],
    cta: ["card", "split"],
    contacts: ["columns", "split"],
    hours: ["table", "inline"],
    logos: ["row", "grid"],
    text: ["two_columns", "plain"],
    footer: ["columns", "simple"],
  },
  warm: {
    header: ["centered", "bar"],
    hero: ["collage", "split"],
    features: ["cards", "alternating"],
    steps: ["cards", "timeline"],
    services: ["cards", "tabs"],
    pricing: ["cards", "compact"],
    booking: ["card", "split"],
    lead_form: ["card", "split"],
    gallery: ["masonry", "carousel"],
    team: ["cards", "row"],
    testimonials: ["cards", "carousel"],
    stats: ["cards", "row"],
    about: ["story", "split"],
    faq: ["accordion", "split"],
    cta: ["card", "band"],
    contacts: ["card", "split"],
    hours: ["cards", "inline"],
    logos: ["row"],
    text: ["quote", "plain"],
    footer: ["simple", "columns"],
  },
  bright: {
    header: ["bar", "transparent"],
    hero: ["cover", "split"],
    features: ["icons", "cards"],
    steps: ["cards", "numbered"],
    services: ["cards", "tabs"],
    pricing: ["cards", "table"],
    booking: ["inline", "card"],
    lead_form: ["inline", "card"],
    gallery: ["carousel", "grid"],
    team: ["row", "cards"],
    testimonials: ["carousel", "cards"],
    stats: ["band", "cards"],
    about: ["centered", "split"],
    faq: ["accordion", "columns"],
    cta: ["band", "card"],
    contacts: ["split", "card"],
    hours: ["inline", "cards"],
    logos: ["marquee", "row"],
    text: ["plain", "quote"],
    footer: ["minimal", "simple"],
  },
  calm: {
    header: ["transparent", "bar"],
    hero: ["minimal", "split"],
    features: ["alternating", "grid"],
    steps: ["timeline", "numbered"],
    services: ["list", "cards"],
    pricing: ["compact", "cards"],
    booking: ["split", "card"],
    lead_form: ["split", "card"],
    gallery: ["grid", "masonry"],
    team: ["row", "list"],
    testimonials: ["quote", "cards"],
    stats: ["row"],
    about: ["centered", "story"],
    faq: ["split", "accordion"],
    cta: ["split", "card"],
    contacts: ["split", "card"],
    hours: ["inline", "table"],
    logos: ["row"],
    text: ["plain", "quote"],
    footer: ["minimal", "simple"],
  },
  boutique: {
    header: ["centered", "transparent"],
    hero: ["cover", "minimal"],
    features: ["alternating", "grid"],
    steps: ["timeline", "numbered"],
    services: ["list", "table"],
    pricing: ["compact", "table"],
    booking: ["split", "card"],
    lead_form: ["split", "inline"],
    gallery: ["masonry", "grid"],
    team: ["row", "cards"],
    testimonials: ["quote", "carousel"],
    stats: ["row"],
    about: ["story", "centered"],
    faq: ["split", "accordion"],
    cta: ["split", "band"],
    contacts: ["columns", "split"],
    hours: ["inline", "table"],
    logos: ["row"],
    text: ["quote", "plain"],
    footer: ["minimal", "columns"],
  },
  bistro: {
    header: ["centered", "bar"],
    hero: ["collage", "cover"],
    features: ["cards", "icons"],
    steps: ["cards", "numbered"],
    services: ["tabs", "list"],
    pricing: ["table", "cards"],
    booking: ["split", "card"],
    lead_form: ["card", "split"],
    gallery: ["masonry", "carousel"],
    team: ["cards", "row"],
    testimonials: ["cards", "quote"],
    stats: ["cards", "row"],
    about: ["story", "split"],
    faq: ["accordion", "columns"],
    cta: ["band", "card"],
    contacts: ["split", "card"],
    hours: ["cards", "table"],
    logos: ["row"],
    text: ["plain", "quote"],
    footer: ["columns", "simple"],
  },
  workshop: {
    header: ["bar"],
    hero: ["split", "cover"],
    features: ["grid", "cards"],
    steps: ["numbered", "cards"],
    services: ["table", "list"],
    pricing: ["table", "compact"],
    booking: ["inline", "split"],
    lead_form: ["inline", "split"],
    gallery: ["grid", "carousel"],
    team: ["cards", "list"],
    testimonials: ["cards", "quote"],
    stats: ["band", "row"],
    about: ["split", "story"],
    faq: ["columns", "accordion"],
    cta: ["band", "split"],
    contacts: ["columns", "split"],
    hours: ["table", "inline"],
    logos: ["grid", "row"],
    text: ["two_columns", "plain"],
    footer: ["columns", "simple"],
  },
  academy: {
    header: ["bar", "centered"],
    hero: ["split", "centered"],
    features: ["icons", "cards"],
    steps: ["timeline", "cards"],
    services: ["cards", "tabs"],
    pricing: ["cards", "table"],
    booking: ["card", "split"],
    lead_form: ["card", "split"],
    gallery: ["carousel", "grid"],
    team: ["cards", "row"],
    testimonials: ["carousel", "cards"],
    stats: ["cards", "row"],
    about: ["split", "centered"],
    faq: ["accordion", "columns"],
    cta: ["card", "band"],
    contacts: ["card", "columns"],
    hours: ["cards", "table"],
    logos: ["row"],
    text: ["plain", "two_columns"],
    footer: ["simple", "columns"],
  },
  poster: {
    header: ["transparent", "bar"],
    hero: ["cover", "centered"],
    features: ["alternating", "icons"],
    steps: ["numbered", "timeline"],
    services: ["tabs", "table"],
    pricing: ["table", "cards"],
    booking: ["inline", "card"],
    lead_form: ["inline", "split"],
    gallery: ["carousel", "masonry"],
    team: ["row", "cards"],
    testimonials: ["quote", "carousel"],
    stats: ["band", "row"],
    about: ["centered", "story"],
    faq: ["columns", "accordion"],
    cta: ["band", "split"],
    contacts: ["split", "columns"],
    hours: ["inline", "table"],
    logos: ["marquee", "row"],
    text: ["quote", "plain"],
    footer: ["minimal", "columns"],
  },
  care: {
    header: ["bar", "centered"],
    hero: ["split", "centered"],
    features: ["icons", "grid"],
    steps: ["numbered", "timeline"],
    services: ["list", "table"],
    pricing: ["table", "compact"],
    booking: ["card", "split"],
    lead_form: ["card", "split"],
    gallery: ["grid"],
    team: ["cards", "list"],
    testimonials: ["quote", "cards"],
    stats: ["row", "cards"],
    about: ["split", "centered"],
    faq: ["accordion", "split"],
    cta: ["card", "split"],
    contacts: ["card", "columns"],
    hours: ["table", "cards"],
    logos: ["row"],
    text: ["plain", "two_columns"],
    footer: ["columns", "simple"],
  },
};

/** Faces made for headings only (design-agent-catalog.md#A6): never the body text. */
export const DISPLAY_ONLY_FONTS: ReadonlySet<string> = new Set([
  "Unbounded",
  "Cormorant Garamond",
  "Sofia Sans Extra Condensed",
  "Alumni Sans",
  "Wix Madefor Display",
]);

const isTheme = (t: string): t is ThemePresetId => t in THEME_LAYOUTS;
const specsOf = (registry: ModuleRegistry) =>
  new Map((registry.sections ?? SECTION_CATALOG).map((s) => [s.type, s]));

/** The client named the accent (brand colour): the design stage keeps it. */
export const brandAccent = (plan: SystemPlan): boolean => /фирменн/i.test(plan.design.direction.notes ?? "");

/** A design choice the design stage keeps: the brand colour, or what the owner set by hand (plan edits). */
export const keeps = (plan: SystemPlan, what: "theme" | "accent" | "fontPair"): boolean =>
  (what === "accent" && brandAccent(plan)) || (plan.design.pinned ?? []).includes(what);

/** Ready layouts of a section type in the theme's order of preference, then the rest of the ready ones. */
export function themeLayouts(theme: string, spec: SectionTypeSpec): string[] {
  const prefer = isTheme(theme) ? (THEME_LAYOUTS[theme][spec.type] ?? []) : [];
  return [...prefer.filter((v) => spec.ready.includes(v)), ...spec.ready.filter((v) => !prefer.includes(v))];
}

/** Voice and rhythm a theme suggests. */
export const themeVoice = (theme: string): DesignVoice => (isTheme(theme) ? THEME_VOICE[theme] : "formal");
export const themeRhythm = (theme: string): Rhythm => (isTheme(theme) ? THEME_RHYTHM[theme] : "balanced");

/** The theme of the plan design as AppSpec.theme (what the compiler writes and themeLint reads). */
const asTheme = (d: SystemPlan["design"]) => ({
  preset: d.theme as ThemePresetId,
  accent: d.accent,
  font: d.fontPair.body as never,
  headingFont: d.fontPair.heading as never,
});

/** Colour checks of an accent the agent picked (a brand colour is kept as is: the tokens derive safe shades). */
export function accentProblems(accent: string, theme: string): string[] {
  const out: string[] = [];
  const t = themeToTokens({ preset: theme as ThemePresetId, accent }, "light");
  const bg = t["--w-bg"] as string;
  if (contrast(accentInk(accent), accent) < 4.5)
    out.push(`надпись на кнопке цвета ${accent} читается плохо (контраст ниже 4,5:1)`);
  if (contrast(accent, bg) < 3) out.push(`кнопки цвета ${accent} сливаются с фоном темы (контраст ниже 3:1)`);
  if (hexToOklch(accent).c < 0.03) out.push(`цвет ${accent} почти серый — страница будет блёклой`);
  return out;
}

/**
 * Deterministic checks of a design (B2-37): themeLint without errors (unknown theme or font, the same face for
 * headings and text), heading-only faces not for the text, the contrast of an accent the agent picked. Notes
 * themeLint only explains (an adjusted shade of a brand colour) are not errors.
 */
export function designLintIssues(plan: SystemPlan, design: SystemPlan["design"]): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const lint = themeLint(asTheme(design));
  for (const n of lint) {
    if (n.code === "UNKNOWN_PRESET")
      issues.push({ path: "theme", code: "THEME_LINT", message: `${n.message}. Возьмите тему из списка.` });
    if (n.code === "UNKNOWN_FONT")
      issues.push({
        path: "fontPair",
        code: "THEME_LINT",
        message: `${n.message}. Возьмите шрифт из списка.`,
      });
    if (n.code === "SAME_DISPLAY_FONT" && !keeps(plan, "fontPair"))
      issues.push({
        path: "fontPair",
        code: "THEME_LINT",
        message: `${n.message}. Возьмите для заголовков другой шрифт с характером.`,
      });
  }
  if (DISPLAY_ONLY_FONTS.has(design.fontPair.body) && !keeps(plan, "fontPair"))
    issues.push({
      path: "fontPair.body",
      code: "DISPLAY_FONT_AS_BODY",
      message: `Шрифт «${design.fontPair.body}» — только для заголовков: длинный текст им читать тяжело. Возьмите для текста спокойный шрифт.`,
    });
  if (!keeps(plan, "accent"))
    for (const p of accentProblems(design.accent, design.theme))
      issues.push({
        path: "accent",
        code: "ACCENT_CONTRAST",
        message: `Акцент: ${p}. Возьмите цвет темнее и насыщеннее.`,
      });
  return issues;
}

/**
 * Polish after a merge (deterministic, no model): bands only on body sections; the same layout on two neighbouring
 * body sections (catalog L06) — the later one takes the next layout the theme prefers. Pinned sections stay.
 */
export function polishDirection(plan: SystemPlan, registry: ModuleRegistry): SystemPlan {
  if (!plan.landing) return plan;
  const specs = specsOf(registry);
  const bands = sectionBands(
    plan.landing.sections.map((s) => ({ type: s.type })),
    plan.design.direction.rhythm,
  );
  const sections = plan.landing.sections.map((s, i) => {
    const { band, ...rest } = s;
    return bands[i] === null || band === undefined ? rest : { ...rest, band };
  });
  for (let i = 1; i < sections.length; i++) {
    const prev = sections[i - 1];
    const s = sections[i];
    const spec = s && specs.get(s.type);
    if (!prev || !s || !spec || s.pinned || bands[i] === null || bands[i - 1] === null) continue;
    if (prev.variant !== s.variant) continue;
    const next = sections[i + 1]?.variant;
    const alt = themeLayouts(plan.design.theme, spec).find((v) => v !== prev.variant && v !== next);
    if (alt) sections[i] = { ...s, variant: alt };
  }
  return { ...plan, landing: { ...plan.landing, sections } };
}

/**
 * Fallback direction (the model failed or its answer did not pass): the theme by niche (themeForNiche), its font pair,
 * voice, rhythm and photo style, the theme's layouts; the brand colour and the owner's choices stay.
 */
export function fallbackDesign(plan: SystemPlan, registry: ModuleRegistry): SystemPlan {
  const theme = keeps(plan, "theme") ? plan.design.theme : themeForNiche(plan.niche);
  const preset = themePreset(theme);
  const themes = registry.themes;
  const usable = preset && (!themes || themes.includes(theme));
  if (!usable) return polishDirection(plan, registry);
  const specs = specsOf(registry);
  const accent = keeps(plan, "accent") ? plan.design.accent : preset.defaults.accent;
  const next: SystemPlan = {
    ...plan,
    design: {
      ...plan.design,
      direction: {
        ...plan.design.direction,
        rhythm: themeRhythm(theme),
        voice: themeVoice(theme),
      },
      theme,
      accent,
      fontPair: keeps(plan, "fontPair")
        ? plan.design.fontPair
        : { heading: preset.defaults.headingFont, body: preset.defaults.font },
      photoStyle: preset.photoStyle,
    },
  };
  if (plan.landing)
    next.landing = {
      ...plan.landing,
      sections: plan.landing.sections.map((s) => {
        const spec = specs.get(s.type);
        const { band: _b, ...rest } = s;
        return s.pinned || !spec ? s : { ...rest, variant: themeLayouts(theme, spec)[0] ?? s.variant };
      }),
    };
  return polishDirection(next, registry);
}

/** Palette of the direction from the accent (light scheme): what the tokens of the system derive. */
export interface DirectionPalette {
  accent: string;
  /** The accent as text on the page (darkened for AA when needed). */
  accentText: string;
  /** Text on the accent fill. */
  onAccent: string;
  bg: string;
  band: string;
  ink: string;
}

export function directionPalette(design: SystemPlan["design"]): DirectionPalette {
  const t = themeToTokens({ preset: design.theme as ThemePresetId, accent: design.accent }, "light");
  return {
    accent: design.accent,
    accentText: t["--w-accent-text"] as string,
    onAccent: t["--w-accent-ink"] as string,
    bg: t["--w-bg"] as string,
    band: t["--w-surface-alt"] as string,
    ink: t["--w-ink"] as string,
  };
}

/** The direction of a plan as data (the canvas, the report, the diversity metric). */
export interface DesignDirection {
  theme: string;
  themeName: string;
  mood: string[];
  rhythm: Rhythm;
  voice: DesignVoice;
  fonts: { heading: string; body: string };
  palette: DirectionPalette;
  photoStyle: string;
  /** Landing sections: type, ready layout, band (null — the section keeps its own background). */
  sections: { type: string; variant: string; band: "base" | "alt" | null }[];
}

export function designDirection(plan: SystemPlan): DesignDirection {
  const d = plan.design;
  const sections = plan.landing?.sections ?? [];
  const bands = sectionBands(sections, d.direction.rhythm);
  return {
    theme: d.theme,
    themeName: themePreset(d.theme)?.name ?? d.theme,
    mood: [...d.direction.mood],
    rhythm: d.direction.rhythm ?? "balanced",
    voice: d.direction.voice ?? themeVoice(d.theme),
    fonts: { ...d.fontPair },
    palette: directionPalette(d),
    photoStyle: d.photoStyle,
    sections: sections.map((s, i) => ({ type: s.type, variant: s.variant, band: bands[i] ?? null })),
  };
}

/** The combination the diversity metric compares: theme, font pair and the layouts of the sections in order. */
export const directionKey = (d: DesignDirection): string =>
  [d.theme, d.fonts.heading, d.fonts.body, d.sections.map((s) => `${s.type}:${s.variant}`).join(",")].join(
    "|",
  );

/**
 * Distance between two directions, 0…1: the mean of theme, heading font, body font, rhythm, voice (0 or 1 each) and
 * the layouts — the share of section types both pages have whose layout differs (1 when they share none).
 */
export function directionDistance(a: DesignDirection, b: DesignDirection): number {
  const layouts = (d: DesignDirection) => new Map(d.sections.map((s) => [s.type, s.variant]));
  const la = layouts(a);
  const lb = layouts(b);
  const common = [...la.keys()].filter((t) => lb.has(t));
  const layout = common.length ? common.filter((t) => la.get(t) !== lb.get(t)).length / common.length : 1;
  const parts = [
    a.theme !== b.theme,
    a.fonts.heading !== b.fonts.heading,
    a.fonts.body !== b.fonts.body,
    a.rhythm !== b.rhythm,
    a.voice !== b.voice,
  ].map(Number);
  return Math.round(((parts.reduce((s, x) => s + x, 0) + layout) / (parts.length + 1)) * 1000) / 1000;
}

/** Diversity of directions: unique combinations (theme + fonts + layouts), themes and pairwise distances. */
export interface DirectionDiversity {
  count: number;
  uniqueCombos: number;
  /** uniqueCombos / count — 1 means no two directions share theme, fonts and layouts at once. */
  comboShare: number;
  themes: number;
  layoutSets: number;
  minDistance: number;
  meanDistance: number;
}

export function directionDiversity(list: readonly DesignDirection[]): DirectionDiversity {
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const dists: number[] = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++)
      dists.push(directionDistance(list[i] as DesignDirection, list[j] as DesignDirection));
  const unique = new Set(list.map(directionKey)).size;
  return {
    count: list.length,
    uniqueCombos: unique,
    comboShare: list.length ? round(unique / list.length) : 0,
    themes: new Set(list.map((d) => d.theme)).size,
    layoutSets: new Set(list.map((d) => d.sections.map((s) => `${s.type}:${s.variant}`).join(","))).size,
    minDistance: dists.length ? Math.min(...dists) : 0,
    meanDistance: dists.length ? round(dists.reduce((s, x) => s + x, 0) / dists.length) : 0,
  };
}
