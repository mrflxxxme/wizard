// Theme fonts (ui-kit.yaml#tokens.fonts, D64): self-hosted woff2 from packages/ui-kit/fonts, served by the runtime at
// /_wizard/fonts/<file>. No requests to Google Fonts or other CDNs from systems (CSP font-src 'self', 152-ФЗ).
// Browser-safe: no node imports (the runtime resolves the folder itself).
import { FONT_CATALOG } from "./font-catalog.js";

/** latin-ext ships for the ruble sign ₽ (U+20BD) only; its unicode-range keeps it unloaded on pages without it. */
export type FontSubset = "cyrillic" | "latin" | "latin-ext";
export interface FontFile {
  weight: number;
  subset: FontSubset | string;
  /** File name in packages/ui-kit/fonts (content hash in the name: served immutable). */
  file: string;
  unicodeRange: string;
  bytes: number;
}
export interface FontEntry {
  family: string;
  /** @fontsource id. */
  id: string;
  category: "sans-serif" | "serif" | "display" | string;
  weights: readonly number[];
  /** OFL-1.1 or Apache-2.0 (AGENTS.md, D64). */
  license: string;
  licenseFile: string;
  attribution: string;
  /** Where the files come from (Google Fonts via npm @fontsource/<id>@version). */
  source: string;
  files: readonly FontFile[];
}

export { FONT_CATALOG };

/** URL prefix the runtime serves the font files from. */
export const FONTS_BASE = "/_wizard/fonts/";

/** Catalog entry of a family, or undefined for an unknown name. */
export function fontEntry(family: string | undefined | null): FontEntry | undefined {
  return family ? FONT_CATALOG.find((f) => f.family === family) : undefined;
}

/** File names the runtime may serve (the catalog is the allowlist). */
export function fontFiles(): string[] {
  return FONT_CATALOG.flatMap((f) => f.files.map((x) => x.file));
}

/**
 * Catalog family whose latin-ext face draws ₽ for families without it (Sofia Sans and Sofia Sans Extra Condensed have
 * no U+20BD in any Google Fonts subset): it stands right after such a family in the stack, so ₽ comes in a web font of
 * the same kind instead of a system one; only its latin-ext faces are declared, loaded on pages with ₽ only.
 */
export const RUBLE_FALLBACK_FONT = "Commissioner";

/** The family draws ₽ itself (it ships a latin-ext subset). */
export function fontHasRuble(f: FontEntry): boolean {
  return f.files.some((x) => x.subset === "latin-ext");
}

/** CSS font-family stack: the family (then the ₽ fallback when it lacks ₽), then system fonts of the same kind. */
export function fontStack(family: string): string {
  const f = fontEntry(family);
  const serif = f?.category === "serif";
  const tail = serif
    ? 'Georgia, "Times New Roman", serif'
    : 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const ruble = f && !fontHasRuble(f) ? `"${RUBLE_FALLBACK_FONT}", ` : "";
  return `"${family}", ${ruble}${tail}`;
}

/** @font-face rules (font-display: swap, unicode-range per subset) for the given families; unknown names are skipped. */
export function fontFaceCss(families: readonly string[], base: string = FONTS_BASE): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const face = (family: string, x: FontFile) =>
    out.push(
      `@font-face{font-family:"${family}";font-style:normal;font-weight:${x.weight};font-display:swap;` +
        `src:url(${base}${x.file}) format("woff2");unicode-range:${x.unicodeRange};}`,
    );
  let noRuble = false;
  for (const name of families) {
    const f = fontEntry(name);
    if (!f || seen.has(f.family)) continue;
    seen.add(f.family);
    if (!fontHasRuble(f)) noRuble = true;
    for (const x of f.files) face(f.family, x);
  }
  // A family without ₽ falls back to RUBLE_FALLBACK_FONT for it (fontStack): its latin-ext faces only.
  const fallback = fontEntry(RUBLE_FALLBACK_FONT);
  if (noRuble && fallback && !seen.has(fallback.family))
    for (const x of fallback.files) if (x.subset === "latin-ext") face(fallback.family, x);
  return out.join("\n");
}
