// The seam of V3-07 and V3-08 (builder-v3.md §3 C2, C3): every theme variable the section patterns are written
// against is defined by the CSS of every design system — in the Tailwind theme or on :root.
import { describe, expect, it } from "vitest";
import { ARCHETYPES, DESIGN_THEME_CSS, designSystemCss, designSystemV3 } from "../src/v3/design/index.js";
import { MOTION_PROFILE_VAR, PATTERN_THEME, patternThemeVars } from "../src/v3/patterns/index.js";

const themeVars = new Set([...DESIGN_THEME_CSS.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));

describe("design system ↔ section patterns", () => {
  it("the Tailwind theme defines every key of the pattern contract", () => {
    const missing = patternThemeVars().filter((v) => v !== MOTION_PROFILE_VAR && !themeVars.has(v));
    expect(missing).toEqual([]);
    expect(PATTERN_THEME.color.length).toBeGreaterThan(0);
  });

  it("each archetype sets the motion profile and the colours of both schemes", () => {
    for (const a of ARCHETYPES) {
      const ds = designSystemV3({ archetype: a.id, seed: 1, niche: "кофейня" });
      const css = designSystemCss(ds);
      expect(css, a.id).toMatch(new RegExp(`${MOTION_PROFILE_VAR}:(still|calm|lively);`));
      for (const role of [
        "bg",
        "ink",
        "surface",
        "surface-alt",
        "accent",
        "accent-ink",
        "overlay",
        "overlay-ink",
        "focus",
      ])
        expect(css, `${a.id}: ${role}`).toContain(`--ds-color-${role}:`);
    }
  });
});
