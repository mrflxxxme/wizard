// ui-kit.yaml#tokens.acceptance (vitest part) and a11y#contrast for token pairs.
import { describe, expect, test } from "vitest";
import { contrast, PALETTE, type Scheme, themeToTokens, tokensToCss } from "../src/index.js";

const SCHEMES: Scheme[] = ["light", "dark"];
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const GRID: string[] = [];
for (let r = 0; r < 16; r++)
  for (let g = 0; g < 16; g++)
    for (let b = 0; b < 16; b++) GRID.push(`#${hex2(r * 17)}${hex2(g * 17)}${hex2(b * 17)}`.toUpperCase());

describe("themeToTokens contrast", () => {
  test("grid has 4096 accents", () => expect(new Set(GRID).size).toBe(4096));

  test.each(SCHEMES)("every accent of the 16³ grid passes 4.5:1 (%s)", (scheme) => {
    const failures: string[] = [];
    for (const accent of GRID) {
      const t = themeToTokens({ accent }, scheme);
      const ink = contrast(t["--w-accent-ink"] as string, t["--w-accent"] as string);
      const onBg = contrast(t["--w-accent-text"] as string, t["--w-bg"] as string);
      const onSurface = contrast(t["--w-accent-text"] as string, t["--w-surface"] as string);
      const onSoft = contrast(t["--w-accent-text"] as string, t["--w-accent-soft"] as string);
      if (Math.min(ink, onBg, onSurface, onSoft) < 4.5)
        failures.push(`${accent}: ${ink} ${onBg} ${onSurface}`);
      expect(t["--w-accent"]).toBe(accent);
    }
    expect(failures).toEqual([]);
  });

  test.each(SCHEMES)("ink/muted/tones on bg/surface/soft ≥ 4.5 (%s)", (scheme) => {
    const t = themeToTokens(undefined, scheme);
    const bgs = [t["--w-bg"], t["--w-surface"]] as string[];
    for (const fg of [t["--w-ink"], t["--w-muted"]] as string[])
      for (const bg of bgs) expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    for (const tone of ["ok", "warn", "bad"] as const) {
      expect(contrast(PALETTE[scheme][tone], t[`--w-${tone}-soft`] as string)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(PALETTE[scheme][tone], t["--w-surface"] as string)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(t["--w-muted"] as string, t["--w-neutral-soft"] as string)).toBeGreaterThanOrEqual(4.5);
    // Control borders ≥ 3:1 are drawn with --w-muted (a11y#contrast).
    for (const bg of bgs) expect(contrast(t["--w-muted"] as string, bg)).toBeGreaterThanOrEqual(3);
  });
});

describe("themeToTokens determinism", () => {
  test("defaults snapshot", () => {
    expect({
      light: themeToTokens(undefined, "light"),
      dark: themeToTokens(undefined, "dark"),
    }).toMatchSnapshot();
  });

  test("pure: same input → same output, no DOM needed", () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe("undefined");
    const theme = { accent: "#C2410C", radius: 12, density: "compact", font: "Manrope" } as const;
    expect(themeToTokens(theme, "dark")).toEqual(themeToTokens({ ...theme }, "dark"));
    const t = themeToTokens(theme, "light");
    expect(t["--w-radius"]).toBe("12px");
    expect(t["--w-radius-sm"]).toBe("6px");
    expect(t["--w-density-control"]).toBe("36px");
    expect(t["--w-font"]).toBe('"Manrope", system-ui, -apple-system, "Segoe UI", sans-serif');
  });

  test("missing fields fall back to defaults", () => {
    expect(themeToTokens({}, "light")).toEqual(themeToTokens(undefined, "light"));
    expect(themeToTokens(undefined, "light")["--w-accent"]).toBe("#2F46D8");
  });

  test("tokens.css has light root, forced dark and auto-dark media blocks", () => {
    const css = tokensToCss(undefined);
    expect(css).toMatch(/^:root\{--w-accent:#2F46D8;/);
    expect(css).toContain("[data-wz-mode=dark]{");
    expect(css).toContain("@media (prefers-color-scheme: dark){[data-wz-mode=auto]{");
    expect(css).toContain("--w-bg:#0F1115;");
  });
});
