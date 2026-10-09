// V3-06 with V3-03 and V3-04 in chromium, 390 and 1280 px × light and dark: a v3 system on the canvas (served by the
// page from the real grill interview on the recorded dental dialog and the real ТЗ reader with the recorded draft of
// the coffee sample — test/v3/fake-v3.ts, no model is called). «Приложить ТЗ»: a refused file is explained in the
// server's words, a docx gives the card with the short brief and the gaps; the v3 question: «Почему советуем», no
// «Решите за меня» chip, the card's «Решите за меня» posts the reserved option, «Дальше решай сам» posts
// restByRecommendation; then the brief is ready and the chat shows it before «Собрать». Screenshots in test/artifacts.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { COFFEE, toDocx } from "../../../packages/agents/test/brief-extract-fixtures.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";
import { FakeV3, serveV3 } from "./v3/fake-v3.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const stepText = (page: Page) => page.getByTestId("canvas-question").locator("p").first().textContent();

describe.skipIf(!hasChromium)(
  "v3 on the canvas in chromium (grill interview and ТЗ on recorded answers)",
  () => {
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
        test(`${vp.width}px ${scheme}: ТЗ from a file, the v3 question buttons, the brief before «Собрать»`, async () => {
          const tag = `${vp.width}-${scheme}`;
          const page = await h.page({ viewport: vp, colorScheme: scheme, reducedMotion: "reduce" });
          const fake = new FakeV3();
          await serveV3(page, fake);
          await page.getByTestId("start-prompt").fill("Стоматология в Казани, онлайн-запись к врачам");
          await page.getByTestId("start-submit").click();
          await page.waitForURL(new RegExp(`/s/${fake.systemId}$`));

          // The v3 question: its step, why the recommendation, no «Решите за меня» among the answers, no «Остальное».
          const card = page.getByTestId("canvas-question");
          await card.waitFor();
          expect(await stepText(page)).toBe("Вопрос 1");
          expect(await page.getByTestId("p-question-why").textContent()).toMatch(/^Почему советуем: /);
          expect(await page.getByTestId("p-question-option-delegate").count()).toBe(0);
          expect(await card.locator('[data-testid^="p-question-option-"]').count()).toBe(3);
          expect(await page.getByTestId("canvas-rest").count()).toBe(0);
          expect(await page.getByTestId("p-question-delegate").isVisible()).toBe(true);
          expect(await page.getByTestId("p-question-finish").isVisible()).toBe(true);

          // «Приложить ТЗ»: a file the server refuses (an RTF named .pdf) — the reason in its words, under the row.
          const attach = page.getByTestId("p-composer-attach");
          await attach.waitFor();
          const file = page.getByTestId("canvas-composer").getByTestId("p-composer-file");
          await file.setInputFiles({
            name: "tz.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("{\\rtf1\\ansi ТЗ}"),
          });
          await expect
            .poll(() => page.getByTestId("p-composer-attach-error").textContent())
            .toContain("Подходят файлы .docx, .pdf, .md и .txt");
          expect(fake.uploads).toEqual([{ name: "tz.pdf", status: 415 }]);

          // A docx: the card with where it came from, the gaps of the interview and the short brief of the new version.
          await file.setInputFiles({
            name: "tz-coffee.docx",
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            buffer: Buffer.from(toDocx(COFFEE)),
          });
          const up = page.getByTestId("canvas-upload-card");
          await up.waitFor();
          expect(fake.uploads.at(-1)).toEqual({ name: "tz-coffee.docx", status: 201 });
          expect(await page.getByTestId("canvas-upload-source").textContent()).toContain("DOCX");
          const gaps = await page
            .getByTestId("canvas-upload-gap")
            .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-section")));
          expect(gaps.length).toBeGreaterThan(0);
          expect(gaps).toContain("data");
          expect(
            await page
              .getByTestId("canvas-upload-summary")
              .getByTestId("p-brief-summary-version")
              .textContent(),
          ).toBe(`версия ${fake.latest()?.version}`);
          expect(await page.getByTestId("p-composer-attach-error").count()).toBe(0);
          expect(await noHorizontalScroll(page)).toBe(true);
          await page.screenshot({ path: join(ARTIFACTS, `v3-canvas-${tag}-1-upload.png`) });
          await page.getByTestId("canvas-upload-close").click();
          expect(await up.count()).toBe(0);

          // An answer button, then «Решите за меня» (the reserved option), then «Дальше решай сам» (restByRecommendation).
          await page.getByTestId("p-question-option-o1").click();
          await expect.poll(() => stepText(page)).toBe("Вопрос 2");
          expect(fake.answers[0]).toEqual({ answers: [{ questionId: "q1", optionId: "o1" }] });
          await page.screenshot({ path: join(ARTIFACTS, `v3-canvas-${tag}-2-question.png`) });
          await page.getByTestId("p-question-delegate").click();
          await expect.poll(() => stepText(page)).toBe("Вопрос 3");
          expect(fake.answers[1]).toEqual({ answers: [{ questionId: "q2", optionId: "delegate" }] });
          await page.getByTestId("p-question-finish").click();
          await page.getByTestId("canvas-brief-summary").waitFor({ timeout: 15_000 });
          expect(fake.answers[2]).toEqual({ answers: [], restByRecommendation: true });
          expect(fake.stage).toBe("card");
          expect(await page.getByTestId("canvas-question").count()).toBe(0);
          expect(await page.getByTestId("p-brief-summary-version").textContent()).toBe(
            `версия ${fake.latest()?.version}`,
          );
          await page.getByTestId("p-sheet-grab").click();
          const said = await page.getByTestId("canvas-message").allTextContents();
          expect(said).toEqual(expect.arrayContaining(["Решите за меня"]));
          await page.keyboard.press("Escape");
          expect(await noHorizontalScroll(page)).toBe(true);
          await page.screenshot({ path: join(ARTIFACTS, `v3-canvas-${tag}-3-brief.png`) });
          await page.context().close();
        }, 90_000);
  },
);
