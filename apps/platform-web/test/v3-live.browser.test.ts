// V3-17 in chromium, 390 and 1280 px × light and dark: the live v3 build on the canvas. The build run's events are made
// by the platform's own progress tracker (apps/platform-api/src/builds-v3/progress.ts) driven by a scripted harness on
// the dental brief, served over SSE to a v3 system of test/v3/fake-v3.ts; the growing system is a preview page per
// revision. While building: the checklist of the brief's scenarios, the time left against the 30 min cap, «потрачено
// X ₽ из 500 ₽», «Подробнее» with stages, gates and checkpoints, the live preview. The owner leaves (the browser context
// is closed: no local memory) and comes back in a new one — the progress, which went on meanwhile, is restored from
// the server. The owner allows browser notices; the build ends with the toast and one notice. A system opened after
// the build replays it. Screenshots in test/artifacts/v3-live-*.png.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { systemBriefSchema } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import {
  V3_PROGRESS_EVENTS,
  type V3LiveStats,
  V3ProgressTracker,
} from "../../platform-api/src/builds-v3/progress.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";
import { FakeV3, serveV3 } from "./v3/fake-v3.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

interface Frame {
  type: string;
  payload: Record<string, unknown>;
  ts: string;
}

/** A v3 system whose build run streams the frames pushed so far (SSE, fast reconnect); its preview grows by revision. */
class LiveV3 extends FakeV3 {
  readonly frames: Frame[] = [];
  preview = 0;

  override events(runId: string): string {
    if (runId !== this.buildRun) return super.events(runId);
    const body = this.frames
      .map((e, i) => ({ runId, seq: i + 1, ...e }))
      .map((e) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join("");
    return `retry: 200\n\n${body}`;
  }
}

/**
 * The harness on the dental brief as the host sees it: the tracker watches the brief, checkpoints and events and its
 * snapshot goes into build_stage / step_* exactly as builds-v3/host.ts writes them.
 */
function scriptedBuild(fake: LiveV3) {
  const brief = systemBriefSchema.parse(dentalBrief());
  const t = new V3ProgressTracker({ rubPerCredit: 5 });
  const clock = { sec: 0, rub: 0 };
  t.loaded([]);
  t.brief(brief);
  const stats = (): V3LiveStats => ({
    runSpentRub: clock.rub,
    elapsedSec: clock.sec,
    previewRevision: fake.preview || null,
  });
  const emit = (type: string, payload: Record<string, unknown>) => {
    const at = clock.sec * 1000;
    t.event(type, payload, at);
    fake.frames.push({
      type,
      payload: V3_PROGRESS_EVENTS.has(type)
        ? { ...payload, progress: t.snapshot(stats(), at, { type, payload }) }
        : payload,
      ts: new Date().toISOString(),
    });
  };
  const save = (key: string, data: Record<string, unknown>) =>
    t.saved({ key, fingerprint: key, data, costMilli: 0, durationMs: 0, runId: "r" });
  // build_stage as the harness writes it: the stage's own label, its number of the nine.
  const order = t.snapshot(stats(), 0).stages;
  const bs = (id: string, status: string) =>
    emit("build_stage", {
      stage: id,
      status,
      index: order.findIndex((x) => x.id === id) + 1,
      total: order.length,
      label_ru: order.find((x) => x.id === id)?.label_ru ?? id,
    });
  const stage = (id: string, sec: number) => {
    bs(id, "started");
    clock.sec += sec;
    save(id, {});
    bs(id, "done");
  };
  const gate = (level: string, passed = true) =>
    emit("gate_result", {
      level,
      passed,
      revision: fake.preview + (passed ? 0 : 1),
      ...(passed ? {} : { failedChecks: [{ id: "G0-BUILD-01", message_ru: "Страница не собирается" }] }),
    });
  const scenario = (id: string, title: string, ok: boolean, sec: number, rub: number) => {
    emit("step_started", { step: `scenario:${id}`, label_ru: title });
    clock.sec += sec;
    clock.rub += rub;
    if (ok) fake.preview += 1;
    gate("G0", ok);
    save(
      `scenario:${id}`,
      ok ? { status: "passed" } : { status: "failed", problems: ["Страница записи не собирается"] },
    );
    emit("agent_message", {
      agent: "builder",
      messageId: `v3s_${id}`,
      text: `${ok ? "Готово" : "Не получилось"}: ${title}. Сейчас потрачено ${Math.round(clock.rub)} ₽ из 500 ₽.`,
    });
    emit("step_finished", { step: `scenario:${id}` });
  };
  const titles = Object.fromEntries(
    brief.scenarios.map((s) => [s.id, `Когда ${s.when} — система ${s.then.join(", ")}`]),
  );
  return {
    /** Up to the second scenario at work: the skeleton preview, the first scenario landed. */
    start() {
      fake.frames.push({ type: "run_started", payload: { kind: "build" }, ts: new Date().toISOString() });
      stage("brief", 1);
      stage("design", 20);
      stage("backend", 3);
      stage("skeleton", 50);
      fake.preview = 2;
      gate("G0");
      emit("agent_message", {
        agent: "builder",
        messageId: "v3_preview",
        text: "Каркас всех страниц готов — его уже можно посмотреть в превью. Довожу сценарии по одному.",
      });
      bs("scenarios", "started");
      scenario("s_book", titles.s_book as string, true, 120, 42);
      emit("step_started", { step: "scenario:s_remind", label_ru: titles.s_remind });
    },
    /** While the owner is away: one more lands, one fails, the time runs out for the «should» one. */
    away() {
      clock.sec += 110;
      clock.rub += 31;
      fake.preview += 1;
      gate("G0");
      save("scenario:s_remind", { status: "passed" });
      emit("step_finished", { step: "scenario:s_remind" });
      scenario("s_confirm", titles.s_confirm as string, false, 200, 23);
      save("scenarios", {
        scenarios: [
          { id: "s_book", title: titles.s_book, priority: "must", status: "passed", costRub: 42 },
          { id: "s_remind", title: titles.s_remind, priority: "must", status: "passed", costRub: 31 },
          {
            id: "s_confirm",
            title: titles.s_confirm,
            priority: "must",
            status: "failed",
            reason: "не прошёл проверку в браузере: Страница записи не собирается",
            costRub: 23,
          },
          {
            id: "s_report",
            title: titles.s_report,
            priority: "should",
            status: "stopped",
            reason: "не успели: вышло время сборки",
            costRub: 0,
          },
        ],
      });
      bs("scenarios", "done");
      for (const st of ["critic", "template_gate", "techreview"]) bs(st, "skipped");
      bs("gates", "started");
    },
    /** The end: the final gates, the system on its newest revision. */
    finish() {
      clock.sec += 60;
      fake.preview += 1;
      for (const level of ["G0", "G1", "G2"]) gate(level);
      save("gates", {});
      bs("gates", "done");
      fake.frames.push({
        type: "run_finished",
        payload: {
          status: "succeeded",
          resultRevision: fake.preview,
          creditsUsed: clock.rub / 5,
          summary_ru: "Система собрана по брифу: готово 2 из 4 сценариев.",
          prodUrl: null,
        },
        ts: new Date().toISOString(),
      });
    },
  };
}

/** Stubs the Notification API (permission asked by a click) and records the notices shown. */
const NOTIFICATION_STUB = `(() => {
  window.__notices = [];
  class N {
    static permission = "default";
    static async requestPermission() { N.permission = "granted"; return "granted"; }
    constructor(title, o) { window.__notices.push({ title, body: o && o.body }); }
    close() {}
  }
  Object.defineProperty(window, "Notification", { value: N, configurable: true, writable: true });
})();`;

describe.skipIf(!hasChromium)("the live v3 build on the canvas in chromium", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum"), canvas: loadCanvasFeed(), eventDelayMs: 20 });
  }, 180_000);
  afterAll(async () => h?.close());

  /** A new browser context on the system's canvas: the fake API, the preview pages by revision, the stub. */
  async function open(fake: LiveV3, opts: BrowserContextOptions): Promise<Page> {
    const page = await h.page({ ...opts, reducedMotion: "reduce" });
    await page.addInitScript(NOTIFICATION_STUB);
    await serveV3(page, fake);
    const origin = `http://v3-dental--draft.localhost:${h.mock.port}`;
    await page.route(new RegExp(`/api/v1/systems/${fake.systemId}/preview-url`), (route) =>
      fake.preview
        ? route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              url: `${origin}/_wizard/dev-logout?next=/`,
              revision: fake.preview,
              roles: [],
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            }),
          })
        : route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ code: "PREVIEW_NOT_READY", message_ru: "Превью ещё не готово" }),
          }),
    );
    await page.route(/--draft\.localhost/, (route) => {
      const rev = new URL(route.request().url()).searchParams.get("wzrev") ?? "?";
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="ru"><body style="margin:0;font:18px system-ui;padding:24px"><h1>Стоматология · ревизия ${rev}</h1><p>Запись к врачу онлайн</p></body></html>`,
      });
    });
    await page.goto(`${h.origin}/s/${fake.systemId}`);
    return page;
  }

  const SIZES = [
    { width: 1280, height: 860 },
    { width: 390, height: 844 },
  ] as const;
  for (const vp of SIZES)
    for (const scheme of ["light", "dark"] as const)
      test(`${vp.width}px ${scheme}: checklist, time, spend, the growing system; leave and come back; ready`, async () => {
        const tag = `${vp.width}-${scheme}`;
        const ctx = { viewport: vp, colorScheme: scheme } as const;
        const fake = new LiveV3();
        fake.versions.push({
          version: 1,
          brief: systemBriefSchema.parse(dentalBrief()),
          diff: [],
          author: "agent",
          createdAt: new Date().toISOString(),
        });
        fake.stage = "building";
        fake.buildRun = randomUUID();
        const build = scriptedBuild(fake);
        build.start();

        // 1. The build at work: the canvas shows the live panel and the growing system.
        const page = await open(fake, ctx);
        const live = page.getByTestId("canvas-v3-live");
        await live.waitFor({ timeout: 15_000 });
        expect(await live.getAttribute("data-phase")).toBe("running");
        expect(await page.getByTestId("canvas-v3-live-title").textContent()).toBe("Собираю систему");
        expect(await page.getByTestId("canvas-v3-live-stage").textContent()).toBe(
          "Сейчас: Довожу сценарии по одному",
        );
        const rows = page.getByTestId("canvas-v3-live-scenario");
        const states = () =>
          rows.evaluateAll((xs) =>
            xs.map((x) => `${x.getAttribute("data-id")}:${x.getAttribute("data-status")}`),
          );
        expect(await states()).toEqual([
          "s_book:passed",
          "s_remind:running",
          "s_confirm:pending",
          "s_report:pending",
        ]);
        expect(await page.getByTestId("canvas-v3-live-count").textContent()).toContain("готово 1 из 4");
        // 194 s gone; the rest: three scenarios at the 120 s the first one took, then the final gates (120 s).
        expect(await page.getByTestId("canvas-v3-live-time-left").textContent()).toBe(
          "Осталось около 8 минут",
        );
        expect(await page.getByTestId("canvas-v3-live-time-cap").textContent()).toBe(
          "Идёт 3 мин · не дольше 30 мин",
        );
        expect(await page.getByTestId("canvas-v3-live-spend-line").textContent()).toBe(
          "Потрачено 42 ₽ из 500 ₽",
        );
        // The chat row takes the same numbers from the snapshot.
        expect(await page.getByTestId("canvas-build-spend").textContent()).toBe("потрачено 42 ₽ из 500 ₽");
        expect(await page.getByTestId("canvas-build-step").textContent()).toBe("Довожу сценарии по одному");
        // The growing system: the revision the first scenario landed in.
        const frame = page.frameLocator('[data-testid="canvas-v3-live-frame"]');
        await expect
          .poll(() => frame.locator("h1").textContent(), { timeout: 10_000 })
          .toBe("Стоматология · ревизия 3");
        // Calm under reduced motion: the running mark does not pulse.
        expect(
          await page
            .locator(
              '[data-testid="canvas-v3-live-scenario"][data-status="running"] span[aria-hidden="true"]',
            )
            .first()
            .evaluate((el) => getComputedStyle(el).animationName),
        ).toBe("none");
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `v3-live-${tag}-1-building.png`) });
        // «Подробнее»: stages, gates, checkpoints.
        await page.getByTestId("canvas-v3-live-more").locator("summary").click();
        expect(
          await page
            .getByTestId("canvas-v3-live-stages")
            .locator("li")
            .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-status"))),
        ).toEqual(["done", "done", "done", "done", "running", "pending", "pending", "pending", "pending"]);
        expect(await page.getByTestId("canvas-v3-live-gates").textContent()).toContain(
          "G0, ревизия 3: пройдена",
        );
        expect(await page.getByTestId("canvas-v3-live-checkpoints").textContent()).toContain(
          "Превью — ревизия 3.",
        );
        await page.getByTestId("canvas-v3-live-more").scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(ARTIFACTS, `v3-live-${tag}-2-details.png`), fullPage: true });

        // 2. The owner leaves (the context closes — nothing kept in the browser); the build goes on.
        await page.context().close();
        build.away();

        // 3. Back in a new context: the progress as the server has it now.
        const back = await open(fake, ctx);
        await back.getByTestId("canvas-v3-live").waitFor({ timeout: 15_000 });
        const rows2 = back.getByTestId("canvas-v3-live-scenario");
        await expect
          .poll(() =>
            rows2.evaluateAll((xs) =>
              xs.map((x) => `${x.getAttribute("data-id")}:${x.getAttribute("data-status")}`),
            ),
          )
          .toEqual(["s_book:passed", "s_remind:passed", "s_confirm:failed", "s_report:stopped"]);
        expect(
          await back.getByTestId("canvas-v3-live-reason").evaluateAll((xs) => xs.map((x) => x.textContent)),
        ).toEqual([
          "Причина: не прошёл проверку в браузере: Страница записи не собирается. Его можно доделать правкой.",
          "Причина: не успели: вышло время сборки. Его можно доделать правкой.",
        ]);
        expect(await back.getByTestId("canvas-v3-live-stage").textContent()).toBe(
          "Сейчас: Проверяю, что всё работает",
        );
        expect(await back.getByTestId("canvas-v3-live-spend-line").textContent()).toBe(
          "Потрачено 96 ₽ из 500 ₽",
        );
        await expect
          .poll(() => back.frameLocator('[data-testid="canvas-v3-live-frame"]').locator("h1").textContent())
          .toBe("Стоматология · ревизия 4");
        expect(await back.getByTestId("canvas-v3-live-leave").textContent()).toContain(
          "Можно закрыть страницу",
        );
        // The owner allows the browser notice.
        await back.getByTestId("canvas-v3-live-notify").click();
        await back.getByTestId("canvas-v3-live-notify-on").waitFor();
        expect(await noHorizontalScroll(back)).toBe(true);
        await back.screenshot({ path: join(ARTIFACTS, `v3-live-${tag}-3-back.png`) });

        // 4. The end while the page is open: the toast, one browser notice, «Система готова» in the chat.
        fake.stage = "ready" as never;
        fake.messages.push({
          id: randomUUID(),
          seq: fake.messages.length + 1,
          role: "assistant",
          kind: "run_report",
          text: "Система собрана по брифу: готово 2 из 4 сценариев.",
          createdAt: new Date().toISOString(),
          runId: fake.buildRun,
        } as never);
        build.finish();
        const toast = back.getByTestId("canvas-v3-live-toast");
        await toast.waitFor({ timeout: 15_000 });
        expect(await toast.getAttribute("role")).toBe("status");
        expect(await toast.textContent()).toContain("Система «Стоматология» готова");
        expect(await toast.textContent()).toContain("Готово 2 из 4 сценариев брифа");
        expect(await back.evaluate(() => (window as unknown as { __notices: unknown[] }).__notices)).toEqual([
          { title: "Система «Стоматология» готова", body: "Готово 2 из 4 сценариев брифа" },
        ]);
        expect(await back.getByTestId("canvas-v3-live").getAttribute("data-phase")).toBe("done");
        expect(await back.getByTestId("canvas-v3-live-title").textContent()).toBe("Система собрана");
        await expect.poll(() => back.getByTestId("canvas-live").textContent()).toContain("Система собрана");
        await back.getByTestId("canvas-v3-live-ready").waitFor();
        await expect
          .poll(() => back.frameLocator('[data-testid="canvas-v3-live-frame"]').locator("h1").textContent())
          .toBe("Стоматология · ревизия 5");
        expect(await noHorizontalScroll(back)).toBe(true);
        await back.screenshot({ path: join(ARTIFACTS, `v3-live-${tag}-4-ready.png`) });
        await back.getByTestId("canvas-v3-live-toast-close").click();
        expect(await toast.count()).toBe(0);
        await back.getByTestId("canvas-v3-live-look").click();
        await expect
          .poll(() => back.evaluate(() => document.activeElement?.id))
          .toBe("canvas-v3-live-preview");
        await back.context().close();

        // 5. The system opened after the build: the build is replayed from the server.
        const later = await open(fake, ctx);
        await later.getByTestId("canvas-v3-live").waitFor({ timeout: 15_000 });
        expect(await later.getByTestId("canvas-v3-live").getAttribute("data-phase")).toBe("done");
        expect(
          await later
            .getByTestId("canvas-v3-live-scenario")
            .evaluateAll((xs) => xs.map((x) => x.getAttribute("data-status"))),
        ).toEqual(["passed", "passed", "failed", "stopped"]);
        expect(await later.getByTestId("canvas-v3-live-ready").count()).toBe(1);
        await later.context().close();
      }, 120_000);
});
