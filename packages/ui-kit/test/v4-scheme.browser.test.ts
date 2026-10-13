// V4-01 (D79): a public site keeps the scheme of its direction — the visitor's OS theme does not switch it to the
// other palette. ui/design.css is built with autoScheme: false (codegen); a light direction stays light under
// prefers-color-scheme: dark and a dark one stays dark under light.
import { type Browser, chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { designSystemCss, designSystemV3 } from "../src/v3/design/index.js";
import { hasChromium } from "./helpers/demo.js";

const CASES = [
  { archetype: "editorial", os: "dark" },
  { archetype: "night_contrast", os: "light" },
] as const;

let browser: Browser;
beforeAll(async () => {
  if (hasChromium) browser = await chromium.launch();
}, 60_000);
afterAll(async () => browser?.close());

/** Computed value of --ds-color-bg on the page root under the given OS scheme. */
async function rootBg(css: string, colorScheme: "light" | "dark"): Promise<string> {
  const ctx = await browser.newContext({ colorScheme });
  const page = await ctx.newPage();
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body></body></html>`);
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--ds-color-bg").trim(),
  );
  await ctx.close();
  return bg;
}

describe.skipIf(!hasChromium)("public site scheme (autoScheme: false)", () => {
  for (const c of CASES) {
    test(`${c.archetype} keeps its scheme when the OS is ${c.os}`, async () => {
      const ds = designSystemV3({ archetype: c.archetype, brandColor: "#2F6B4F", seed: 3, niche: "Студия" });
      const css = designSystemCss(ds, { theme: false, autoScheme: false });
      const own = ds.palette[ds.palette.scheme].bg;
      expect(css).not.toContain("prefers-color-scheme");
      expect(await rootBg(css, c.os)).toBe(own);
      // The default (autoScheme on) still follows the OS — the platform's own previews rely on it.
      const auto = designSystemCss(ds, { theme: false });
      expect(auto).toContain(`@media (prefers-color-scheme: ${c.os})`);
    });
  }
});
