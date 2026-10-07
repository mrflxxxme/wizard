// Theme presets v2 (specs/ui/themes.yaml, M2-42, B2-36, D69): ten looks with a font pair, neutrals, depth, rhythm,
// heading style, photo style and the theme graphic (placeholder of a picture until a photo is chosen). The owner sets
// one brand colour (theme.accent); shades and text colours derive from it with an AA contrast check (tokens.ts).
// Presets are drafts until the founder approves them (themes.yaml#status).
import type { THEME_PRESETS, Theme } from "@wizard/appspec";
import { V2_PRESETS } from "./presets-v2.js";

export type ThemePresetId = (typeof THEME_PRESETS)[number];

/** Neutral colours of one scheme; ink and muted keep ≥ 4.5:1 on bg, surface and surfaceAlt (tokens test). */
export interface ThemeNeutrals {
  bg: string;
  surface: string;
  /** Alternate section band (Features, Faq on a landing page). */
  surfaceAlt: string;
  ink: string;
  muted: string;
  line: string;
}

/** Pattern of the theme graphic, drawn from the brand colour (tokens.ts#graphicCss). */
export type ThemeGraphic = "arcs" | "grid" | "dots" | "stripes" | "wash";

export interface ThemePreset {
  id: ThemePresetId;
  /** Russian name for the owner (panel «Стиль»). */
  name: string;
  /** What the look is like, in plain Russian. */
  description: string;
  /** Niches it suits — the agent picks a preset by niche (themeForNiche). */
  niches: string[];
  defaults: {
    accent: string;
    font: NonNullable<Theme["font"]>;
    headingFont: NonNullable<Theme["headingFont"]>;
    radius: NonNullable<Theme["radius"]>;
    density: NonNullable<Theme["density"]>;
  };
  palette: { light: ThemeNeutrals; dark: ThemeNeutrals };
  /** flat — borders only; soft — light shadows; lifted — pronounced cards. */
  depth: "flat" | "soft" | "lifted";
  /**
   * Headings: weight, tracking; size — display scale (large for narrow or small-eyed faces, wide for wide ones;
   * default by the font); upper — short headings in capitals (condensed and poster faces).
   */
  heading: { weight: number; tracking: string; size?: "regular" | "large" | "wide"; upper?: boolean };
  /** Vertical rhythm of landing sections. */
  space: "regular" | "airy";
  /** Photo style for the stock search (B2-38) and the design agent, in plain Russian. */
  photoStyle: string;
  /** Theme graphic: the pattern of picture placeholders and decorative bands (--w-graphic). */
  graphic: ThemeGraphic;
  /** true until the founder approves the preset (themes.yaml#status). */
  draft: boolean;
}

export const THEME_PRESET_LIST: readonly ThemePreset[] = [
  {
    id: "strict",
    name: "Строгая деловая",
    description:
      "Сдержанные цвета, чёткая сетка, небольшие скругления. Вызывает доверие и не отвлекает от сути.",
    niches: [
      "юристы и нотариусы",
      "бухгалтерия и финансы",
      "консалтинг и B2B-услуги",
      "недвижимость и страхование",
      "производство и логистика",
      "CRM и внутренние инструменты",
    ],
    defaults: {
      accent: "#1F4FB8",
      font: "IBM Plex Sans",
      headingFont: "Manrope",
      radius: 4,
      density: "regular",
    },
    palette: {
      light: {
        bg: "#F5F6F8",
        surface: "#FFFFFF",
        surfaceAlt: "#EDEFF3",
        ink: "#111827",
        muted: "#4B5563",
        line: "#DDE1E7",
      },
      dark: {
        bg: "#0D1117",
        surface: "#161B22",
        surfaceAlt: "#1B212A",
        ink: "#E8ECF1",
        muted: "#A4ADB9",
        line: "#2A313C",
      },
    },
    depth: "soft",
    heading: { weight: 700, tracking: "-0.01em" },
    space: "regular",
    photoStyle: "деловая среда при дневном свете, сдержанные тона, люди за работой без постановки",
    graphic: "grid",
    draft: true,
  },
  {
    id: "warm",
    name: "Тёплая",
    description: "Мягкий кремовый фон, заголовки с засечками, большие скругления. Уютно и по-человечески.",
    niches: [
      "салоны красоты",
      "мастера маникюра и косметологи",
      "цветы и подарки",
      "ателье и рукоделие",
      "гостевые дома",
      "груминг и зоосалоны",
    ],
    defaults: { accent: "#A84B25", font: "Golos Text", headingFont: "Lora", radius: 16, density: "regular" },
    palette: {
      light: {
        bg: "#FBF6F0",
        surface: "#FFFFFF",
        surfaceAlt: "#F4EADF",
        ink: "#2A1E17",
        muted: "#6B5A4E",
        line: "#EADFD3",
      },
      dark: {
        bg: "#17120F",
        surface: "#211A15",
        surfaceAlt: "#2A211B",
        ink: "#F3EAE2",
        muted: "#BCA999",
        line: "#3A2E25",
      },
    },
    depth: "soft",
    heading: { weight: 700, tracking: "0" },
    space: "airy",
    photoStyle: "тёплый мягкий свет, руки мастера и детали работы, уютный интерьер",
    graphic: "arcs",
    draft: true,
  },
  {
    id: "bright",
    name: "Яркая современная",
    description: "Насыщенный цвет, крупные широкие заголовки, заметные карточки. Энергично и запоминается.",
    niches: [
      "фитнес, танцы и спорт",
      "детские студии и кружки",
      "детские лагеря",
      "квесты и развлечения",
      "игровые клубы",
      "молодёжные проекты",
    ],
    defaults: { accent: "#6D28D9", font: "Onest", headingFont: "Unbounded", radius: 12, density: "regular" },
    palette: {
      light: {
        bg: "#F7F5FF",
        surface: "#FFFFFF",
        surfaceAlt: "#EEE9FB",
        ink: "#16121F",
        muted: "#574F66",
        line: "#E1DCF0",
      },
      dark: {
        bg: "#0F0B17",
        surface: "#1A1426",
        surfaceAlt: "#211A30",
        ink: "#EEEAF7",
        muted: "#ABA3BC",
        line: "#2E2640",
      },
    },
    depth: "lifted",
    heading: { weight: 700, tracking: "-0.02em" },
    space: "regular",
    photoStyle: "движение и эмоции, насыщенный цвет, живые моменты занятий и событий",
    graphic: "dots",
    draft: true,
  },
  {
    id: "calm",
    name: "Спокойная минималистичная",
    description: "Много воздуха, приглушённые тона, тонкие линии вместо теней. Тихо и аккуратно.",
    niches: [
      "психологи и коучи",
      "йога и практики",
      "архитектура и дизайн интерьеров",
      "нутрициологи и здоровый образ жизни",
      "галереи и арт-студии",
      "ретриты",
    ],
    defaults: { accent: "#2F6B5A", font: "PT Sans", headingFont: "PT Serif", radius: 8, density: "regular" },
    palette: {
      light: {
        bg: "#F6F7F5",
        surface: "#FFFFFF",
        surfaceAlt: "#EDF0EC",
        ink: "#1B1F1D",
        muted: "#56605B",
        line: "#DFE4E0",
      },
      dark: {
        bg: "#0E1210",
        surface: "#161B18",
        surfaceAlt: "#1C221E",
        ink: "#E6EBE8",
        muted: "#A0ABA5",
        line: "#28302C",
      },
    },
    depth: "flat",
    heading: { weight: 700, tracking: "0" },
    space: "airy",
    photoStyle: "рассеянный свет, много воздуха, природные фактуры и спокойные интерьеры",
    graphic: "wash",
    draft: true,
  },
  ...V2_PRESETS,
];

/** Preset by id; undefined for an unknown or missing id. */
export function themePreset(id: string | undefined | null): ThemePreset | undefined {
  return id ? THEME_PRESET_LIST.find((p) => p.id === id) : undefined;
}
