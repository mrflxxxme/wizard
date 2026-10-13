// V4-17 «Первые экраны потоком» in chromium, 1440 and 390 px: after the first message of a v3 system the canvas starts
// the directions in the background (POST /directions {stream}) and at once shows the skeleton of the first screen in
// the brief's words and brand colour with the live stage («подбираю палитру», «пишу заголовок»); the first ready
// direction fills the canvas while the others are still drawn (they can be turned to as they come); «Собрать» on a
// screen before the rest waits for the stored proposal and then picks that direction; the frame already shown is not
// reloaded when the proposal is stored. Screenshots in test/artifacts/v4-first-stream-*.png.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Route } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ARCHETYPES } from "../../../packages/ui-kit/src/v3/design/archetypes.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";
import { FakeV3, serveV3 } from "./v3/fake-v3.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const KEY = "b".repeat(64);
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

interface Direction {
  n: number;
  previewHtml: string;
}

/** Directions drawn in steps the test sets: the stage, the ready ones by number, then the stored proposal. */
class StreamV3 extends FakeV3 {
  starts = 0;
  stage2: "design" | "texts" | "screens" | null = null;
  readyNs: number[] = [];
  stored = false;
  readonly t0 = Date.now();

  final(): { id: string; directions: Direction[] } {
    return (super.directions() as { proposal: { id: string; directions: Direction[] } }).proposal;
  }

  pending() {
    const all = this.final().directions;
    return {
      key: KEY,
      briefVersion: 1,
      startedAt: new Date(this.t0).toISOString(),
      elapsedMs: Date.now() - this.t0,
      stage: this.stage2 ?? "design",
      // The previews of a job are served under its key: another document than the stored proposal's.
      ready: this.readyNs.map((n) => {
        const d = all[n - 1] as Direction;
        return { ...d, previewHtml: d.previewHtml.replace("<body", "<!-- job --><body") };
      }),
      total: 3,
      skeleton: {
        title: "Стоматология «Улыбка» — запись к врачу",
        lead: "Выберите врача и время приёма.",
        action: "Записаться",
        accent: "#0E7490",
      },
      error: null,
    };
  }

  override directions(): unknown {
    if (this.stored) return super.directions();
    return { proposal: null, pending: this.starts > 0 ? this.pending() : null };
  }
}

describe.skipIf(!hasChromium)("first screens as a stream (chromium)", () => {
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
    test(`${vp.width}px: the skeleton with the stage, the first ready screen, the pick waits for the rest`, async () => {
      const page = await h.page({ viewport: vp, colorScheme: "light", reducedMotion: "reduce" });
      const fake = new StreamV3();
      await serveV3(page, fake);
      // Registered after serveV3: matched first.
      await page.route(new RegExp(`/api/v1/systems/${fake.systemId}/directions$`), (route) => {
        const req = route.request();
        if (req.method() !== "POST") return json(route, 200, fake.directions());
        expect(req.postDataJSON()).toEqual({ stream: true });
        fake.starts++;
        fake.stage2 = "design";
        return json(route, 202, { pending: fake.pending() });
      });
      await page.getByTestId("start-prompt").fill("Стоматология в Казани, онлайн-запись к врачам");
      await page.getByTestId("start-submit").click();
      await page.waitForURL(new RegExp(`/s/${fake.systemId}$`));
      await page.getByTestId("canvas-question").waitFor();
      if (vp.width < 600) await page.getByTestId("canvas-panel-close").click();

      // At once: the skeleton in the brief's words and colour, the stage said live.
      const screens = page.getByTestId("first-screens");
      await expect.poll(() => screens.getAttribute("data-state"), { timeout: 15_000 }).toBe("drawing");
      expect(fake.starts).toBe(1);
      expect(await page.getByTestId("first-screens-sketch-title").textContent()).toBe(
        "Стоматология «Улыбка» — запись к врачу",
      );
      const status = page.getByTestId("first-screens-status");
      expect(await status.textContent()).toContain("Подбираю палитру и шрифты");
      await page.screenshot({ path: join(ARTIFACTS, `v4-first-stream-${vp.width}-1-sketch.png`) });
      fake.stage2 = "texts";
      await expect.poll(() => status.textContent(), { timeout: 5_000 }).toContain("Пишу заголовок");

      // The second direction is ready first: it fills the canvas, the others are still drawn.
      fake.stage2 = "screens";
      fake.readyNs = [2];
      await expect.poll(() => screens.getAttribute("data-state"), { timeout: 5_000 }).toBe("partial");
      const second = ARCHETYPES[1] as (typeof ARCHETYPES)[number];
      const first = ARCHETYPES[0] as (typeof ARCHETYPES)[number];
      expect(await page.getByTestId("first-screens-name").textContent()).toBe(second.name);
      expect(await page.getByTestId("first-screens-count").textContent()).toBe("Вариант 1 из 3");
      expect(await status.textContent()).toBe("Готово 1 из 3, дорисовываю остальные…");
      expect((await page.getByTestId("first-screens-frame").boundingBox())?.width).toBe(vp.width);
      await page.screenshot({ path: join(ARTIFACTS, `v4-first-stream-${vp.width}-2-first.png`) });

      // The next one joins; turned to it.
      fake.readyNs = [2, 1];
      await expect.poll(() => screens.getAttribute("data-ready"), { timeout: 5_000 }).toBe("2");
      expect(await page.getByTestId("first-screens-name").textContent()).toBe(second.name);
      await page.getByTestId("first-screens-next").click();
      expect(await page.getByTestId("first-screens-name").textContent()).toBe(first.name);
      expect(await page.getByTestId("first-screens-count").textContent()).toBe("Вариант 2 из 3");
      const shown = await page.getByTestId("first-screens-frame").getAttribute("srcdoc");
      expect(shown).toContain("<!-- job -->");

      // «Собрать» before the third: the pick waits for the stored proposal, then builds the screen on view.
      await page.getByTestId("first-screens-build").click();
      await expect
        .poll(() => fake.answers.at(-1), { timeout: 10_000 })
        .toMatchObject({ restByRecommendation: true });
      await new Promise((r) => setTimeout(r, 2_000));
      expect(fake.picks).toEqual([]);
      fake.readyNs = [2, 1, 3];
      fake.stored = true;
      await expect
        .poll(() => fake.picks, { timeout: 10_000 })
        .toEqual([{ proposalId: "a".repeat(64), n: 1 }]);
      await expect.poll(() => fake.approvals.length, { timeout: 20_000 }).toBe(1);
      expect(fake.latest()?.brief.design).toMatchObject({ archetype: first.id, pinned: true });
      expect(fake.starts).toBe(1);
      await page.getByTestId("canvas-eta").waitFor();
      await page.screenshot({ path: join(ARTIFACTS, `v4-first-stream-${vp.width}-3-building.png`) });
      await page.context().close();
    }, 120_000);

  test("the stored proposal keeps the frame already shown (no reload)", async () => {
    const page = await h.page({
      viewport: { width: 1440, height: 900 },
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const fake = new StreamV3();
    await serveV3(page, fake);
    await page.route(new RegExp(`/api/v1/systems/${fake.systemId}/directions$`), (route) => {
      if (route.request().method() !== "POST") return json(route, 200, fake.directions());
      fake.starts++;
      return json(route, 202, { pending: fake.pending() });
    });
    fake.readyNs = [1];
    await page.getByTestId("start-prompt").fill("Стоматология в Казани, онлайн-запись к врачам");
    await page.getByTestId("start-submit").click();
    await page.waitForURL(new RegExp(`/s/${fake.systemId}$`));
    const screens = page.getByTestId("first-screens");
    await expect.poll(() => screens.getAttribute("data-state"), { timeout: 15_000 }).toBe("partial");
    fake.stored = true;
    await expect.poll(() => screens.getAttribute("data-state"), { timeout: 5_000 }).toBe("ready");
    expect(await page.getByTestId("first-screens-frame").getAttribute("srcdoc")).toContain("<!-- job -->");
    expect(await page.getByTestId("first-screens-count").textContent()).toBe("Вариант 1 из 3");
    // The model did not answer in time (the fake's proposal has the brief's texts): said in words.
    expect(await page.getByTestId("first-screens-fallback").textContent()).toContain(
      "тексты взяты из ваших ответов",
    );
    await page.context().close();
  }, 60_000);

  // V4-11: what goes wrong is said in words with «Попробовать ещё раз», never an endless spinner.
  for (const c of [
    { name: "the model failed", stage: "failed" as const, elapsedMs: 5_000, words: "Модель не ответила" },
    { name: "too long", stage: "design" as const, elapsedMs: 9 * 60_000, words: "дольше обычного" },
  ])
    test(`${c.name}: words and a retry that starts again`, async () => {
      const page = await h.page({
        viewport: { width: 390, height: 844 },
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      const fake = new StreamV3();
      await serveV3(page, fake);
      await page.route(new RegExp(`/api/v1/systems/${fake.systemId}/directions$`), (route) => {
        const failing = {
          ...fake.pending(),
          stage: c.stage,
          elapsedMs: c.elapsedMs,
          error: c.stage === "failed" ? "Модель не ответила. Попробуйте ещё раз." : null,
        };
        if (route.request().method() !== "POST")
          return json(route, 200, { proposal: null, pending: failing });
        fake.starts++;
        return json(route, 202, { pending: { ...failing, stage: "design", error: null } });
      });
      await page.getByTestId("start-prompt").fill("Стоматология в Казани, онлайн-запись к врачам");
      await page.getByTestId("start-submit").click();
      await page.waitForURL(new RegExp(`/s/${fake.systemId}$`));
      await page.getByTestId("canvas-question").waitFor();
      await page.getByTestId("canvas-panel-close").click();
      const screens = page.getByTestId("first-screens");
      await expect.poll(() => screens.getAttribute("data-state"), { timeout: 15_000 }).toBe("error");
      expect(await screens.textContent()).toContain(c.words);
      expect(await screens.textContent()).not.toMatch(/[A-Z]{2,}_[A-Z]/);
      const starts = fake.starts;
      await page.getByTestId("first-screens-retry").click();
      await expect.poll(() => fake.starts, { timeout: 5_000 }).toBeGreaterThan(starts);
      await page.context().close();
    }, 60_000);
});
