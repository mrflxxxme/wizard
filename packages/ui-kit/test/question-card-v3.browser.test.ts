// V3-03 acceptance 1 (UI) in chromium: the question card of the v3 interview at 390 and 1280, light and dark — why the
// recommendation, «Решите за меня» and «Дальше решай сам» visible and pressable, touch targets on the phone, WCAG AA
// contrast, labels, no horizontal scroll; a v2 card without the new props has none of them. Screenshots in
// test/artifacts. The page is built by vite from test/question-card-v3 (its own small entry, not the demo).
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { build, type PreviewServer, preview } from "vite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { A11Y_SCRIPT, type A11yApi } from "./a11y/checks.js";
import { ARTIFACTS, hasChromium, UI_KIT_ROOT } from "./helpers/demo.js";

const ROOT = join(UI_KIT_ROOT, "test/question-card-v3");
const OUT = join(UI_KIT_ROOT, "test/.generated/question-card-v3");

async function a11y<K extends keyof A11yApi>(page: Page, check: K) {
  await page.addScriptTag({ content: A11Y_SCRIPT });
  return page.evaluate(
    (c) => (window as unknown as { __a11y: Record<string, () => unknown> }).__a11y[c]?.(),
    check,
  ) as Promise<ReturnType<A11yApi[K]>>;
}

describe.skipIf(!hasChromium)("v3 question card in chromium", () => {
  let server: PreviewServer;
  let browser: Browser;
  let url = "";

  beforeAll(async () => {
    const common = {
      root: ROOT,
      configFile: false as const,
      logLevel: "error" as const,
      esbuild: { jsx: "automatic" as const },
    };
    await build({ ...common, base: "./", build: { outDir: OUT, emptyOutDir: true } });
    server = await preview({
      ...common,
      build: { outDir: OUT },
      preview: { port: 0, host: "127.0.0.1", strictPort: false },
    });
    url = server.resolvedUrls?.local[0] ?? "";
    browser = await chromium.launch();
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    if (server) await new Promise<void>((r) => server.httpServer.close(() => r()));
  });

  async function open(viewport: { width: number; height: number }, theme: "light" | "dark") {
    const ctx = await browser.newContext({
      viewport,
      locale: "ru-RU",
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    const page = await ctx.newPage();
    await page.goto(`${url}?theme=${theme}`);
    await page.waitForFunction(
      () => (window as unknown as { __wz?: { ready: boolean } }).__wz?.ready === true,
    );
    await page.evaluate(() => document.fonts.ready);
    return page;
  }

  const SIZES = [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ] as const;
  for (const vp of SIZES)
    for (const theme of ["light", "dark"] as const)
      test(`${vp.width}px ${theme}: why, «Решите за меня», «Дальше решай сам»; contrast, labels, touch, no scroll`, async () => {
        const page = await open(vp, theme);
        const card = page.getByTestId("v3-card");
        await expect
          .poll(() => card.getByTestId("p-question-why").textContent())
          .toContain("Почему советуем:");
        const delegate = card.getByTestId("p-question-delegate");
        const finish = card.getByTestId("p-question-finish");
        expect(await delegate.textContent()).toBe("Решите за меня");
        expect(await finish.textContent()).toBe("Дальше решай сам");
        for (const b of [delegate, finish]) {
          const box = await b.boundingBox();
          expect(box && box.x >= 0 && box.x + box.width <= vp.width).toBe(true);
        }
        await page.screenshot({
          path: join(ARTIFACTS, `question-v3-${vp.width}-${theme}.png`),
          fullPage: true,
        });
        expect(await a11y(page, "overflow")).toEqual([]);
        expect(await a11y(page, "labels")).toEqual([]);
        expect(await a11y(page, "contrast")).toEqual([]);
        if (vp.width === 390) expect(await a11y(page, "touch")).toEqual([]);
        await page.context().close();
      });

  test("the buttons act; a v2 card without the new props has neither the buttons nor the note", async () => {
    const page = await open({ width: 390, height: 844 }, "light");
    const said = page.getByTestId("said");
    await page.getByTestId("v3-card").getByTestId("p-question-delegate").click();
    expect(await said.textContent()).toBe("delegate");
    await page.getByTestId("v3-card").getByTestId("p-question-finish").click();
    expect(await said.textContent()).toBe("finish");
    await page.getByTestId("v3-card").getByTestId("p-question-option-o2").click();
    expect(await said.textContent()).toBe("option:o2");
    const v2 = page.getByTestId("v2-card");
    expect(await v2.getByTestId("p-question-assist").count()).toBe(0);
    expect(await v2.getByTestId("p-question-why").count()).toBe(0);
    expect(await v2.getByTestId("p-question-submit").count()).toBe(1);
    await page.context().close();
  });
});
