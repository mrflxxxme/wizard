// Font roles of the v3 client design system (D64, docs/research/design-agent-catalog.md#A3): only the self-hosted
// catalog (tokens/font-catalog.ts — OFL-1.1, Cyrillic + Latin, 400 and 700); which faces may set headings or running
// text, which are model defaults that need a stated reason, which are banned outright.
import { type FontEntry, fontEntry } from "../../tokens/fonts.js";

/** Faces for headings only: running text set in them is hard to read (catalog A4 «display»). */
export const DISPLAY_ONLY_FONTS: ReadonlySet<string> = new Set([
  "Unbounded",
  "Cormorant Garamond",
  "Sofia Sans Extra Condensed",
  "Alumni Sans",
  "Wix Madefor Display",
]);

/** Monoculture of the Runet and of models (catalog A3 «не для заголовков»): never a display face. */
export const NOT_DISPLAY_FONTS: ReadonlySet<string> = new Set([
  "Inter",
  "Inter Tight",
  "Roboto",
  "Roboto Condensed",
  "Open Sans",
  "Montserrat",
  "Manrope",
  "Nunito",
  "Nunito Sans",
  "Raleway",
  "Rubik",
  "PT Sans",
  "Golos Text",
  "Oswald",
  "Comfortaa",
  "Lobster",
  "Russo One",
  "Exo 2",
]);

/** Model defaults (catalog A3 «только с обоснованием»): a pair with one of them states why it is that face. */
export const NEEDS_REASON_FONTS: ReadonlySet<string> = new Set([
  "Playfair Display",
  "Cormorant Garamond",
  "Lora",
  "Merriweather",
  "EB Garamond",
  "Source Serif 4",
  "IBM Plex Sans",
  "IBM Plex Serif",
  "Geist",
  "Unbounded",
]);

/** Banned defaults of v3 in any role: the Inter family is the median a model falls into (research 2026-10-08 §4). */
export const FORBIDDEN_FONTS: ReadonlySet<string> = new Set(["Inter", "Inter Tight"]);

/** Catalog entry when the family has Cyrillic files for `weight`; undefined otherwise. */
export function cyrillicFace(family: string, weight: number): FontEntry | undefined {
  const f = fontEntry(family);
  return f?.files.some((x) => x.weight === weight && x.subset === "cyrillic") ? f : undefined;
}

/**
 * Widest average advance of each catalog face over long Russian words, em per letter at weights 400 and 700:
 * [capitalised word, all caps]. The fit rules of display words (css.ts FIT_WORDS_CSS) size a brand on a phone by it so
 * its longest word stays on one line. Measured in Chromium; test/v3-header-brand.browser.test.ts re-measures every face
 * and fails when one draws wider than its entry here.
 */
export const FONT_ADVANCE: Readonly<Record<string, Readonly<Record<400 | 700, readonly [number, number]>>>> =
  {
    Onest: { 400: [0.64, 0.77], 700: [0.67, 0.8] },
    "Inter Tight": { 400: [0.62, 0.73], 700: [0.67, 0.79] },
    Manrope: { 400: [0.64, 0.74], 700: [0.67, 0.77] },
    "PT Sans": { 400: [0.59, 0.7], 700: [0.6, 0.69] },
    "IBM Plex Sans": { 400: [0.65, 0.76], 700: [0.69, 0.8] },
    "Golos Text": { 400: [0.67, 0.78], 700: [0.69, 0.81] },
    "PT Serif": { 400: [0.65, 0.77], 700: [0.7, 0.81] },
    Lora: { 400: [0.66, 0.81], 700: [0.72, 0.85] },
    Unbounded: { 400: [0.88, 1.02], 700: [0.93, 1.06] },
    "Cormorant Garamond": { 400: [0.57, 0.8], 700: [0.58, 0.81] },
    Commissioner: { 400: [0.65, 0.82], 700: [0.67, 0.83] },
    Piazzolla: { 400: [0.67, 0.85], 700: [0.69, 0.87] },
    "Source Sans 3": { 400: [0.61, 0.68], 700: [0.64, 0.71] },
    "Sofia Sans Extra Condensed": { 400: [0.4, 0.43], 700: [0.43, 0.48] },
    "Sofia Sans": { 400: [0.63, 0.69], 700: [0.64, 0.71] },
    "Alegreya Sans": { 400: [0.57, 0.71], 700: [0.59, 0.72] },
    Alegreya: { 400: [0.62, 0.76], 700: [0.64, 0.78] },
    "Alumni Sans": { 400: [0.44, 0.47], 700: [0.46, 0.48] },
    Literata: { 400: [0.73, 0.88], 700: [0.77, 0.91] },
    "Wix Madefor Display": { 400: [0.68, 0.83], 700: [0.71, 0.86] },
    "Wix Madefor Text": { 400: [0.66, 0.81], 700: [0.68, 0.83] },
  };

/** Advance of a face for the fit rules (FONT_ADVANCE); an unknown face counts as the widest of the catalog. */
export function fontAdvance(family: string, weight: number): { lower: number; caps: number } {
  const entry = FONT_ADVANCE[family];
  const pick = (e: Readonly<Record<400 | 700, readonly [number, number]>>) =>
    weight >= 550 ? e[700] : e[400];
  if (entry) {
    const [lower, caps] = pick(entry);
    return { lower, caps };
  }
  const all = Object.values(FONT_ADVANCE).map(pick);
  return { lower: Math.max(...all.map((x) => x[0])), caps: Math.max(...all.map((x) => x[1])) };
}
