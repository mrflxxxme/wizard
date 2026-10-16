// V4-11 acceptance in chromium, 1440 and 390 px: the canvas v4 on the recorded feed «клиника» (режим показа, a system of
// the modules pipeline v2 — it opens in the same canvas as v3). Before the build the chat is open over the empty canvas;
// the plan is approved from the chat; the build gives the window back to the system (the bar on top, the ring of the
// island); the built draft fills the window at its real width and its form works like in its own tab; the panels slide
// over without changing that width and close with Esc or a click on the system; «Телефон» shows it at 390 px; «Открыть
// в новой вкладке» takes a new one-time token on every open (the stub answers 404 replay to a reused one, like the
// runtime); Ctrl+B hides the island. A failed build is explained in words with the details under «Подробнее».
// Screenshots in test/artifacts/canvas-v4-*.png.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const feed = loadCanvasFeed();
/** Index of build_stage{compile, started}: the build waits there (half done) so the bar and the ring can be checked. */
const HOLD = feed.build.findIndex((e) => e.type === "build_stage" && e.payload.stage === "compile");

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const width = async (page: Page, id: string) => (await page.getByTestId(id).boundingBox())?.width ?? 0;

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(ARTIFACTS, `canvas-v4-${name}.png`), fullPage: false });
}

async function startClinic(page: Page): Promise<string> {
  await page.getByTestId("start-prompt").fill(feed.brief);
  await page.getByTestId("start-submit").click();
  await page.waitForURL(/\/s\/[0-9a-f-]{36}$/);
  return page.url().split("/s/")[1] as string;
}

describe.skipIf(!hasChromium)("canvas v4 in chromium (feed «клиника», режим показа)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: feed, eventDelayMs: 30 });
  }, 180_000);
  afterAll(async () => h?.close());

  const SIZES = [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ] as const;
  for (const vp of SIZES)
    test(`${vp.width}px: chat before the build → approval → the system on the whole window, panels over it`, async () => {
      const tag = `${vp.width}`;
      const phone = vp.width < 600;
      const page = await h.page({ viewport: vp, colorScheme: "light", reducedMotion: "reduce" });
      await startClinic(page);

      // Nothing built yet: the chat is open over the empty canvas, the question in it.
      await page.getByTestId("canvas-question").waitFor();
      expect(await page.getByTestId("canvas-sheet").isVisible()).toBe(true);
      expect(await page.getByTestId("canvas-empty").textContent()).toContain("Здесь появится ваша система");
      expect(await page.getByTestId("canvas-board").count()).toBe(0);
      expect(await noHorizontalScroll(page)).toBe(true);
      await shot(page, `${tag}-1-interview`);

      // The plan of a v2 system is approved from the chat; the build closes the panels, the bar runs on top.
      await page.getByTestId("canvas-rest").click();
      await page.getByTestId("canvas-plan-card").waitFor({ timeout: 15_000 });
      h.mock.holdBuildAt = HOLD;
      await page.getByTestId("canvas-approve").click();
      await expect.poll(() => h.mock.buildHeld, { timeout: 10_000 }).toBe(true);
      await page.getByTestId("canvas-eta").waitFor();
      expect(await page.getByTestId("canvas-sheet").count()).toBe(0);
      expect(Number(await page.getByTestId("canvas-eta").getAttribute("aria-valuenow"))).toBeGreaterThan(0);
      await page.keyboard.press("Control+k");
      await page.getByTestId("canvas-tile-build").click();
      expect(await page.getByTestId("canvas-build-step").textContent()).toBe("Подбираю фото");
      await shot(page, `${tag}-2-build`);
      await page.keyboard.press("Escape");
      expect(await page.getByTestId("canvas-panel-build").count()).toBe(0);
      h.mock.releaseBuild();

      // Built: the draft fills the window at its real width.
      const site = page.getByTestId("canvas-frame-site");
      await site.waitFor({ timeout: 20_000 });
      expect(await page.getByTestId("canvas-eta").count()).toBe(0);
      expect(await width(page, "canvas-frame-site")).toBe(vp.width);
      const frame = page.frameLocator('[data-testid="canvas-frame-site"]');
      await frame.getByTestId("stub-route").waitFor();
      expect(
        await page
          .frames()
          .find((f) => f.url().includes("--draft."))
          ?.evaluate(() => window.innerWidth),
      ).toBe(vp.width);
      expect(await noHorizontalScroll(page)).toBe(true);
      await shot(page, `${tag}-3-system`);

      // A form of the system works in the canvas like in its own tab.
      await frame.getByTestId("stub-name").fill("Анна");
      await frame.getByTestId("stub-send").click();
      await frame.getByTestId("stub-sent").waitFor();
      expect(h.mock.stubLeads).toContain("Анна");

      // The chat slides over the system: the system keeps its width; Esc closes it.
      await page.getByTestId("p-composer-input").click();
      await page.getByTestId("canvas-sheet").waitFor();
      expect(await width(page, "canvas-frame-site")).toBe(vp.width);
      await shot(page, `${tag}-4-chat`);
      await page.keyboard.press("Escape");
      expect(await page.getByTestId("canvas-sheet").count()).toBe(0);
      // A click on the system closes the panel too.
      await page.getByTestId("p-composer-input").click();
      await page.getByTestId("canvas-sheet").waitFor();
      if (!phone) {
        await frame.getByTestId("stub-sent").click();
        await page.getByTestId("canvas-sheet").waitFor({ state: "detached" });
      } else await page.getByTestId("canvas-panel-close").click();

      // «Телефон»: 390 px in the middle of the window (on a phone the system is at its own width already).
      if (!phone) {
        await page.getByTestId("p-composer-input").click();
        await page.getByTestId("canvas-device-phone").click();
        await expect.poll(() => width(page, "canvas-frame-site")).toBe(390);
        await shot(page, `${tag}-5-phone`);
        await page.getByTestId("canvas-device-desktop").click();
        await expect.poll(() => width(page, "canvas-frame-site")).toBe(vp.width);
      } else expect(await page.getByTestId("canvas-device-phone").isVisible()).toBe(false);

      // «Открыть в новой вкладке» twice: each tab logs in with its own token (a reused one would be 404 replay).
      for (let i = 0; i < 2; i++) {
        await page.getByTestId("p-composer-input").click();
        const [tab] = await Promise.all([
          page.context().waitForEvent("page"),
          page.getByTestId("canvas-open-tab").click(),
        ]);
        await tab.getByTestId("stub-route").waitFor({ timeout: 10_000 });
        expect(await tab.content()).not.toContain("replay");
        await tab.close();
      }
      expect(h.mock.usedTokens.size).toBeGreaterThanOrEqual(3);

      // V5-07: at rest only the 48 px pill; no island of icons; Ctrl+K unfolds, Esc folds.
      await page.keyboard.press("Escape");
      expect(await page.getByTestId("canvas-island").count()).toBe(0);
      expect(await page.getByTestId("canvas-sheet").count()).toBe(0);
      const pill = await page.getByTestId("canvas-cmd").boundingBox();
      expect(pill?.height ?? 0).toBeLessThanOrEqual(48);
      await page.keyboard.press("Control+k");
      await page.getByTestId("canvas-tiles").waitFor();
      await page.keyboard.press("Escape");
      await page.getByTestId("canvas-tiles").waitFor({ state: "detached" });
      expect(await noHorizontalScroll(page)).toBe(true);
      await page.context().close();
    }, 120_000);
});

describe.skipIf(!hasChromium)("canvas v4: a failed build is explained in words", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({
      feed: loadFeed("forum"),
      canvas: feed,
      eventDelayMs: 20,
      canvasFailAfter: "compile",
    });
  }, 180_000);
  afterAll(async () => h?.close());

  test("MODULE_BUG: the chat opens with plain words, details under «Подробнее»; retry builds the system", async () => {
    const page = await h.page({ viewport: { width: 1440, height: 900 } });
    await startClinic(page);
    await page.getByTestId("canvas-question").waitFor();
    await page.getByTestId("canvas-rest").click();
    await page.getByTestId("canvas-approve").click();
    const fail = page.getByTestId("canvas-failure");
    await fail.waitFor({ timeout: 15_000 });
    expect(await page.getByTestId("canvas-sheet").isVisible()).toBe(true);
    expect((await fail.textContent()) ?? "").toContain("Сбой в одном из наших готовых блоков");
    expect(await page.getByTestId("canvas-failure-more").getAttribute("open")).toBeNull();
    await page.getByTestId("canvas-failure-more").locator("summary").click();
    expect(await page.getByTestId("canvas-failure-more").textContent()).toContain("MODULE_BUG");
    await shot(page, "1440-failed");
    h.mock.opts.canvasFailAfter = undefined;
    await page.getByTestId("canvas-retry").click();
    await page.getByTestId("canvas-frame-site").waitFor({ timeout: 20_000 });
    await page.context().close();
  });

  // V4-11: every failure in plain words without its code, and only the action the server supports for it.
  for (const c of [
    {
      code: "RUN_TIMEOUT",
      message_ru: "run exceeded 45 min",
      words: "Сборка шла дольше обычного",
      action: "retry",
      button: "Повторить",
    },
    {
      code: "GATES_FAILED",
      message_ru: "G1 failed: 2 blockers",
      words: "не прошла проверки",
      action: "fix",
      button: "Исправить",
    },
    {
      code: "INSUFFICIENT_CREDITS",
      message_ru: "Недостаточно кредитов",
      words: "Пополните баланс",
      action: "billing",
      button: null,
    },
    {
      code: "LLM_BUDGET_EXHAUSTED",
      message_ru: "cap reached",
      words: "лимит работы моделей исчерпан",
      action: "none",
      button: null,
    },
    {
      code: "SOMETHING_NEW",
      message_ru: "TypeError: x is undefined",
      words: "Что-то пошло не так во время сборки",
      action: "retry",
      button: "Повторить",
    },
  ] as const)
    test(`${c.code}: words without the code, ${c.action}`, async () => {
      h.mock.opts.canvasFailAfter = "compile";
      h.mock.opts.canvasFail = { code: c.code, message_ru: c.message_ru };
      const page = await h.page({ viewport: { width: 390, height: 844 } });
      await startClinic(page);
      await page.getByTestId("canvas-question").waitFor();
      await page.getByTestId("canvas-rest").click();
      await page.getByTestId("canvas-approve").click();
      const fail = page.getByTestId("canvas-failure");
      await fail.waitFor({ timeout: 15_000 });
      expect(await fail.getAttribute("data-action")).toBe(c.action);
      const text = (await fail.locator("p").allTextContents()).join(" ");
      expect(text).toContain(c.words);
      expect(text).not.toContain(c.code);
      expect(text).not.toMatch(/[A-Z]{2,}_[A-Z]/);
      if (c.button) expect(await page.getByTestId("canvas-retry").textContent()).toContain(c.button);
      else expect(await page.getByTestId("canvas-retry").count()).toBe(0);
      expect(await page.getByTestId("canvas-topup").count()).toBe(c.action === "billing" ? 1 : 0);
      // No endless spinner: the build indicator is gone, the island's ring says it failed.
      expect(await page.getByTestId("canvas-eta").count()).toBe(0);
      expect(await page.getByTestId("canvas-tile-build").getAttribute("data-failed")).toBe("");
      await shot(page, `390-failed-${c.code.toLowerCase()}`);
      h.mock.opts.canvasFailAfter = undefined;
      h.mock.opts.canvasFail = undefined;
      await page.context().close();
    });
});
