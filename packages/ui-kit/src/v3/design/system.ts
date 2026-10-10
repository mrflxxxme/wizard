// designSystemV3 (builder-v3.md#C2): the client's design system from an archetype, the brand colour and a seed — a pure
// deterministic function without a model. Fonts (D64 catalog pairs), the OKLCH palette (palette.ts), the fluid type
// scale, spacing, radius, grid and rhythm, motion and imagery (design-agent-catalog.md#E1–E3). The CSS and the Tailwind
// theme come from css.ts, the checks from lint.ts.
import type { Theme } from "@wizard/appspec";
import { fontStack } from "../../tokens/fonts.js";
import {
  type AccentUse,
  type ArchetypeId,
  archetype as archetypeById,
  type Density,
  type Depth,
  type DesignVoice,
  type GridLayout,
  type ImageFrame,
  type ImageRatio,
  type ImageTreatment,
  type MotionEntrance,
  type MotionHover,
  type MotionProfile,
  type RadiusSetId,
  type TypeScaleId,
} from "./archetypes.js";
import { buildPalette, cssHex, type PaletteV3 } from "./palette.js";
import { pick, rng } from "./random.js";

export const TYPE_STEPS = ["sm", "base", "lg", "xl", "2xl", "3xl", "display"] as const;
export type TypeStep = (typeof TYPE_STEPS)[number];

export interface TypeStepTokens {
  /** px at 360 and 1280 px viewports. */
  min: number;
  max: number;
  /** Fluid `clamp()` between 360 and 1280 px. */
  size: string;
  lineHeight: number;
  /** letter-spacing, em. */
  tracking: string;
}

export interface FontChoice {
  family: string;
  weight: number;
  /** CSS font-family stack (the family, then system fonts of the same kind). */
  stack: string;
}

export interface DesignSystemV3 {
  version: 3;
  archetype: ArchetypeId;
  /** Russian name of the direction. */
  name: string;
  seed: string;
  niche: string;
  voice: DesignVoice;
  fonts: { display: FontChoice; text: FontChoice; why?: string };
  palette: PaletteV3;
  type: {
    scale: TypeScaleId;
    ratio: number;
    upper: boolean;
    steps: Record<TypeStep, TypeStepTokens>;
  };
  space: { unit: number; scale: readonly number[] };
  radius: { set: RadiusSetId; sm: number; md: number; lg: number; control: number };
  grid: {
    columns: number;
    maxWidth: number;
    /** Text measure, ch. */
    measure: number;
    layout: GridLayout;
    gutter: { mobile: number; desktop: number };
    rhythm: { density: Density; section: { mobile: number; desktop: number } };
  };
  motion: {
    profile: MotionProfile;
    entrance: MotionEntrance;
    hover: MotionHover;
    /** ms; 0 — no animation of that kind. */
    durations: {
      state: number;
      element: number;
      overlay: number;
      hero: number;
      reveal: number;
      stagger: number;
    };
    easing: { out: string; move: string };
    /** Scale of a pressed control. */
    press: number;
    /** px an entering element travels. */
    distance: number;
    /** prefers-reduced-motion: only opacity, this long (ms); content stays visible (catalog M05). */
    reduced: number;
  };
  imagery: {
    /** Photo style for the stock search and the owner (Russian). */
    style: string;
    treatment: ImageTreatment;
    ratio: ImageRatio;
    frame: ImageFrame;
    /** CSS filter of the treatment. */
    filter: string;
  };
  depth: Depth;
}

export interface DesignSystemInput {
  archetype: ArchetypeId;
  /** The client's brand colour #RRGGBB; absent or malformed — the archetype picks the accent by the seed. */
  brandColor?: string;
  seed: string | number;
  niche: string;
  /** Voice of the texts; default — the archetype's first voice. */
  voice?: DesignVoice;
  /** How the accent is used; default — the archetype's rule. */
  accentUse?: AccentUse;
}

const SCALES: Record<TypeScaleId, { ratio: number; base: readonly [number, number]; display: number }> = {
  calm: { ratio: 1.2, base: [16, 17], display: 6 },
  classic: { ratio: 1.25, base: [16, 18], display: 5 },
  dramatic: { ratio: 1.333, base: [16, 18], display: 5 },
};
const EXPONENT: Record<Exclude<TypeStep, "display">, number> = {
  sm: -1,
  base: 0,
  lg: 1,
  xl: 2,
  "2xl": 3,
  "3xl": 4,
};
const LINE_HEIGHT: Record<TypeStep, number> = {
  sm: 1.45,
  base: 1.55,
  lg: 1.35,
  xl: 1.25,
  "2xl": 1.15,
  "3xl": 1.1,
  display: 1.08,
};
/** Catalog T04, T09: the hero never above 72 px, running text ≥ 16 px on phones, the smallest text ≥ 13 px. */
export const DISPLAY_MAX_PX = 72;
/** The hero on a 360–390 px phone (see typeScale). */
export const DISPLAY_MOBILE_MAX_PX = 36;
export const SMALL_MIN_PX = 13;
const VIEW_MIN = 360;
const VIEW_MAX = 1280;

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Fluid clamp() between the 360 and 1280 px viewports (sizes in px, output in rem and vw). */
export function fluid(min: number, max: number): string {
  if (min === max) return `${round(min / 16)}rem`;
  const slope = (max - min) / (VIEW_MAX - VIEW_MIN);
  const intercept = min - slope * VIEW_MIN;
  return `clamp(${round(min / 16)}rem, ${round(intercept / 16)}rem + ${round(slope * 100)}vw, ${round(max / 16)}rem)`;
}

function typeScale(scale: TypeScaleId, upper: boolean, tracking: "tight" | "normal") {
  const s = SCALES[scale];
  const mobileRatio = 1 + (s.ratio - 1) * 0.8;
  const step = (n: number): [number, number] => [s.base[0] * mobileRatio ** n, s.base[1] * s.ratio ** n];
  const steps = {} as Record<TypeStep, TypeStepTokens>;
  const heading = upper ? "0.01em" : "-0.01em";
  for (const name of TYPE_STEPS) {
    let [min, max] = step(name === "display" ? s.display : EXPONENT[name]);
    if (name === "display") {
      max = Math.min(max, DISPLAY_MAX_PX);
      // ≤ 36 px on phones: a long Russian word of a heading («Стоматологическая», 17 letters) fits a 358 px column
      // even in a wide display face (Cormorant at 46 px broke it inside; at 40 px still in the padded column of hero-full-bleed, V3-18).
      min = Math.min(min, DISPLAY_MOBILE_MAX_PX);
    }
    if (name === "3xl") min = Math.min(min, 40);
    if (name === "sm") {
      min = Math.max(min, SMALL_MIN_PX);
      max = Math.max(max, SMALL_MIN_PX);
    }
    const display = name === "display";
    steps[name] = {
      min: round(min, 2),
      max: round(max, 2),
      size: fluid(round(min, 2), round(max, 2)),
      lineHeight: LINE_HEIGHT[name],
      tracking: display
        ? upper
          ? "0.01em"
          : tracking === "tight"
            ? "-0.02em"
            : "-0.01em"
        : name === "3xl" || name === "2xl"
          ? heading
          : "0em",
    };
  }
  return { scale, ratio: s.ratio, upper, steps };
}

export const SPACE_SCALE = [4, 8, 12, 16, 24, 32, 48, 64, 96, 128] as const;
/** Vertical space of sections, mobile / desktop px (catalog E2). */
export const SECTION_SPACE: Record<Density, { mobile: number; desktop: number }> = {
  compact: { mobile: 32, desktop: 48 },
  regular: { mobile: 56, desktop: 96 },
  airy: { mobile: 72, desktop: 128 },
};
const GUTTER: Record<Density, { mobile: number; desktop: number }> = {
  compact: { mobile: 16, desktop: 32 },
  regular: { mobile: 16, desktop: 40 },
  airy: { mobile: 20, desktop: 48 },
};
/** Radius sets sm/md/lg px (catalog E2). */
export const RADIUS_SETS: Record<RadiusSetId, readonly [number, number, number]> = {
  sharp: [0, 0, 0],
  crisp: [2, 4, 6],
  soft: [6, 10, 16],
  round: [8, 14, 24],
};
export const PILL_RADIUS = 999;

/** Easing (catalog E3): ease-out for entering and state changes, ease-in-out for moves across the screen. */
export const EASING = {
  out: "cubic-bezier(0.23, 1, 0.32, 1)",
  move: "cubic-bezier(0.77, 0, 0.175, 1)",
} as const;

function motion(
  profile: MotionProfile,
  entrance: MotionEntrance,
  hover: MotionHover,
): DesignSystemV3["motion"] {
  const still = profile === "still";
  const lively = profile === "lively";
  const enters = !still && entrance !== "none";
  return {
    profile,
    entrance: enters ? entrance : "none",
    hover,
    durations: {
      state: 120,
      element: still ? 0 : 200,
      overlay: still ? 0 : 320,
      hero: enters ? (lively ? 600 : 400) : 0,
      reveal: lively ? 400 : 0,
      stagger: lively ? 50 : 0,
    },
    easing: { ...EASING },
    press: 0.97,
    distance: 12,
    reduced: 150,
  };
}

/** CSS filter of an image treatment. */
export const IMAGE_FILTERS: Record<ImageTreatment, string> = {
  natural: "none",
  "warm-grade": "sepia(0.12) saturate(1.05)",
  "soft-grade": "contrast(0.95) saturate(0.9) brightness(1.03)",
  "high-contrast": "contrast(1.12) saturate(1.05)",
  monochrome: "grayscale(1) contrast(1.05)",
};

const font = (family: string, weight: number): FontChoice => ({ family, weight, stack: fontStack(family) });

/**
 * The client's design system: same input → same result (the seed picks the font pair, the accent hue when there is
 * no brand colour, the scale, radius and density among the archetype's options).
 */
export function designSystemV3(input: DesignSystemInput): DesignSystemV3 {
  const a = archetypeById(input.archetype);
  if (!a) throw new Error(`Unknown archetype: ${input.archetype}`);
  const seed = String(input.seed);
  const niche = input.niche.trim();
  const key = `${a.id}|${niche.toLowerCase()}`;
  const r = (aspect: string) => rng(seed, `${key}:${aspect}`);
  const pair = pick(a.fontPairs, r("fonts"));
  const radiusSet = pick(a.radius, r("radius"));
  const [sm, md, lg] = RADIUS_SETS[radiusSet];
  const density = pick(a.density, r("density"));
  return {
    version: 3,
    archetype: a.id,
    name: a.name,
    seed,
    niche,
    voice: input.voice ?? (a.voices[0] as DesignVoice),
    fonts: {
      display: font(pair.display, a.displayWeight),
      text: font(pair.text, 400),
      ...(pair.why ? { why: pair.why } : {}),
    },
    palette: buildPalette({
      rules: a.palette,
      ...(input.brandColor ? { brandColor: input.brandColor } : {}),
      seed,
      key,
      ...(input.accentUse ? { accentUse: input.accentUse } : {}),
    }),
    type: typeScale(pick(a.scales, r("scale")), a.upper, a.tracking),
    space: { unit: 4, scale: SPACE_SCALE },
    radius: { set: radiusSet, sm, md, lg, control: a.controls === "pill" ? PILL_RADIUS : md },
    grid: {
      columns: a.grid.columns,
      maxWidth: a.grid.maxWidth,
      measure: a.grid.measure,
      layout: pick(a.grid.layouts, r("layout")),
      gutter: { ...GUTTER[density] },
      rhythm: { density, section: { ...SECTION_SPACE[density] } },
    },
    motion: motion(a.motion.profile, a.motion.entrance, a.motion.hover),
    imagery: { ...a.imagery, filter: IMAGE_FILTERS[a.imagery.treatment] },
    depth: a.palette.depth,
  };
}

const THEME_RADII = [0, 4, 8, 12, 16] as const;

/**
 * The design system as AppSpec.theme (v2 tokens): staff cabinets of ui-kit take the client's colour, font pair,
 * radius and density from it; designLint runs themeLint on it (a valid AppSpec theme when designLint has no errors).
 */
export function designSystemTheme(ds: DesignSystemV3): Theme {
  const radius = THEME_RADII.reduce((best, x) =>
    Math.abs(x - ds.radius.md) < Math.abs(best - ds.radius.md) ? x : best,
  );
  return {
    accent: cssHex(ds.palette.light.accent),
    font: ds.fonts.text.family as Theme["font"],
    headingFont: ds.fonts.display.family as Theme["font"],
    radius,
    density: ds.grid.rhythm.density === "compact" ? "compact" : "regular",
    mode: "auto",
  };
}
