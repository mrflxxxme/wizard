// B2-29 acceptance in chromium: «ткни и скажи» on the canvas of the recorded feed «клиника» (режим показа, no model).
// 390 and 1280 px: a tap picks a block (its label in the chat row, hints by its type); «Другой вид», «Убрать» /
// «Вернуть» and a module switch go to PATCH /plan with the seen revision (dry run first, then the save) and redraw the
// sketch without a single model call; an edit the plan cannot take is explained; free text with the label goes to the
// planner about that block. A stale revision gives a plain message and the fresh sketch; a built system turns the
// edit into a plan to rebuild and says so.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const feed = loadCanvasFeed();

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const block = (page: Page, id: string) => page.getByTestId(`canvas-block-${id}`);
/** The layout variant the block draws (data-variant of its body). */
const variantOf = (page: Page, id: string) =>
  page.locator(`[data-block-id="${id}"] [data-variant]`).first().getAttribute("data-variant");

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(ARTIFACTS, `canvas-pick-${name}.png`), fullPage: false });
}

/** Picks a block by the keyboard (the floating chat may cover its middle on a phone). */
async function pick(b: Locator): Promise<void> {
  await b.scrollIntoViewIfNeeded();
  await b.focus();
  await b.press("Enter");
}

async function toPlan(page: Page): Promise<string> {
  await page.getByTestId("start-prompt").fill(feed.brief);
  await page.getByTestId("start-submit").click();
  await page.waitForURL(/\/s\/[0-9a-f-]{36}$/);
  await page.getByTestId("canvas-question").waitFor();
  await page.getByTestId("canvas-rest").click();
  await page.getByTestId("canvas-plan-card").waitFor();
  return page.url().split("/s/")[1] as string;
}

describe.skipIf(!hasChromium)("«ткни и скажи» on the canvas (B2-29, режим показа)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: feed, eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  /** Runs that call a model: interview turns (the planner); a build starts only from the approval. */
  const modelRuns = (id: string) =>
    [...h.mock.runs.values()].filter((r) => r.run.systemId === id && r.run.kind === "interview_turn").length;
  const patches = (id: string) =>
    h.mock.requests.filter((r) => r.method === "PATCH" && r.path === `/api/v1/systems/${id}/plan`);

  for (const vp of [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ] as const)
    test(`${vp.width}px: pick → «Другой вид», «Убрать», «Вернуть», a switch — no model; a wish with the label`, async () => {
      const page = await h.page({ viewport: vp });
      const id = await toPlan(page);
      const models = modelRuns(id);

      // A tap on the sketch of the plan picks the block: highlight, label in the chat row, hints by its type.
      await block(page, "site:hero").click({ position: { x: 24, y: 24 } });
      expect(await block(page, "site:hero").getAttribute("data-selected")).toBe("true");
      expect(await page.getByTestId("p-composer-target").textContent()).toContain("Первый экран");
      const hints = page.getByTestId("p-composer-suggestions").locator("button");
      expect(await hints.allTextContents()).toEqual(["Другой вид", "Убрать", "Ниже"]);
      expect(await page.getByTestId("canvas-pick-note").textContent()).toContain("бесплатны");
      expect(await variantOf(page, "site:hero")).toBe("split");

      // «Другой вид»: PATCH /plan with the seen revision — the dry run redraws the sketch, then the edit is saved.
      await page.getByTestId("p-composer-suggestion-view").click();
      await expect.poll(() => variantOf(page, "site:hero")).toBe("centered");
      await expect.poll(() => page.getByTestId("canvas-pick-variant").textContent()).toBe("вид 2 из 3");
      await expect.poll(() => patches(id).length).toBe(2);
      const [dry, save] = patches(id);
      expect(dry?.body).toEqual({
        revision: 1,
        edits: [{ op: "update_section", index: 1, variant: "centered" }],
        dryRun: true,
      });
      expect(save?.body).toEqual({
        revision: 1,
        edits: [{ op: "update_section", index: 1, variant: "centered" }],
      });
      expect(await noHorizontalScroll(page)).toBe(true);
      await shot(page, `${vp.width}-1-view`);

      // «Убрать» drops the section from the sketch; «Вернуть» brings it back at its place.
      await pick(block(page, "site:steps"));
      expect(await page.getByTestId("p-composer-target").textContent()).toContain("Как записаться");
      await page.getByTestId("p-composer-suggestion-remove").click();
      await expect.poll(() => block(page, "site:steps").count()).toBe(0);
      expect(await page.getByTestId("p-composer-target").count()).toBe(0);
      expect(await page.getByTestId("canvas-undo").textContent()).toContain("Блок «Как записаться» убран");
      await page.getByTestId("canvas-undo-button").click();
      await expect.poll(() => block(page, "site:steps").count()).toBe(1);
      const kinds = await page
        .locator('[data-f="site"] [data-testid="canvas-block"]')
        .evaluateAll((els) => els.map((e) => e.getAttribute("data-kind")));
      expect(kinds.slice(0, 5)).toEqual(["nav", "hero", "services", "steps", "cta"]);

      // A module screen: switches of its parameters; an edit the plan cannot take is explained, nothing changes.
      await pick(block(page, "cab:schedule"));
      expect(await page.getByTestId("canvas-params").isVisible()).toBe(true);
      const manual = page.getByTestId("canvas-param-confirm-manual");
      expect(await manual.getAttribute("aria-pressed")).toBe("false");
      await manual.click();
      await expect.poll(() => manual.getAttribute("aria-pressed")).toBe("true");
      const many = page.getByTestId("canvas-param-with_specialists");
      expect(await many.getAttribute("aria-pressed")).toBe("true");
      await many.click();
      await expect.poll(() => many.getAttribute("aria-pressed")).toBe("false");
      await shot(page, `${vp.width}-2-params`);
      await page.getByTestId("p-composer-suggestion-remove").click();
      await page.getByTestId("canvas-error").waitFor();
      expect(await page.getByTestId("canvas-error").textContent()).toContain("Так не получится");
      expect(await block(page, "cab:schedule").count()).toBe(1);

      // Every edit above went without a model and without a run.
      expect(modelRuns(id)).toBe(models);
      expect(
        [...h.mock.runs.values()].filter((r) => r.run.systemId === id && r.run.kind === "build"),
      ).toHaveLength(0);
      expect(patches(id).every((r) => typeof (r.body as { revision?: unknown }).revision === "number")).toBe(
        true,
      );

      // Free text with the label: the wish goes to the planner about this block.
      await pick(block(page, "site:services"));
      await page.getByTestId("p-composer-input").fill("Сделайте карточками");
      await page.getByTestId("p-composer-send").click();
      await expect.poll(() => modelRuns(id)).toBe(models + 1);
      const post = h.mock.requests.filter(
        (r) => r.method === "POST" && r.path === `/api/v1/systems/${id}/messages`,
      );
      expect(post.at(-1)?.body).toEqual({
        text: "Сделайте карточками",
        block: { id: "site:services", title: "Услуги и цены", module: "catalog", sectionIndex: 2 },
      });
      await page.getByTestId("canvas-plan-card").waitFor();
      await page.getByTestId("p-sheet-grab").click();
      await expect
        .poll(() => page.getByTestId("canvas-message").allTextContents())
        .toContain("Услуги и цены: Сделайте карточками");
      expect(await noHorizontalScroll(page)).toBe(true);
      await page.context().close();
    }, 90_000);

  test("a stale revision: a plain message and the fresh sketch", async () => {
    const page = await h.page({ viewport: { width: 1280, height: 860 } });
    const id = await toPlan(page);
    await block(page, "site:hero").click({ position: { x: 24, y: 24 } });
    // The plan changes in another window: the steps are gone there.
    await h.api("PATCH", `/systems/${id}/plan`, { revision: 1, edits: [{ op: "remove_section", index: 3 }] });
    await page.getByTestId("p-composer-suggestion-view").click();
    await page.getByTestId("canvas-notice").waitFor();
    expect(await page.getByTestId("canvas-notice").textContent()).toContain("План успели изменить");
    await expect.poll(() => block(page, "site:steps").count()).toBe(0);
    expect(await variantOf(page, "site:hero")).toBe("split");
    // The next edit goes with the fresh revision.
    await page.getByTestId("p-composer-suggestion-view").click();
    await expect.poll(() => variantOf(page, "site:hero")).toBe("centered");
    expect(patches(id).at(-1)?.body).toMatchObject({ revision: 2 });
    await page.context().close();
  });

  test("a built system: the edit becomes a plan to rebuild, said in words", async () => {
    const page = await h.page({ viewport: { width: 1280, height: 860 } });
    const id = await toPlan(page);
    await page.getByTestId("canvas-approve").click();
    await page.getByTestId("canvas-ready").waitFor({ timeout: 15_000 });
    await page.getByTestId("canvas-open-site").click();
    await page.getByTestId("canvas-block-site:services").click();
    expect(await page.getByTestId("canvas-pick-note").textContent()).toContain("появится после пересборки");
    expect(await variantOf(page, "site:services")).toBe("list");
    await page.getByTestId("p-composer-suggestion-view").click();
    await expect.poll(() => variantOf(page, "site:services")).toBe("cards");
    await expect
      .poll(() => page.getByTestId("canvas-notice").textContent())
      .toContain("Нажмите «Пересобрать»");
    expect(h.mock.systems.get(id)?.system.stage).toBe("card");
    // The system stays built on the canvas until the rebuild.
    expect(await page.locator('[data-block-id="site:services"]').getAttribute("data-block-state")).toBe(
      "ready",
    );
    await page.keyboard.press("Escape");
    await page.getByTestId("canvas-plan-card").waitFor();
    expect(await page.getByTestId("canvas-plan-card").textContent()).toContain("План изменён");
    expect(await page.getByTestId("canvas-approve").textContent()).toBe("Пересобрать");
    await shot(page, "1280-3-rebuild");
    await page.getByTestId("canvas-approve").click();
    await page.getByTestId("canvas-ready").waitFor({ timeout: 15_000 });
    const builds = [...h.mock.runs.values()].filter((r) => r.run.systemId === id && r.run.kind === "build");
    expect(builds.map((r) => r.run.mode)).toEqual(["create", "change"]);
    await page.context().close();
  });
});
