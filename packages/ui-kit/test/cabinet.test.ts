// B2-34 acceptance (node): the cabinet look of client systems — warm neutral base of grill-7 #6, accents in the brand
// colour with the contrast of the platform v2 (4096 colours × 2 themes × theme presets), CSS variables only.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Theme } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { THEME_PRESET_LIST, themeToTokens, tokensToCss, V2_TOKENS } from "../src/index.js";
import {
  CABINET_EXTRA,
  CABINET_MAPPED,
  CABINET_TOKENS,
  cabinetCss,
  cabinetValues,
} from "../src/tokens/cabinet.js";
import { contrast } from "../src/tokens/color.js";
import { PLATFORM_COLORS } from "../src/v2/tokens.js";
import { UI_KIT_ROOT } from "./helpers/demo.js";

const SRC = join(UI_KIT_ROOT, "src");
const SCHEMES = ["light", "dark"] as const;
const read = (p: string) => readFileSync(p, "utf8");
const steps = Array.from({ length: 16 }, (_, i) => (i * 17).toString(16).padStart(2, "0"));
const COLORS = steps.flatMap((r) => steps.flatMap((g) => steps.map((b) => `#${r}${g}${b}`.toUpperCase())));

describe("cabinet look v2 (B2-34)", () => {
  test("src/tokens/cabinet.css is the output of cabinetCss() (UPDATE_CABINET_CSS=1 rewrites it)", () => {
    const path = join(SRC, "tokens/cabinet.css");
    if (process.env.UPDATE_CABINET_CSS === "1") writeFileSync(path, cabinetCss());
    expect(read(path)).toBe(cabinetCss());
  });

  test("warm neutral base of grill-7 #6 whatever the theme preset", () => {
    for (const preset of [undefined, ...THEME_PRESET_LIST.map((p) => p.id)]) {
      const theme: Theme = preset ? { preset } : {};
      for (const sc of SCHEMES) {
        const t = themeToTokens(theme, sc);
        const p = PLATFORM_COLORS[sc];
        expect([t["--w-cab-bg"], t["--w-cab-surface"], t["--w-cab-ink"], t["--w-cab-muted"]]).toEqual([
          p.bg,
          p.surface,
          p.ink,
          p.ink2,
        ]);
      }
    }
    expect(PLATFORM_COLORS.light.bg).toBe("#F8F7F4");
    expect(PLATFORM_COLORS.dark.bg).toBe("#1B1A18");
  });

  test("every mapped token is set in both schemes; --w-cab-* belong to V2_TOKENS (v1 tokens unchanged)", () => {
    expect(CABINET_TOKENS).toHaveLength(CABINET_MAPPED.length + CABINET_EXTRA.length);
    for (const sc of SCHEMES) {
      const t = themeToTokens({ accent: "#0F766E" }, sc);
      for (const name of CABINET_TOKENS) {
        expect(t[name], name).toBeTruthy();
        expect(V2_TOKENS).toContain(name);
      }
      for (const n of CABINET_MAPPED) expect(t[`--w-${n}`], n).toBeTruthy();
    }
    // Both schemes reach the page in the theme's own blocks: the look itself needs no script-made CSS.
    const css = tokensToCss({ accent: "#0F766E" });
    expect(css).toContain("--w-cab-accent:");
    expect(css.match(/--w-cab-bg:/g)).toHaveLength(3);
  });

  test("cabinet.css: only var(--w-cab-*) with fallbacks, specificity above the theme blocks, no colours elsewhere", () => {
    const css = cabinetCss();
    const sel = css.match(/^(\[data-wz-look[^{]+)\{/m)?.[1]?.trim() ?? "";
    expect(sel.match(/\[data-wz-look/g)).toHaveLength(3);
    for (const n of CABINET_MAPPED) expect(css).toMatch(new RegExp(`--w-${n}: var\\(--w-cab-${n}, `));
    expect(css).not.toMatch(/<style|@import/);
  });

  // Text pairs of the cabinet components: [what, text, background, minimum].
  const pairs = (v: ReturnType<typeof cabinetValues>): [string, string, string, number][] => [
    ["ink on bg", v.ink, v.bg, 4.5],
    ["ink on surface", v.ink, v.surface, 4.5],
    ["ink on sunken", v.ink, v.sunken, 4.5],
    ["muted on bg", v.muted, v.bg, 4.5],
    ["muted on surface", v.muted, v.surface, 4.5],
    ["muted on sunken", v.muted, v.sunken, 4.5],
    ["muted on neutral-soft", v.muted, v["neutral-soft"], 4.5],
    ["ok on ok-soft", v.ok, v["ok-soft"], 4.5],
    ["warn on warn-soft", v.warn, v["warn-soft"], 4.5],
    ["bad on bad-soft", v.bad, v["bad-soft"], 4.5],
    ["ok on surface", v.ok, v.surface, 4.5],
    ["bad on surface", v.bad, v.surface, 4.5],
    ["accent-ink on accent", v["accent-ink"], v.accent, 4.5],
    ["accent-ink on accent-strong", v["accent-ink"], v["accent-strong"], 4.5],
    ["accent fill vs bg", v.accent, v.bg, 3],
    ["accent fill vs surface", v.accent, v.surface, 3],
    ["accent-text on bg", v["accent-text"], v.bg, 4.5],
    ["accent-text on surface", v["accent-text"], v.surface, 4.5],
    ["accent-text on sunken", v["accent-text"], v.sunken, 4.5],
    ["accent-text on accent-soft", v["accent-text"], v["accent-soft"], 4.5],
    ["accent-text on accent-tint", v["accent-text"], v["accent-tint"], 4.5],
    ["focus vs surface", v.focus, v.surface, 3],
    ["focus vs bg", v.focus, v.bg, 3],
  ];

  test("4096 brand colours × 2 themes: accents and text in the cabinet pass WCAG AA", () => {
    const bad: string[] = [];
    for (const hex of COLORS)
      for (const sc of SCHEMES)
        for (const [what, fg, bg, min] of pairs(cabinetValues(hex, sc)))
          if (contrast(fg, bg) < min) bad.push(`${hex} ${sc} ${what}: ${contrast(fg, bg).toFixed(2)}`);
    expect(bad.slice(0, 20)).toEqual([]);
  });

  test("the theme's brand colour (presets and explicit accents) reaches the cabinet tokens", () => {
    for (const p of THEME_PRESET_LIST)
      for (const sc of SCHEMES) {
        const t = themeToTokens({ preset: p.id }, sc);
        expect(t["--w-cab-accent"]).toBe(cabinetValues(p.defaults.accent, sc).accent);
        // A colour that already stands out stays the owner's colour (only the shade for text may move).
        if (contrast(p.defaults.accent, PLATFORM_COLORS[sc].bg) >= 3 && sc === "light")
          expect(t["--w-cab-accent"]).toBe(p.defaults.accent.toUpperCase());
      }
    expect(themeToTokens({ accent: "#ffd600" }, "light")["--w-cab-accent"]).not.toBe("#FFD600");
    expect(themeToTokens({ accent: "#ffd600" }, "dark")["--w-cab-accent"]).toBe("#FFD600");
  });

  test("cabinet components: colours only through var(--w-*), motion only on transform/opacity", () => {
    const files = [
      "CabinetLayout",
      "DataTable",
      "StatusBoard",
      "RecordCard",
      "RecordForm",
      "States",
      "StatsReport",
      "GoalHints",
    ];
    for (const f of files) {
      const css = read(join(SRC, "components", `${f}.module.css`));
      const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(noComments.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi), f).toBeNull();
      for (const m of noComments.matchAll(/transition(?:-property)?:\s*([^;]+);/g)) {
        const props = (m[1] ?? "").split(",").map((x) => x.trim().split(/\s+/)[0]);
        for (const p of props) expect(["transform", "opacity", "none"], `${f}: ${m[0]}`).toContain(p);
      }
    }
    const kit = readdirSync(join(SRC, "components")).filter((f) => f.endsWith(".tsx"));
    for (const f of kit) expect(read(join(SRC, "components", f)), f).not.toMatch(/createElement\("style"\)/);
  });
});
