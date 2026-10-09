// M2-42 acceptance: the font catalog check (D64). Every shipped font has an allowed license, its source and license
// text are recorded in the catalog and THIRD_PARTY_NOTICES.md, the cyrillic files have А–я, Ё, ё; nothing else ships.
// V3-08: the ruble sign ₽ (U+20BD, latin-ext range of Google Fonts) comes from a latin-ext file of every weight.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { THEME_FONTS } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { FONT_CATALOG, type FontEntry, fontFaceCss, fontFiles } from "../src/index.js";
import { PLATFORM_FONTS } from "../src/v2/font-catalog.js";
import { UI_KIT_ROOT } from "./helpers/demo.js";
import { cmapCodepoints, woff2Tables } from "./helpers/woff2.js";

const FONTS_DIR = join(UI_KIT_ROOT, "fonts");
/** AGENTS.md (D64): free commercial use incl. web embedding and self-hosting. */
const ALLOWED = ["OFL-1.1", "Apache-2.0"];
const CYRILLIC = [
  ...Array.from({ length: 0x44f - 0x410 + 1 }, (_, i) => 0x410 + i),
  0x401, // Ё
  0x451, // ё
];
const LATIN = [..."AZaz09"].map((ch) => ch.codePointAt(0) as number);
const RUBLE = 0x20bd;
/** Families whose Google Fonts files have no ₽ in any subset (NO_RUBLE of scripts/sync-fonts.mjs): no latin-ext. */
const NO_RUBLE = ["Sofia Sans", "Sofia Sans Extra Condensed"];
const NEED: Record<string, number[]> = { cyrillic: CYRILLIC, latin: LATIN, "latin-ext": [RUBLE] };

/** Whether a CSS unicode-range ("U+0000-00FF,U+2116") covers the code point. */
function covers(range: string, cp: number): boolean {
  return range.split(",").some((part) => {
    const [lo, hi = lo] = part.trim().replace(/^U\+/i, "").split("-");
    return cp >= Number.parseInt(lo as string, 16) && cp <= Number.parseInt(hi as string, 16);
  });
}

const glyphs = (file: string) =>
  cmapCodepoints(woff2Tables(new Uint8Array(readFileSync(file))).get("cmap") as Uint8Array);
const subsetsOf = (f: FontEntry) =>
  NO_RUBLE.includes(f.family) ? ["cyrillic", "latin"] : ["cyrillic", "latin", "latin-ext"];

describe("font catalog", () => {
  test("catalog families = AppSpec theme fonts", () => {
    expect(FONT_CATALOG.map((f) => f.family).sort()).toEqual([...THEME_FONTS].sort());
  });

  test("license from the allowlist, license text shipped, source recorded", () => {
    for (const f of FONT_CATALOG) {
      expect(ALLOWED, f.family).toContain(f.license);
      const text = readFileSync(join(FONTS_DIR, f.licenseFile), "utf8");
      expect(text, f.family).toContain("SIL Open Font License");
      expect(f.attribution, f.family).toMatch(/Copyright/);
      expect(f.source, f.family).toMatch(/Google Fonts .*@fontsource\//);
      expect(f.weights).toEqual([400, 700]);
      for (const w of f.weights)
        expect(
          f.files
            .filter((x) => x.weight === w)
            .map((x) => x.subset)
            .sort(),
          `${f.family} ${w}`,
        ).toEqual(subsetsOf(f));
      expect(f.files).toHaveLength(subsetsOf(f).length * f.weights.length);
    }
  });

  test("THIRD_PARTY_NOTICES.md lists every family with license and source", () => {
    const notices = readFileSync(join(UI_KIT_ROOT, "../../THIRD_PARTY_NOTICES.md"), "utf8");
    for (const f of FONT_CATALOG) {
      const line = notices.split("\n").find((l) => l.startsWith(`| ${f.family} `));
      expect(line, f.family).toBeDefined();
      expect(line).toContain(f.license);
      expect(line).toContain(`@fontsource/${f.id}`);
    }
  });

  test("the fonts folder holds exactly the catalog files and licenses", () => {
    const expected = [...fontFiles(), ...FONT_CATALOG.map((f) => f.licenseFile)].sort();
    expect(readdirSync(FONTS_DIR).sort()).toEqual(expected);
  });

  test.each(FONT_CATALOG.flatMap((f) => f.files.map((x) => [f.family, x] as const)))(
    "%s %o: woff2 with the glyphs of its subset",
    (_family, file) => {
      const data = new Uint8Array(readFileSync(join(FONTS_DIR, file.file)));
      expect(data.byteLength).toBe(file.bytes);
      const cmap = woff2Tables(data).get("cmap");
      expect(cmap).toBeDefined();
      const cps = cmapCodepoints(cmap as Uint8Array);
      const need = NEED[file.subset];
      expect(need, file.subset).toBeDefined();
      const missing = (need as number[]).filter((cp) => !cps.has(cp)).map((cp) => String.fromCodePoint(cp));
      expect(missing).toEqual([]);
    },
  );

  test("@font-face: only own origin, swap, unicode-range; latin-ext declared before latin", () => {
    const css = fontFaceCss(["PT Serif", "Нет такого"]);
    expect(css.match(/@font-face/g)).toHaveLength(6);
    expect(css).not.toMatch(/https?:|googleapis|gstatic/);
    expect(css).toContain("unicode-range:U+0301,U+0400-045F");
    expect(css).toMatch(
      /pt-serif-latin-ext-700-[0-9a-f]{8}\.woff2\) format\("woff2"\);unicode-range:[^;]*U\+20AD-20C0/,
    );
    // Ranges overlap on U+0304, U+0308, U+0329, U+2020: the last declared face (latin, always loaded) is checked first.
    for (const w of [400, 700])
      expect(css.indexOf(`pt-serif-latin-ext-${w}-`)).toBeLessThan(css.indexOf(`pt-serif-latin-${w}-`));
  });

  test("a theme's faces fit the preview bridge (apply-theme-tokens: ≤ 16 faces of two families, plain ranges)", () => {
    for (const f of FONT_CATALOG) {
      expect(f.files.length, f.family).toBeLessThanOrEqual(8);
      for (const x of f.files) expect(x.unicodeRange).toMatch(/^[U+0-9A-Fa-f,-]{1,400}$/);
    }
  });
});

describe("ruble sign ₽ (U+20BD)", () => {
  const catalogs = [
    ...FONT_CATALOG.map((f) => ["fonts", f] as const),
    ...PLATFORM_FONTS.map((f) => ["fonts-platform", f] as const),
  ];
  const withRuble = catalogs
    .filter(([, f]) => !NO_RUBLE.includes(f.family))
    .map(([d, f]) => [d, f.family, f] as const);

  test.each(withRuble)(
    "%s %s: every weight with cyrillic files has a latin-ext file that covers ₽ and maps it",
    (dir, _family, f) => {
      for (const w of f.weights) {
        if (!f.files.some((x) => x.weight === w && x.subset === "cyrillic")) continue;
        const ext = f.files.filter((x) => x.weight === w && x.subset === "latin-ext");
        expect(ext, `${f.family} ${w}`).toHaveLength(1);
        const file = ext[0] as FontEntry["files"][number];
        expect(covers(file.unicodeRange, RUBLE), file.file).toBe(true);
        expect(glyphs(join(UI_KIT_ROOT, dir, file.file)).has(RUBLE), file.file).toBe(true);
        // Exactly one face of the weight claims ₽: the browser fetches that file and nothing else for it.
        expect(
          f.files.filter((x) => x.weight === w && covers(x.unicodeRange, RUBLE)).map((x) => x.subset),
        ).toEqual(["latin-ext"]);
      }
    },
  );

  test.each(NO_RUBLE)("%s: no ₽ in any Google Fonts subset, so no latin-ext ships", (family) => {
    const f = FONT_CATALOG.find((x) => x.family === family) as FontEntry;
    expect(f).toBeDefined();
    expect(f.files.some((x) => x.subset === "latin-ext")).toBe(false);
    const pkg = dirname(
      createRequire(join(UI_KIT_ROOT, "package.json")).resolve(`@fontsource/${f.id}/package.json`),
    );
    const meta = JSON.parse(readFileSync(join(pkg, "metadata.json"), "utf8")) as { subsets: string[] };
    for (const subset of meta.subsets)
      for (const w of f.weights)
        expect(
          glyphs(join(pkg, "files", `${f.id}-${subset}-${w}-normal.woff2`)).has(RUBLE),
          `${subset} ${w}`,
        ).toBe(false);
  });
});
