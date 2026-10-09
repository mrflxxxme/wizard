// V3-06 with V3-09 and V3-11 in chromium, 390 and 1280 px × light and dark: a v3 system whose brief is ready (the
// real grill interview on the recorded dental dialog, test/v3/fake-v3.ts) shows in the chat the short brief, the style
// of the site and «Собрать · до 500 ₽». «Выбрать стиль» opens the three directions over the canvas; the pick goes into
// the brief and its short version; «Собрать» posts the brief version the owner saw; while the build runs the build row
// says «потрачено X ₽ из Y». Screenshots in test/artifacts/v3-build-*.png.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ARCHETYPES } from "../../../packages/ui-kit/src/v3/design/archetypes.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";
import { FakeV3, serveV3 } from "./v3/fake-v3.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const stepText = (page: Page) => page.getByTestId("canvas-question").locator("p").first().textContent();

/** Through the interview of the dental dialog: a button, «Решите за меня», «Дальше решай сам» → the brief is ready. */
async function toReadyBrief(page: Page, fake: FakeV3): Promise<void> {
  await page.getByTestId("start-prompt").fill("Стоматология в Казани, онлайн-запись к врачам");
  await page.getByTestId("start-submit").click();
  await page.waitForURL(new RegExp(`/s/${fake.systemId}$`));
  await page.getByTestId("canvas-question").waitFor();
  await page.getByTestId("p-question-option-o1").click();
  await expect.poll(() => stepText(page)).toBe("Вопрос 2");
  await page.getByTestId("p-question-delegate").click();
  await expect.poll(() => stepText(page)).toBe("Вопрос 3");
  await page.getByTestId("p-question-finish").click();
  await page.getByTestId("canvas-v3-build").waitFor({ timeout: 15_000 });
}

describe.skipIf(!hasChromium)("«Собрать» v3 and the style in chromium (recorded interview)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: loadCanvasFeed(), eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  const SIZES = [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ] as const;
  for (const vp of SIZES)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: style into the brief, «Собрать» with the cap, the spend while building`, async () => {
        const tag = `${vp.width}-${scheme}`;
        const page = await h.page({ viewport: vp, colorScheme: scheme, reducedMotion: "reduce" });
        const fake = new FakeV3();
        await serveV3(page, fake);
        await toReadyBrief(page, fake);

        // The chat before «Собрать»: the short brief, the style not chosen yet, the start with the cap.
        expect(fake.stage).toBe("card");
        expect(await page.getByTestId("canvas-brief-summary").isVisible()).toBe(true);
        expect(await page.getByTestId("canvas-v3-style").textContent()).toContain("ещё не выбран");
        expect(await page.getByTestId("canvas-v3-approve").textContent()).toBe("Собрать · до 500 ₽");
        expect(await page.getByTestId("canvas-approve").count()).toBe(0);
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-build-${tag}-1-ready.png`) });

        // «Выбрать стиль»: the three directions over the canvas; the pick goes into the brief and closes the drawer.
        await page.getByTestId("canvas-v3-style-open").click();
        const drawer = page.getByTestId("canvas-v3-style-drawer");
        await drawer.getByTestId("directions-card").waitFor();
        expect(await page.getByRole("dialog").getAttribute("aria-label")).toBe("Стиль сайта");
        expect(await drawer.locator('[data-testid^="direction-pick-"]').count()).toBe(3);
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-build-${tag}-2-style.png`) });
        await drawer.getByTestId("direction-pick-2").click();
        await drawer.waitFor({ state: "detached" });
        const chosen = ARCHETYPES[1] as (typeof ARCHETYPES)[number];
        expect(fake.picks).toEqual([{ proposalId: "a".repeat(64), n: 2 }]);
        expect(fake.latest()?.brief.design).toMatchObject({ archetype: chosen.id, pinned: true });
        await expect
          .poll(() => page.getByTestId("canvas-v3-style").textContent())
          .toBe(`«${chosen.name}» — выбран вами`);
        expect(await page.getByTestId("p-brief-theses").textContent()).toContain(
          `Стиль сайта: «${chosen.name}» — выбран вами`,
        );
        expect(await page.getByTestId("p-brief-summary-version").textContent()).toBe(
          `версия ${fake.latest()?.version}`,
        );

        // «Собрать»: the version the owner saw; the build row with the stage and the money spent.
        await page.getByTestId("canvas-v3-approve").click();
        await page.getByTestId("canvas-build-row").waitFor();
        expect(fake.approvals).toEqual([{ version: fake.latest()?.version }]);
        await expect
          .poll(() => page.getByTestId("canvas-build-spend").textContent(), { timeout: 10_000 })
          .toBe("потрачено 42 ₽ из 500 ₽");
        expect(await page.getByTestId("canvas-build-step").textContent()).toBe("Собираю каркас страниц");
        expect(await page.getByTestId("canvas-v3-build").count()).toBe(0);
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-build-${tag}-3-building.png`) });
        await page.context().close();
      }, 90_000);
});
