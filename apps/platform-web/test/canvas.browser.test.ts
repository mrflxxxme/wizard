// B2-25 acceptance in chromium: the canvas screen of the modules pipeline on the recorded feed «клиника» (режим показа:
// the mock replays answers recorded from the real planner, no model is called). 390 and 1280 px × light and dark:
// brief → goal interview (the sketch grows with every answer) → plan with goal and «не входит» tags → approval →
// build that materializes the sketch with plain-word stages, time left and the x-ray layer → «Система готова» →
// views and the block pick. A failed build is explained in words with the details under «Подробнее».
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const feed = loadCanvasFeed();
/** Index of build_stage{compile, started}: the build waits there (half done) so the x-ray window can be checked. */
const HOLD = feed.build.findIndex((e) => e.type === "build_stage" && e.payload.stage === "compile");

const blocks = (page: Page) => page.getByTestId("canvas-block");
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
/** Waits until a smooth scroll stops and the entrance animations end, then saves the viewport. */
async function shot(page: Page, name: string): Promise<void> {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const y = await page.evaluate(() => window.scrollY);
    if (y === last) break;
    last = y;
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(ARTIFACTS, `canvas-${name}.png`), fullPage: false });
}

async function startClinic(page: Page): Promise<string> {
  await page.getByTestId("start-prompt").fill(feed.brief);
  await page.getByTestId("start-submit").click();
  await page.waitForURL(/\/s\/[0-9a-f-]{36}$/);
  return page.url().split("/s/")[1] as string;
}

async function answerAll(page: Page): Promise<number[]> {
  const counts: number[] = [];
  for (const q of feed.interview.questions as {
    id: string;
    options: { id: string; recommended: boolean }[];
  }[]) {
    const rec = q.options.find((o) => o.recommended) ?? q.options[0];
    await page.getByTestId(`p-question-option-${rec?.id}`).click();
    counts.push(await page.getByTestId("canvas-tag").count());
  }
  return counts;
}

describe.skipIf(!hasChromium)("canvas screen in chromium (feed «клиника», режим показа)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: feed, eventDelayMs: 40 });
  }, 180_000);
  afterAll(async () => h?.close());

  const SIZES = [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ] as const;
  for (const vp of SIZES)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: interview → sketch grows → plan → approval → build → ready`, async () => {
        const tag = `${vp.width}-${scheme}`;
        const page = await h.page({ viewport: vp, colorScheme: scheme });
        const id = await startClinic(page);

        // Interview: the sketch of the goal interview appears after the first phrase, the chat floats bottom-centre.
        await page.getByTestId("canvas-question").waitFor();
        const board = page.getByTestId("canvas-board");
        expect(await board.getAttribute("data-stage")).toBe("interview");
        const interviewBlocks = await blocks(page).count();
        expect(interviewBlocks).toBeGreaterThan(3);
        expect(await page.getByTestId("demo-replay").isVisible()).toBe(true);
        expect(await page.getByTestId("canvas-question").textContent()).toContain("1 из 3");
        const sheet = await page.getByTestId("canvas-sheet").boundingBox();
        expect(sheet).not.toBeNull();
        if (sheet) {
          expect(sheet.y + sheet.height).toBeGreaterThan(vp.height - 40);
          expect(Math.abs(sheet.x + sheet.width / 2 - vp.width / 2)).toBeLessThan(4);
        }
        const bg = await page.evaluate(
          () => getComputedStyle(document.querySelector("[data-p-root]") as Element).backgroundColor,
        );
        expect(bg).toBe(scheme === "light" ? "rgb(248, 247, 244)" : "rgb(27, 26, 24)");
        expect(await noHorizontalScroll(page)).toBe(true);
        await shot(page, `${tag}-1-interview`);

        // Every answer changes the sketch without a model: a tag of the answer on its module's block.
        const tags = await answerAll(page);
        expect(tags[0]).toBeGreaterThan(0);
        expect(tags[1]).toBeGreaterThan(tags[0] ?? 0);

        // The plan: real module screens, goal and «не входит» tags; nothing builds before the approval.
        await page.getByTestId("canvas-plan-card").waitFor();
        expect(await board.getAttribute("data-stage")).toBe("plan");
        expect(await blocks(page).count()).toBeGreaterThan(interviewBlocks);
        expect(await page.getByTestId("canvas-tag-goal").count()).toBeGreaterThanOrEqual(3);
        expect(await page.getByTestId("canvas-tag-out").first().textContent()).toContain(
          "Оплата лечения на сайте",
        );
        expect(await page.getByTestId("canvas-name").textContent()).toContain("Светлая");
        expect(
          [...h.mock.runs.values()].filter((r) => r.run.systemId === id && r.run.kind === "build"),
        ).toHaveLength(0);
        expect(await page.locator('[data-block-state="sketch"]').count()).toBe(await blocks(page).count());
        await shot(page, `${tag}-2-plan`);

        // Approval starts the build; it waits half-way so the x-ray window and the time left can be seen.
        h.mock.holdBuildAt = HOLD;
        await page.getByTestId("canvas-approve").click();
        await expect.poll(() => h.mock.buildHeld, { timeout: 10_000 }).toBe(true);
        // Time left: in the top bar on a wide screen, in the build row on the phone (the bar keeps the name).
        if (vp.width > 600) {
          await page.getByTestId("canvas-eta").waitFor();
          expect(await page.getByTestId("canvas-eta-text").textContent()).toMatch(/осталось/);
        } else expect(await page.getByTestId("canvas-build-row").innerText()).toMatch(/осталось/);
        expect(await page.getByTestId("canvas-build-step").textContent()).toBe("Подбираю фото");
        await expect.poll(() => page.getByTestId("canvas-xray").getAttribute("data-visible")).toBe("true");
        await page.getByTestId("canvas-xray-data").waitFor();
        expect(await page.getByTestId("canvas-xray-data").textContent()).toContain("Кто видит данные");
        expect(await page.getByTestId("canvas-xray-data").textContent()).toContain("Сколько хранятся");
        expect(await page.locator('[data-testid^="p-xray-node-"]').count()).toBeGreaterThanOrEqual(3);
        expect(await page.locator('[data-block-state="ready"]').count()).toBeGreaterThan(0);
        expect(await page.locator('[data-block-state="sketch"]').count()).toBeGreaterThan(0);
        expect(await noHorizontalScroll(page)).toBe(true);
        await shot(page, `${tag}-3-build`);
        h.mock.releaseBuild();

        // Ready: everything materialized, the x-ray hides itself and becomes a switch; views and the block pick.
        await page.getByTestId("canvas-ready").waitFor({ timeout: 15_000 });
        expect(await page.locator('[data-block-state="ready"]').count()).toBe(await blocks(page).count());
        expect(await page.getByTestId("canvas-xray").getAttribute("data-visible")).toBeNull();
        await shot(page, `${tag}-4-ready`);
        await page.getByTestId("canvas-xray-toggle").click();
        expect(await page.getByTestId("canvas-xray").getAttribute("data-visible")).toBe("true");
        await page.getByTestId("canvas-xray-toggle").click();
        expect(await page.getByTestId("canvas-xray").getAttribute("data-visible")).toBeNull();

        await page.getByTestId("canvas-open-site").click();
        expect(await board.getAttribute("data-view")).toBe("site");
        expect(await page.getByTestId("canvas-frame-cab").isVisible()).toBe(false);
        await page.getByTestId("canvas-block-site:services").click();
        expect(await page.getByTestId("canvas-block-site:services").getAttribute("data-selected")).toBe(
          "true",
        );
        expect(await page.getByTestId("p-composer-target").textContent()).toContain("Услуги и цены");
        await page.getByTestId("canvas-view-cab").click();
        expect(await page.getByTestId("canvas-frame-cab").isVisible()).toBe(true);
        expect(await page.getByTestId("p-composer-target").count()).toBe(0);
        expect(await noHorizontalScroll(page)).toBe(true);
        await shot(page, `${tag}-5-cabinet`);

        // The history unfolds upwards by a tap on the handle (a sheet on the phone).
        await page.getByTestId("p-sheet-grab").click();
        expect(await page.getByTestId("canvas-message").count()).toBeGreaterThanOrEqual(3);
        await page.keyboard.press("Escape");
        await page.context().close();
      }, 90_000);

  test("reduced motion: blocks appear without animation", async () => {
    const page = await h.page({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
    await startClinic(page);
    await page.getByTestId("canvas-question").waitFor();
    const anim = await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-testid="canvas-block"]') as Element).animationName,
    );
    expect(anim).toBe("none");
    await page.context().close();
  });
});

describe.skipIf(!hasChromium)("canvas: a failed build is explained in words", () => {
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

  test("MODULE_BUG: plain words, details under «Подробнее», retry reuses the finished stages", async () => {
    const page = await h.page({ viewport: { width: 1280, height: 860 } });
    await startClinic(page);
    await page.getByTestId("canvas-question").waitFor();
    await page.getByTestId("canvas-rest").click();
    await page.getByTestId("canvas-approve").click();
    const fail = page.getByTestId("canvas-failure");
    await fail.waitFor({ timeout: 15_000 });
    const text = (await fail.textContent()) ?? "";
    expect(text).toContain("Сбой в одном из наших готовых блоков");
    expect(await page.getByTestId("canvas-failure-more").getAttribute("open")).toBeNull();
    await page.getByTestId("canvas-failure-more").locator("summary").click();
    expect(await page.getByTestId("canvas-failure-more").textContent()).toContain("MODULE_BUG");
    await shot(page, "1280-light-failed");
    h.mock.opts.canvasFailAfter = undefined;
    await page.getByTestId("canvas-retry").click();
    await page.getByTestId("canvas-ready").waitFor({ timeout: 15_000 });
    await page.context().close();
  });
});
