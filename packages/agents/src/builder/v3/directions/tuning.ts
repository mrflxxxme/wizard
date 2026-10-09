// Refinement of a direction by the owner's words (V3-09; D77 (7)): «теплее», «строже», «крупнее заголовок»… become
// deltas of the design system parameters, applied by code to the archetype's rules and the computed tokens — the
// palette is rebuilt by buildPalette (contrast kept by construction), the rest moves along the archetype's own scales.
// Every applied step is checked by designLint; a step that would break it is skipped and reported.
import {
  type AccentUse,
  type ArchetypeId,
  archetype as archetypeById,
  buildPalette,
  type DesignSystemV3,
  type DesignVoice,
  designLintErrors,
  designSystemV3,
  fluid,
  normalizeBrand,
  type PaletteRules,
  RADIUS_SETS,
  SECTION_SPACE,
} from "@wizard/ui-kit/v3/design";

/** Numeric axes of a refinement: −2…+2 steps from the archetype's default. */
export const TUNING_AXES = [
  "warmth",
  "contrast",
  "saturation",
  "density",
  "scale",
  "radius",
  "motion",
] as const;
export type TuningAxis = (typeof TUNING_AXES)[number];

/** Owner's wishes for a direction: steps along the axes, photos on the first screen, the page scheme. */
export interface DirectionTuning {
  /** + warmer palette and neutrals, − cooler. */
  warmth?: number;
  /** + stricter contrast of page and text, − softer. */
  contrast?: number;
  /** + brighter accent (filled), − calmer. */
  saturation?: number;
  /** + more air between sections, − denser. */
  density?: number;
  /** + larger first-screen headline, − smaller. */
  scale?: number;
  /** + rounder corners, − sharper. */
  radius?: number;
  /** + livelier motion, − calmer (−2 — still). */
  motion?: number;
  /** false — a first screen without photos; true — with a photo. */
  photos?: boolean;
  /** The scheme the page starts in. */
  scheme?: "light" | "dark";
}

export const TUNING_LIMIT = 2;

const clampStep = (x: number) => Math.max(-TUNING_LIMIT, Math.min(TUNING_LIMIT, Math.round(x)));

/** Drops zero axes and normalizes the steps (integers within ±2). */
export function normalizeTuning(t: DirectionTuning): DirectionTuning {
  const out: DirectionTuning = {};
  for (const axis of TUNING_AXES) {
    const v = t[axis];
    if (typeof v === "number" && Number.isFinite(v) && clampStep(v) !== 0) out[axis] = clampStep(v);
  }
  if (typeof t.photos === "boolean") out.photos = t.photos;
  if (t.scheme === "light" || t.scheme === "dark") out.scheme = t.scheme;
  return out;
}

/** `b` on top of `a`: steps add up (within ±2), photos and scheme of `b` win. */
export function mergeTuning(a: DirectionTuning, b: DirectionTuning): DirectionTuning {
  const out: DirectionTuning = { ...a };
  for (const axis of TUNING_AXES) {
    const v = (a[axis] ?? 0) + (b[axis] ?? 0);
    if (v !== 0) out[axis] = v;
    else delete out[axis];
  }
  if (b.photos !== undefined) out.photos = b.photos;
  if (b.scheme !== undefined) out.scheme = b.scheme;
  return normalizeTuning(out);
}

export const isEmptyTuning = (t: DirectionTuning): boolean => Object.keys(normalizeTuning(t)).length === 0;

const AXIS_WORDS: Readonly<Record<TuningAxis, readonly [string, string]>> = {
  warmth: ["холоднее", "теплее"],
  contrast: ["мягче контраст", "контрастнее"],
  saturation: ["спокойнее цвет", "ярче цвет"],
  density: ["плотнее", "просторнее"],
  scale: ["заголовок мельче", "заголовок крупнее"],
  radius: ["острее углы", "круглее углы"],
  motion: ["спокойнее движение", "живее движение"],
};

/** Russian words of a tuning, in a stable order («теплее», «заголовок крупнее», «без фото»…). */
export function tuningWords(t: DirectionTuning): string[] {
  const n = normalizeTuning(t);
  const out: string[] = [];
  for (const axis of TUNING_AXES) {
    const v = n[axis];
    if (!v) continue;
    const word = AXIS_WORDS[axis][v > 0 ? 1 : 0];
    out.push(Math.abs(v) > 1 ? `намного ${word}` : word);
  }
  if (n.photos === false) out.push("без фото");
  if (n.photos === true) out.push("с фото");
  if (n.scheme === "dark") out.push("тёмный фон");
  if (n.scheme === "light") out.push("светлый фон");
  return out;
}

/** Inputs of the design system of a direction (the same as designSystemV3). */
export interface DirectionDesignInput {
  archetype: ArchetypeId;
  seed: string | number;
  niche: string;
  brandColor?: string;
  voice?: DesignVoice;
  accentUse?: AccentUse;
}

export interface TunedDesign {
  design: DesignSystemV3;
  /** Axes that moved the tokens. */
  applied: (TuningAxis | "scheme")[];
  /** Axes skipped: the step would break designLint or the value is already at its limit (Russian reason). */
  skipped: { axis: TuningAxis | "scheme"; reasonRu: string }[];
}

const RADIUS_ORDER = ["sharp", "crisp", "soft", "round"] as const;
const DENSITY_ORDER = ["compact", "regular", "airy"] as const;
const MOTION_ORDER = ["still", "calm", "lively"] as const;
/** Gutters of a density, px (the same table as the design system: catalog E2). */
const GUTTER = {
  compact: { mobile: 16, desktop: 32 },
  regular: { mobile: 16, desktop: 40 },
  airy: { mobile: 20, desktop: 48 },
} as const;
/** Catalog T04: the hero headline at most 72 px, 46 px on phones. */
const DISPLAY_MAX = 72;
const DISPLAY_MIN_MAX = 46;
const WARM_HUE = 45;
const COOL_HUE = 235;

const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** The hue moved toward `target` by `share` of the shortest arc. */
function towardHue(h: number, target: number, share: number): number {
  const d = ((target - h + 540) % 360) - 180;
  return (h + d * share + 360) % 360;
}

/** Palette rules of the archetype with the owner's warmth, contrast, saturation and scheme. */
export function tunedRules(rules: PaletteRules, t: DirectionTuning, hasBrand: boolean): PaletteRules {
  const out: PaletteRules = { ...rules, bgL: { ...rules.bgL }, accentC: [...rules.accentC] as const };
  const w = t.warmth ?? 0;
  if (w !== 0) {
    const target = w > 0 ? WARM_HUE : COOL_HUE;
    // The brand colour is the client's: only the neutrals around it change.
    if (!hasBrand)
      out.hues = rules.hues.map((h) => {
        const moved = towardHue(h, target, 0.4 * Math.abs(w));
        // Never into the violet of the «AI palette» (catalog C01): warm goes on to rose, cool stays blue.
        return round(moved >= 255 && moved <= 320 ? (w > 0 ? 335 : 250) : moved, 1);
      });
    out.neutralHue = w > 0 ? 70 : 245;
    out.neutralC = round(clamp(Math.max(rules.neutralC, 0.006 + 0.004 * Math.abs(w)), 0, 0.02), 4);
  }
  const s = t.saturation ?? 0;
  if (s !== 0) {
    const k = 1 + 0.22 * s;
    out.accentC = [
      round(clamp(rules.accentC[0] * k, 0.02, 0.22)),
      round(clamp(rules.accentC[1] * k, 0.03, 0.24)),
    ];
  }
  const c = t.contrast ?? 0;
  if (c > 0) {
    out.bgL = {
      light: round(Math.min(0.995, rules.bgL.light + 0.008 * c)),
      dark: round(Math.max(0.11, rules.bgL.dark - 0.02 * c)),
    };
    out.neutralC = round(out.neutralC * 0.6, 4);
    if (rules.band === "tint") out.band = "neutral";
    else out.band = "deep";
  } else if (c < 0) {
    out.bgL = {
      light: round(Math.max(0.94, rules.bgL.light - 0.012 * -c)),
      dark: round(Math.min(0.24, rules.bgL.dark + 0.02 * -c)),
    };
    out.band = "tint";
  }
  if (t.scheme) out.scheme = t.scheme;
  return out;
}

function shift<T extends string>(order: readonly T[], current: T, by: number): T {
  const i = order.indexOf(current);
  return order[clamp((i < 0 ? 0 : i) + by, 0, order.length - 1)] as T;
}

function motionFor(base: DesignSystemV3["motion"], profile: DesignSystemV3["motion"]["profile"]) {
  const still = profile === "still";
  const lively = profile === "lively";
  const entrance = still ? "none" : base.entrance !== "none" ? base.entrance : lively ? "rise" : "fade";
  return {
    ...base,
    profile,
    entrance,
    durations: {
      state: 120,
      element: still ? 0 : 200,
      overlay: still ? 0 : 320,
      hero: still ? 0 : lively ? 600 : 400,
      reveal: lively ? 400 : 0,
      stagger: lively ? 50 : 0,
    },
  } as DesignSystemV3["motion"];
}

function headline(ds: DesignSystemV3, k: number): DesignSystemV3["type"] | null {
  const t = ds.type.steps;
  const d = t.display;
  let max: number;
  let min: number;
  if (k > 0) {
    max = Math.min(DISPLAY_MAX, d.max * 1.14 ** k);
    min = Math.min(DISPLAY_MIN_MAX, d.min * 1.14 ** k);
  } else {
    // Never flatter than the hierarchy the lint keeps: ≥ 1.19 × the next step, ≥ 2.5 × the body text.
    const floor = Math.max(t["3xl"].max * 1.2, t.base.max * 2.52);
    max = Math.max(floor, d.max * 0.88 ** -k);
    min = Math.max(t["3xl"].min, d.min * 0.88 ** -k);
  }
  max = round(max, 2);
  min = round(Math.min(min, max), 2);
  if (Math.abs(max - d.max) < 0.5 && Math.abs(min - d.min) < 0.5) return null;
  return { ...ds.type, steps: { ...t, display: { ...d, min, max, size: fluid(min, max) } } };
}

const SKIP_LINT = "это изменение нарушило бы правила читаемости и контраста";

/**
 * The design system of a direction with the owner's tuning: designSystemV3 of the archetype, then each axis by code.
 * An axis whose step breaks designLint (or has no room left) is skipped with a Russian reason.
 */
export function tuneDesign(input: DirectionDesignInput, tuning: DirectionTuning): TunedDesign {
  const brandColor = normalizeBrand(input.brandColor);
  const base = designSystemV3({
    archetype: input.archetype,
    seed: input.seed,
    niche: input.niche,
    ...(brandColor ? { brandColor } : {}),
    ...(input.voice ? { voice: input.voice } : {}),
    ...(input.accentUse ? { accentUse: input.accentUse } : {}),
  });
  const t = normalizeTuning(tuning);
  const a = archetypeById(input.archetype);
  const applied: TunedDesign["applied"] = [];
  const skipped: TunedDesign["skipped"] = [];
  let ds = base;
  const attempt = (axis: TuningAxis | "scheme", next: DesignSystemV3 | null, why = SKIP_LINT) => {
    if (!next) {
      skipped.push({ axis, reasonRu: why });
      return;
    }
    if (designLintErrors(next).length) {
      skipped.push({ axis, reasonRu: SKIP_LINT });
      return;
    }
    ds = next;
    applied.push(axis);
  };

  // Palette: warmth, contrast, saturation and the scheme go through the archetype's rules at once (buildPalette).
  const paletteAxes = (["warmth", "contrast", "saturation"] as const).filter((x) => t[x]);
  if (a && (paletteAxes.length || t.scheme)) {
    const rules = tunedRules(a.palette, t, !!brandColor);
    const accentUse: AccentUse | undefined =
      (t.saturation ?? 0) > 0 ? "fill" : (t.saturation ?? 0) < 0 ? "signal" : input.accentUse;
    const palette = buildPalette({
      rules,
      ...(brandColor ? { brandColor } : {}),
      seed: String(input.seed),
      key: `${a.id}|${input.niche.trim().toLowerCase()}`,
      ...(accentUse ? { accentUse } : {}),
    });
    const next = { ...ds, palette };
    if (designLintErrors(next).length) {
      for (const axis of paletteAxes) skipped.push({ axis, reasonRu: SKIP_LINT });
      if (t.scheme) skipped.push({ axis: "scheme", reasonRu: SKIP_LINT });
    } else {
      ds = next;
      applied.push(...paletteAxes);
      if (t.scheme) applied.push("scheme");
    }
  }
  if (t.scale) {
    const type = headline(ds, t.scale);
    attempt(
      "scale",
      type ? { ...ds, type } : null,
      t.scale > 0
        ? "заголовок уже самого крупного размера по правилам вёрстки"
        : "заголовок уже самый скромный по правилам вёрстки",
    );
  }
  if (t.radius) {
    const set = shift(RADIUS_ORDER, ds.radius.set, t.radius);
    const [sm, md, lg] = RADIUS_SETS[set];
    const pill = ds.radius.control > 100 && t.radius > 0;
    attempt(
      "radius",
      set === ds.radius.set
        ? null
        : { ...ds, radius: { set, sm, md, lg, control: pill ? ds.radius.control : md } },
      t.radius > 0 ? "углы уже самые круглые" : "углы уже прямые",
    );
  }
  if (t.density) {
    const density = shift(DENSITY_ORDER, ds.grid.rhythm.density, t.density);
    attempt(
      "density",
      density === ds.grid.rhythm.density
        ? null
        : {
            ...ds,
            grid: {
              ...ds.grid,
              gutter: { ...GUTTER[density] },
              rhythm: { density, section: { ...SECTION_SPACE[density] } },
            },
          },
      t.density > 0 ? "воздуха уже максимум" : "плотнее уже некуда",
    );
  }
  if (t.motion) {
    const profile = shift(MOTION_ORDER, ds.motion.profile, t.motion);
    attempt(
      "motion",
      profile === ds.motion.profile ? null : { ...ds, motion: motionFor(ds.motion, profile) },
      t.motion > 0 ? "движение уже самое живое" : "движения уже нет",
    );
  }
  return { design: ds, applied, skipped };
}
