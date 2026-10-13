// V4-07: the model proposes the design system, code checks it — contrast AA, catalog fonts (OFL, Cyrillic), banned
// defaults and the brand colour come back as issues; an accepted proposal becomes tokens that pass designLint; the
// most different directions of a verbalized answer are taken.
import { describe, expect, test } from "vitest";
import { contrast } from "../src/tokens/color.js";
import {
  cssHex,
  type DesignProposal,
  designDistance,
  designFromProposal,
  designLintErrors,
  pickDistinct,
  proposalFonts,
  proposalIssues,
} from "../src/v3/design/index.js";

const BAKERY: DesignProposal = {
  name: "Тёплая витрина",
  why: "Хлеб на закваске продают фото и честный тон.",
  probability: 0.4,
  base: "warm_craft",
  scheme: "light",
  colors: { bg: "#F7F5F2", ink: "#2A211B", accent: "#B5541B" },
  fonts: { display: "Alegreya", text: "Onest" },
  type: { scale: "classic", upper: false },
  radius: "soft",
  density: "regular",
  layout: "asymmetric",
  motion: "calm",
  imagery: { style: "крупные планы хлеба на столе, дневной свет", treatment: "warm-grade" },
};
const NIGHT: DesignProposal = {
  ...BAKERY,
  name: "Ночная пекарня",
  probability: 0.1,
  base: "night_contrast",
  scheme: "dark",
  colors: { bg: "#14161A", ink: "#F2F0EB", accent: "#E0A030", accent2: "#3FA796" },
  fonts: { display: "Unbounded", text: "Source Sans 3", why: "Широкий гротеск держит короткие ночные вывески." },
  type: { scale: "dramatic", upper: true },
  radius: "sharp",
  density: "compact",
  layout: "modular",
  motion: "lively",
  imagery: { style: "контрастные кадры печи ночью", treatment: "high-contrast" },
};
const SWISS: DesignProposal = {
  ...BAKERY,
  name: "Чистая сетка",
  probability: 0.3,
  base: "swiss",
  colors: { bg: "#FFFFFF", ink: "#111418", accent: "#C8102E" },
  fonts: { display: "Wix Madefor Display", text: "Wix Madefor Text" },
  type: { scale: "calm", upper: false },
  radius: "crisp",
  density: "airy",
  layout: "symmetric",
  motion: "still",
  imagery: { style: "предметная съёмка на белом", treatment: "natural" },
};
const opts = { seed: "s1", niche: "пекарня" };

describe("V4-07 design proposal: code checks, the model chooses", () => {
  test("valid proposals pass and become a design system with the model's own colours and fonts", () => {
    for (const p of [BAKERY, NIGHT, SWISS]) {
      expect(proposalIssues(p, opts), p.name).toEqual([]);
      const ds = designFromProposal(p, opts);
      expect(designLintErrors(ds), p.name).toEqual([]);
      const s = ds.palette[p.scheme];
      expect(cssHex(s.bg)).toBe(p.colors.bg.toUpperCase());
      expect(cssHex(s.ink)).toBe(p.colors.ink.toUpperCase());
      expect([ds.fonts.display.family, ds.fonts.text.family]).toEqual([p.fonts.display, p.fonts.text]);
      expect([ds.type.scale, ds.radius.set, ds.grid.layout, ds.motion.profile]).toEqual([
        p.type.scale,
        p.radius,
        p.layout,
        p.motion,
      ]);
      expect(ds.palette.scheme).toBe(p.scheme);
      expect(ds.name).toBe(p.name);
    }
    expect(cssHex(designFromProposal(BAKERY, opts).palette.light.accent)).toBe("#B5541B");
  });

  test("low contrast of the text and the accent comes back with the ratio and the way to fix it", () => {
    const issues = proposalIssues({ ...BAKERY, colors: { bg: "#F7F5F2", ink: "#9A948E", accent: "#F2D9C9" } });
    expect(issues.map((i) => i.code)).toEqual(["TEXT_CONTRAST", "ACCENT_CONTRAST"]);
    expect(issues[0]?.message).toMatch(/4,5:1/);
    expect(contrast("#9A948E", "#F7F5F2")).toBeLessThan(4.5);
  });

  test("fonts: only the catalog with a free licence and Cyrillic; no Inter, no Runet display defaults", () => {
    const f = proposalFonts();
    expect(f.display).not.toContain("Inter Tight");
    expect(f.display).not.toContain("Manrope");
    expect(f.text).not.toContain("Unbounded");
    const codes = (fonts: DesignProposal["fonts"]) => proposalIssues({ ...BAKERY, fonts }).map((i) => i.code);
    expect(codes({ display: "Playfair Display", text: "Onest" })).toEqual(["UNKNOWN_FONT"]);
    expect(codes({ display: "Manrope", text: "Onest" })).toEqual(["DISPLAY_FONT_BANNED"]);
    expect(codes({ display: "Alegreya", text: "Unbounded" })).toEqual(["TEXT_FONT_BANNED"]);
    expect(codes({ display: "Alegreya", text: "Inter Tight" })).toEqual(["TEXT_FONT_BANNED"]);
  });

  test("cream page, AI violet, a scheme that contradicts the page and a changed brand colour are refused", () => {
    const codes = (p: Partial<DesignProposal>, brandColor?: string) =>
      proposalIssues({ ...BAKERY, ...p }, brandColor ? { brandColor } : {}).map((i) => i.code);
    expect(codes({ colors: { ...BAKERY.colors, bg: "#F5EEDC" } })).toContain("CREAM_BG");
    expect(codes({ colors: { ...BAKERY.colors, accent: "#7C3AED" } })).toContain("AI_PALETTE");
    expect(codes({ colors: { ...BAKERY.colors, accent: "#7C3AED" } }, "#7C3AED")).not.toContain("AI_PALETTE");
    expect(codes({ scheme: "dark" })).toContain("SCHEME_MISMATCH");
    expect(codes({}, "#1F6FEB")).toEqual(["BRAND_COLOR"]);
    expect(codes({ colors: { ...BAKERY.colors, accent2: "#1F6FEB" } }, "#1F6FEB")).toEqual([]);
  });

  test("verbalized sampling: of five directions the three most different are taken, the likeliest first", () => {
    const near = { ...BAKERY, name: "Почти то же", probability: 0.35, radius: "round" as const };
    const near2 = { ...BAKERY, name: "И это", probability: 0.3, density: "airy" as const };
    const list = [BAKERY, near, near2, NIGHT, SWISS].map((p) => ({ ...p, design: designFromProposal(p, opts) }));
    const picked = pickDistinct(list, 3);
    expect(picked.map((x) => x.name)).toEqual(["Тёплая витрина", "Ночная пекарня", "Чистая сетка"]);
    for (let i = 0; i < 3; i++)
      for (let j = i + 1; j < 3; j++)
        expect(designDistance(picked[i]!.design, picked[j]!.design)).toBeGreaterThan(0.5);
  });
});
