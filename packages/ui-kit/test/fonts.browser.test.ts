// V3-08 acceptance (browser): the ruble sign ₽ (U+20BD) of a price «1 500 ₽» is drawn with the theme font itself, not a
// system fallback. The fonts Chromium actually drew a node with come from DevTools (CSS.getPlatformFontsForNode); a page
// without the latin-ext faces (the catalog before V3-08) is the control that shows the check catches the fallback. The
// latin-ext file loads only on a page with ₽ (unicode-range), the platform fonts of src/v2/fonts.css draw ₽ too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FONT_CATALOG, fontEntry, fontFaceCss } from "../src/tokens/fonts.js";
import { PLATFORM_FONTS } from "../src/v2/font-catalog.js";
import { designSystemCss, designSystemV3 } from "../src/v3/design/index.js";
import { hasChromium, UI_KIT_ROOT } from "./helpers/demo.js";

const ORIGIN = "http://fonts.wizard.test";
type Drawn = { family: string; custom: boolean; glyphs: number };

let browser: Browser;
beforeAll(async () => {
  if (hasChromium) browser = await chromium.launch();
}, 60_000);
afterAll(async () => browser?.close());

const page = (style: string, body: string, head = "") =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8">${head}<style>${style}</style></head><body>${body}</body></html>`;

/** Opens the html on a fake origin that serves /_wizard/fonts/* (like the runtime) and src/v2/fonts.css with its files. */
async function open(html: string): Promise<{ page: Page; requested: string[] }> {
  const ctx = await browser.newContext({ locale: "ru-RU", viewport: { width: 800, height: 600 } });
  const p = await ctx.newPage();
  const requested: string[] = [];
  await p.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    if (path === "/src/v2/fonts.css")
      return route.fulfill({
        contentType: "text/css",
        body: readFileSync(join(UI_KIT_ROOT, "src/v2/fonts.css")),
      });
    const font = /^\/(_wizard\/fonts|fonts-platform)\/([a-z0-9-]+\.woff2)$/.exec(path);
    if (!font) return route.fulfill({ status: 404, body: "" });
    requested.push(font[2] as string);
    const dir = font[1] === "fonts-platform" ? "fonts-platform" : "fonts";
    return route.fulfill({
      contentType: "font/woff2",
      body: readFileSync(join(UI_KIT_ROOT, dir, font[2] as string)),
    });
  });
  await p.goto(`${ORIGIN}/`);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForFunction(() => document.fonts.status === "loaded");
  return { page: p, requested };
}

/**
 * Fonts Chromium drew the text of the node with: web font or system one, glyph count. The name comes from the font file;
 * a variable face names its default instance («Inter Medium», «Manrope ExtraLight»), so a web font whose name starts
 * with `family` is reported as `family`.
 */
async function drawnWith(p: Page, selector: string, family: string): Promise<Drawn[]> {
  const cdp = await p.context().newCDPSession(p);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const { root } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  await cdp.detach();
  return fonts.map((f) => ({
    family: f.isCustomFont && `${f.familyName} `.startsWith(`${family} `) ? family : f.familyName,
    custom: f.isCustomFont,
    glyphs: f.glyphCount,
  }));
}

const latinExt = (family: string, weight: number) =>
  fontEntry(family)?.files.find((x) => x.weight === weight && x.subset === "latin-ext")?.file;

describe.skipIf(!hasChromium)("ruble sign ₽ in chromium", () => {
  // A real v3 design system (V3-07); both of its faces have ₽ in latin-ext.
  const ds = designSystemV3({ archetype: "calm_medical", seed: 7, niche: "Клиника" });
  const display = ds.fonts.display.family;
  const text = ds.fonts.text.family;
  const weight = Number(ds.fonts.display.weight);
  const style = (css: string) =>
    `${css}body{margin:16px}.t{font-family:var(--ds-font-text);font-weight:400;font-size:20px}` +
    ".d{font-family:var(--ds-font-display);font-weight:var(--ds-font-display-weight);font-size:40px}";
  const price =
    '<h2 class="d">Приём врача <span id="d-num">1 500</span> <span id="d-rub">₽</span></h2>' +
    '<p class="t">Анализы от <span id="t-num">1 500</span> <span id="t-rub">₽</span></p>';

  test("v3 design system page: «1 500 ₽» — ₽ drawn with the display and the text face, latin-ext loaded on demand", async () => {
    expect(latinExt(display, weight), display).toBeDefined();
    expect(latinExt(text, 400), text).toBeDefined();
    const { page: p, requested } = await open(
      page(style(designSystemCss(ds, { fonts: true, theme: false })), price),
    );
    for (const [sel, family] of [
      ["#d-rub", display],
      ["#t-rub", text],
      ["#d-num", display],
      ["#t-num", text],
    ] as const)
      expect(await drawnWith(p, sel, family), sel).toEqual([
        { family, custom: true, glyphs: sel.endsWith("rub") ? 1 : 5 },
      ]);
    expect(requested).toContain(latinExt(display, weight));
    expect(requested).toContain(latinExt(text, 400));
    await p.context().close();
  });

  test("control: without the latin-ext faces (the catalog before V3-08) ₽ falls back to a system font", async () => {
    const css = designSystemCss(ds, { fonts: true, theme: false }).replace(
      /@font-face\{[^}]*latin-ext[^}]*\}/g,
      "",
    );
    expect(css).toContain("@font-face");
    const { page: p, requested } = await open(page(style(css), price));
    for (const [sel, family] of [
      ["#d-rub", display],
      ["#t-rub", text],
    ] as const) {
      const drawn = await drawnWith(p, sel, family);
      expect(drawn.length, sel).toBeGreaterThan(0);
      expect(
        drawn.every((d) => !d.custom && d.family !== family),
        sel,
      ).toBe(true);
    }
    expect(await drawnWith(p, "#t-num", text)).toEqual([{ family: text, custom: true, glyphs: 5 }]);
    expect(requested.filter((f) => f.includes("-latin-ext-"))).toEqual([]);
    await p.context().close();
  });

  test("a page without ₽ does not fetch any latin-ext file (unicode-range)", async () => {
    const css = designSystemCss(ds, { fonts: true, theme: false });
    const { page: p, requested } = await open(
      page(style(css), '<h2 class="d">Запись открыта</h2><p class="t">Приём с 9:00 до 21:00, Ё и ё.</p>'),
    );
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.filter((f) => f.includes("-latin-ext-"))).toEqual([]);
    await p.context().close();
  });

  test("every catalog family with latin-ext draws ₽ itself at 400 and 700", async () => {
    const faces = FONT_CATALOG.filter((f) => f.files.some((x) => x.subset === "latin-ext"));
    expect(faces.length).toBeGreaterThanOrEqual(19);
    const spans = faces.flatMap((f) =>
      f.weights.map(
        (w) => `<p style='font-family:"${f.family}";font-weight:${w}'><span id="${f.id}-${w}">₽</span></p>`,
      ),
    );
    const { page: p } = await open(page(fontFaceCss(faces.map((f) => f.family)), spans.join("")));
    const wrong: Record<string, Drawn[]> = {};
    for (const f of faces)
      for (const w of f.weights) {
        const drawn = await drawnWith(p, `#${f.id}-${w}`, f.family);
        if (JSON.stringify(drawn) !== JSON.stringify([{ family: f.family, custom: true, glyphs: 1 }]))
          wrong[`${f.family} ${w}`] = drawn;
      }
    expect(wrong).toEqual({});
    await p.context().close();
  });

  test("platform fonts v2 (src/v2/fonts.css): Inter and Source Serif 4 draw ₽ in every weight", async () => {
    const spans = PLATFORM_FONTS.flatMap((f) =>
      f.weights.map(
        (w) =>
          `<p style='font-family:"${f.family}";font-weight:${w}'>1 500 <span id="${f.id}-${w}">₽</span></p>`,
      ),
    );
    const { page: p, requested } = await open(
      page("", spans.join(""), `<link rel="stylesheet" href="${ORIGIN}/src/v2/fonts.css">`),
    );
    for (const f of PLATFORM_FONTS)
      for (const w of f.weights)
        expect(await drawnWith(p, `#${f.id}-${w}`, f.family), `${f.family} ${w}`).toEqual([
          { family: f.family, custom: true, glyphs: 1 },
        ]);
    expect(requested.filter((x) => x.includes("-latin-ext-"))).toHaveLength(
      PLATFORM_FONTS.flatMap((f) => f.weights).length,
    );
    await p.context().close();
  });
});
