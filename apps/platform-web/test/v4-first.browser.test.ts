// V4-08 «Сначала показать» in chromium, 1440 and 390 px: right after the first message of a v3 system (the real grill
// interview on the recorded dental dialog, test/v3/fake-v3.ts) its three first screens fill the canvas at the real
// width of the window while the first question waits in the chat; the arrows turn them; «Собрать в этом стиле» on the
// second one closes the open questions by the recommendations, saves the pick into the brief and starts the build
// from that brief version. Screenshots in test/artifacts/v4-first-*.png.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ARCHETYPES } from "../../../packages/ui-kit/src/v3/design/archetypes.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";
import { FakeV3, serveV3 } from "./v3/fake-v3.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");

describe.skipIf(!hasChromium)("«Сначала показать» in chromium (recorded interview)", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: loadCanvasFeed(), eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ] as const)
    test(`${vp.width}px: three first screens after the first message, the pick builds`, async () => {
      const page = await h.page({ viewport: vp, colorScheme: "light", reducedMotion: "reduce" });
      const fake = new FakeV3();
      await serveV3(page, fake);
      await page.getByTestId("start-prompt").fill("Стоматология в Казани, онлайн-запись к врачам");
      await page.getByTestId("start-submit").click();
      await page.waitForURL(new RegExp(`/s/${fake.systemId}$`));

      // The first question in the chat and, at the same time, the first screens on the whole canvas.
      await page.getByTestId("canvas-question").waitFor();
      const screens = page.getByTestId("first-screens");
      await expect.poll(() => screens.getAttribute("data-state"), { timeout: 15_000 }).toBe("ready");
      expect(fake.stage).toBe("interview");
      if (vp.width < 600) await page.getByTestId("canvas-panel-close").click();
      expect((await page.getByTestId("first-screens-frame").boundingBox())?.width).toBe(vp.width);
      expect(await page.getByTestId("first-screens-count").textContent()).toBe("Вариант 1 из 3");
      await page.screenshot({ path: join(ARTIFACTS, `v4-first-${vp.width}-1-screens.png`) });

      // Turned to the second one; its name and its own first screen.
      await page.getByTestId("first-screens-next").click();
      const second = ARCHETYPES[1] as (typeof ARCHETYPES)[number];
      expect(await page.getByTestId("first-screens-count").textContent()).toBe("Вариант 2 из 3");
      expect(await page.getByTestId("first-screens-name").textContent()).toBe(second.name);
      expect(await page.getByTestId("first-screens-frame").getAttribute("srcdoc")).toContain(second.name);

      // «Собрать в этом стиле»: the rest by the recommendations, the pick, the build from the picked brief version.
      await page.getByTestId("first-screens-build").click();
      await expect.poll(() => fake.approvals.length, { timeout: 20_000 }).toBe(1);
      expect(fake.answers.at(-1)).toMatchObject({ restByRecommendation: true });
      expect(fake.picks).toEqual([{ proposalId: "a".repeat(64), n: 2 }]);
      expect(fake.latest()?.brief.design).toMatchObject({ archetype: second.id, pinned: true });
      expect(fake.approvals).toEqual([{ version: fake.latest()?.version }]);
      await page.getByTestId("canvas-eta").waitFor();
      expect(await page.getByTestId("first-screens").count()).toBe(0);
      await page.screenshot({ path: join(ARTIFACTS, `v4-first-${vp.width}-2-building.png`) });
      await page.context().close();
    }, 90_000);
});
