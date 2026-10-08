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
