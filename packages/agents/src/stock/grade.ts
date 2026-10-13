// V4-10 (D79 (6)): one grade for every photo of a site, so photos from different stocks and authors read as one shoot
// in the direction's style. Plain CSS filter functions (GPU, every browser, nothing re-encoded, a photo swap stays
// instant): the tone and contrast of the direction's image treatment, then a light cast toward the accent hue
// (sepia() gives a warm base, hue-rotate() turns it to the accent); monochrome turns into a duotone of the accent.
// A neutral accent (low chroma) gets no cast. The rule targets the library photos the runtime serves
// (/_wizard/photos/…) and elements marked data-wz-photo (background photos), never the owner's uploads or logos.
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import { cssHex, parseOklch } from "@wizard/ui-kit/v3/design";

type ImageTreatment = DesignSystemV3["imagery"]["treatment"];

export interface PhotoGrade {
  /** The CSS filter of every photo of the site. */
  filter: string;
  /** Hue of the cast, degrees (HSL of the accent); null — neutral, no cast. */
  hue: number | null;
}

/** Tone and contrast of a treatment, and how strong the cast toward the accent is (sepia amount). */
const BASE: Record<ImageTreatment, { tone: string; cast: number }> = {
  natural: { tone: "contrast(1.04) saturate(0.94)", cast: 0.1 },
  "warm-grade": { tone: "contrast(1.03) saturate(1.02) brightness(1.02)", cast: 0.2 },
  "soft-grade": { tone: "contrast(0.94) saturate(0.86) brightness(1.04)", cast: 0.14 },
  "high-contrast": { tone: "contrast(1.14) saturate(1.06)", cast: 0.08 },
  monochrome: { tone: "grayscale(1) contrast(1.08)", cast: 0.4 },
};

/** Chroma (OKLCH) below which an accent counts as neutral. */
const NEUTRAL_CHROMA = 0.04;
/** Hue sepia() lands on (HSL degrees): hue-rotate turns it from here to the accent. */
const SEPIA_HUE = 35;

/** HSL hue (degrees) of a hex colour; null — grey. */
export function hslHue(hex: string): number | null {
  const v = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(v.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d < 1e-6) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round((((h * 60) % 360) + 360) % 360);
}

const num = (x: number) => String(Math.round(x * 100) / 100);

/** The grade of a direction: its image treatment and accent colour (an `oklch()` string of the palette, or #RRGGBB). */
export function photoGrade(o: { treatment: ImageTreatment; accent: string }): PhotoGrade {
  const base = BASE[o.treatment] ?? BASE.natural;
  const ok = parseOklch(o.accent);
  const hex = ok ? cssHex(o.accent) : /^#[0-9a-f]{6}$/i.test(o.accent) ? o.accent : null;
  const neutral = ok ? ok.c < NEUTRAL_CHROMA : !hex;
  const hue = !neutral && hex ? hslHue(hex) : null;
  if (hue === null) return { filter: base.tone, hue: null };
  const rotate = Math.round((((hue - SEPIA_HUE) % 360) + 540) % 360) - 180;
  return {
    filter: `${base.tone} sepia(${num(base.cast)}) hue-rotate(${rotate}deg)${o.treatment === "monochrome" ? "" : " saturate(1.04)"}`,
    hue,
  };
}

/** Selector of the photos the grade applies to. */
export const GRADED_PHOTOS = 'img[src*="/_wizard/photos/"],[data-wz-photo]';

/** The CSS of the grade: the token (--ds-image-filter of the design system) and the rule that applies it. */
export const photoGradeCss = (g: PhotoGrade): string =>
  `:root{--ds-image-filter:${g.filter}}${GRADED_PHOTOS}{filter:var(--ds-image-filter)}`;
