// M2-42 acceptance: the font catalog check (D64). Every shipped font has an allowed license, its source and license
// text are recorded in the catalog and THIRD_PARTY_NOTICES.md, the cyrillic files have А–я, Ё, ё; nothing else ships.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_FONTS } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { FONT_CATALOG, fontFaceCss, fontFiles } from "../src/index.js";
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
      expect(f.files.map((x) => x.subset).sort()).toEqual(["cyrillic", "cyrillic", "latin", "latin"]);
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
      const need = file.subset === "cyrillic" ? CYRILLIC : LATIN;
      const missing = need.filter((cp) => !cps.has(cp)).map((cp) => String.fromCodePoint(cp));
      expect(missing).toEqual([]);
    },
  );

  test("@font-face: only own origin, swap, unicode-range", () => {
    const css = fontFaceCss(["PT Serif", "Нет такого"]);
    expect(css.match(/@font-face/g)).toHaveLength(4);
    expect(css).not.toMatch(/https?:|googleapis|gstatic/);
    expect(css).toContain("unicode-range:U+0301,U+0400-045F");
  });
});
