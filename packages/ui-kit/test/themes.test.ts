// M2-42 / B2-36 acceptance (vitest): ten presets × 4096 brand colours keep AA contrast in both schemes; v1 themes
// unchanged; v2 deterministic; specs/ui/themes.yaml = presets.ts; themeForNiche and themeLint.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_FONTS, THEME_PRESETS, type Theme } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  contrast,
  FONT_CATALOG,
  PALETTE,
  type Scheme,
  THEME_PRESET_LIST,
  themeFonts,
  themeForNiche,
  themeLint,
  themeToTokens,
  tokensToCss,
  V2_TOKENS,
} from "../src/index.js";
import { UI_KIT_ROOT } from "./helpers/demo.js";

// @ts-expect-error — plain ESM module without types
const { parseYamlFiles } = await import("../../../tools/specs/validate.mjs");

const SCHEMES: Scheme[] = ["light", "dark"];
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const GRID: string[] = [];
for (let r = 0; r < 16; r++)
  for (let g = 0; g < 16; g++)
    for (let b = 0; b < 16; b++) GRID.push(`#${hex2(r * 17)}${hex2(g * 17)}${hex2(b * 17)}`.toUpperCase());

const c = (t: Record<string, string>, a: string, b: string) => contrast(t[a] as string, t[b] as string);

describe("presets", () => {
  test("ten presets with ids of the AppSpec enum, Russian names, niches, photo style and draft status", () => {
    expect(THEME_PRESET_LIST.map((p) => p.id)).toEqual([...THEME_PRESETS]);
    expect(THEME_PRESET_LIST.length).toBeGreaterThanOrEqual(8);
    expect(THEME_PRESET_LIST.length).toBeLessThanOrEqual(10);
    for (const p of THEME_PRESET_LIST) {
      expect(p.name).toMatch(/[А-Яа-яЁё]/);
      expect(p.description.length).toBeGreaterThan(20);
      expect(p.niches.length).toBeGreaterThanOrEqual(4);
      expect(p.photoStyle).toMatch(/[а-яё]/);
      expect(p.draft).toBe(true);
      expect(THEME_FONTS).toContain(p.defaults.font);
      expect(THEME_FONTS).toContain(p.defaults.headingFont);
      expect(FONT_CATALOG.map((f) => f.family)).toEqual(
        expect.arrayContaining([p.defaults.font, p.defaults.headingFont]),
      );
    }
  });

  test("specs/ui/themes.yaml = presets.ts: ids, names, niches, defaults, depth, rhythm, headings, photo style, graphic", () => {
    const path = join(UI_KIT_ROOT, "../../specs/ui/themes.yaml");
    const loaded = (parseYamlFiles([path]) as Record<string, { ok?: { presets: unknown[] } }>)[path];
    const fromSpec = loaded?.ok?.presets ?? [];
    const fromCode = THEME_PRESET_LIST.map((p) => ({
      id: p.id,
      name: p.name,
      niches: p.niches,
      defaults: p.defaults,
      depth: p.depth,
      space: p.space,
      heading: p.heading,
      photoStyle: p.photoStyle,
      graphic: p.graphic,
    }));
    const pick = (x: unknown) => {
      const { looks: _l, why_font: _w, ...rest } = x as Record<string, unknown>;
      return rest;
    };
    expect(fromSpec.map(pick)).toEqual(fromCode);
    expect(readFileSync(path, "utf8")).toContain(`${THEME_PRESET_LIST.length} тем × 4096`);
  });

  test("every preset has its own font pair and the heading face differs from the text face", () => {
    const pairs = THEME_PRESET_LIST.map((p) => `${p.defaults.headingFont}+${p.defaults.font}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    for (const p of THEME_PRESET_LIST) expect(p.defaults.headingFont).not.toBe(p.defaults.font);
  });

  test.each(THEME_PRESET_LIST.flatMap((p) => SCHEMES.map((s) => [p.id, s] as const)))(
    "%s/%s: ink and muted ≥ 4.5 on bg, surface, surface-alt; status tones ≥ 4.5 on surface and soft",
    (preset, scheme) => {
      const t = themeToTokens({ preset }, scheme);
      for (const fg of ["--w-ink", "--w-muted"])
        for (const bg of ["--w-bg", "--w-surface", "--w-surface-alt"])
          expect(c(t, fg, bg)).toBeGreaterThanOrEqual(4.5);
      for (const tone of ["ok", "warn", "bad"] as const) {
        expect(contrast(PALETTE[scheme][tone], t[`--w-${tone}-soft`] as string)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(PALETTE[scheme][tone], t["--w-surface"] as string)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(PALETTE[scheme][tone], t["--w-bg"] as string)).toBeGreaterThanOrEqual(4.5);
      }
      expect(c(t, "--w-muted", "--w-neutral-soft")).toBeGreaterThanOrEqual(4.5);
      for (const bg of ["--w-bg", "--w-surface"]) expect(c(t, "--w-muted", bg)).toBeGreaterThanOrEqual(3);
    },
  );

  test.each(SCHEMES)(
    "10 presets + v1 × 4096 brand colours: text and buttons ≥ 4.5:1, button edge ≥ 3:1 (%s)",
    (scheme) => {
      const failures: string[] = [];
      for (const preset of [undefined, ...THEME_PRESETS]) {
        for (const accent of GRID) {
          const t = themeToTokens({ accent, ...(preset ? { preset } : {}) }, scheme);
          const checks: [string, number, number][] = [
            ["ink", c(t, "--w-accent-ink", "--w-accent"), 4.5],
            ["ink/strong", c(t, "--w-accent-ink", "--w-accent-strong"), 4.5],
            ["text/bg", c(t, "--w-accent-text", "--w-bg"), 4.5],
            ["text/surface", c(t, "--w-accent-text", "--w-surface"), 4.5],
            ["text/soft", c(t, "--w-accent-text", "--w-accent-soft"), 4.5],
            ["text/tint", c(t, "--w-accent-text", "--w-accent-tint"), 4.5],
            ["text/alt", c(t, "--w-accent-text", "--w-surface-alt"), 4.5],
            ["ink/tint", c(t, "--w-ink", "--w-accent-tint"), 4.5],
            ["edge/bg", c(t, "--w-accent-edge", "--w-bg"), 3],
          ];
          for (const [name, v, min] of checks)
            if (v < min) failures.push(`${preset ?? "v1"} ${accent} ${name} ${v.toFixed(2)}`);
          if (t["--w-accent"] !== accent) failures.push(`${accent} changed`);
        }
      }
      expect(failures.slice(0, 20)).toEqual([]);
    },
  );

  test("overlay text on an image: white on 55% black over a white pixel ≥ 4.5", () => {
    // #FFFFFF under rgba(0,0,0,0.55) → #737373.
    expect(contrast("#FFFFFF", "#737373")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("v1 compatibility and determinism", () => {
  test("a v1 theme without preset/headingFont: v1 tokens equal the v1 output, v2 adds only V2_TOKENS", () => {
    const theme: Theme = {
      accent: "#9D174D",
      font: "Manrope",
      radius: 16,
      density: "regular",
      mode: "light",
    };
    for (const scheme of SCHEMES) {
      const t = themeToTokens(theme, scheme);
      expect(Object.keys(t).filter((k) => !V2_TOKENS.includes(k as never))).toHaveLength(29);
      expect(t["--w-font"]).toBe('"Manrope", system-ui, -apple-system, "Segoe UI", sans-serif');
      expect(t["--w-font-heading"]).toBe('"Manrope", system-ui, -apple-system, "Segoe UI", sans-serif');
      expect(t["--w-bg"]).toBe(PALETTE[scheme].bg);
    }
  });

  test("v2 is deterministic and explicit fields win over the preset", () => {
    const theme: Theme = { preset: "warm", accent: "#0A7D3E" };
    expect(themeToTokens(theme, "light")).toEqual(themeToTokens({ ...theme }, "light"));
    const t = themeToTokens(theme, "light");
    expect(t["--w-accent"]).toBe("#0A7D3E");
    expect(t["--w-bg"]).toBe("#FBF6F0");
    expect(t["--w-font-heading"]).toBe('"Lora", Georgia, "Times New Roman", serif');
    expect(t["--w-radius"]).toBe("16px");
    expect(themeToTokens({ preset: "warm", radius: 4 }, "light")["--w-radius"]).toBe("4px");
    expect(themeToTokens({ preset: "warm" }, "light")["--w-accent"]).toBe("#A84B25");
    expect(themeToTokens({ preset: "calm" }, "light")["--w-shadow-md"]).toBe("none");
  });

  test("tokensToCss with fonts: @font-face only for the theme fonts, from /_wizard/fonts, swap", () => {
    const css = tokensToCss({ preset: "bright" }, undefined, { fonts: true });
    expect(themeFonts({ preset: "bright" })).toEqual(["Onest", "Unbounded"]);
    expect(css).toContain('font-family:"Unbounded"');
    expect(css).toContain('font-family:"Onest"');
    expect(css).not.toContain('font-family:"Lora"');
    expect(css).toContain("src:url(/_wizard/fonts/unbounded-cyrillic-700-");
    expect(css).toContain("font-display:swap");
    expect(css).not.toMatch(/googleapis|gstatic|https?:/);
    expect(tokensToCss(undefined)).not.toContain("@font-face");
  });
});

describe("themeForNiche", () => {
  test.each([
    ["Студия маникюра в Казани", "warm"],
    ["Пекарня и торты на заказ", "bistro"],
    ["Кофейня у метро", "bistro"],
    ["Юридическая консультация для бизнеса", "strict"],
    ["CRM для учёта заявок отдела продаж", "strict"],
    ["Школа танцев для детей", "bright"],
    ["Онлайн-курсы английского", "academy"],
    ["Репетитор по математике, подготовка к ЕГЭ", "academy"],
    ["Частный психолог, запись на консультацию", "calm"],
    ["Стоматологическая клиника", "care"],
    ["Ветеринарная клиника", "care"],
    ["Барбершоп в центре", "workshop"],
    ["Ремонт квартир под ключ", "workshop"],
    ["Свадебный фотограф", "boutique"],
    ["Ювелирная мастерская", "boutique"],
    ["Концерты и фестивали в клубе", "poster"],
    ["Что-то совсем непонятное", "strict"],
  ])("%s → %s", (niche, id) => expect(themeForNiche(niche)).toBe(id));
});

describe("themeLint", () => {
  test("a preset with its own colour has nothing to explain", () => {
    for (const p of THEME_PRESET_LIST) expect(themeLint({ preset: p.id, mode: "light" })).toEqual([]);
  });

  test("a pale brand colour: accent text adjusted and a contrasting edge, in Russian", () => {
    const notes = themeLint({ accent: "#FFE066", mode: "light" });
    expect(notes.map((n) => n.code)).toEqual(
      expect.arrayContaining(["ACCENT_TEXT_ADJUSTED", "ACCENT_LOW_EDGE"]),
    );
    for (const n of notes) expect(n.message).toMatch(/[А-Яа-я]/);
    expect(themeLint({ accent: "#808080", mode: "light" }).map((n) => n.code)).toContain("ACCENT_GREY");
  });
});
