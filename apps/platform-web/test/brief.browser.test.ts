// V3-06 acceptance in chromium, 390 and 1280 px: a system with a brief v3 on the canvas (the mock platform replays the
// recorded feed «клиника»; the brief routes of V3-02 are served by the page, as a v3 server would). Before «Собрать» the
// chat shows the short brief above the plan card; «Бриф» opens the panel; an edit in the panel is PUT with the version
// it was made on and becomes version 2; an edit in words goes as a usual chat message — when the server answers, the
// canvas re-reads the brief (version 3 written by the interview agent); the session feed lists the interview and both
// edits. Screenshots in test/artifacts/brief-canvas-*.png.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import {
  type BriefVersion,
  briefDiagrams,
  briefDiff,
  type SystemBrief,
  systemBriefSchema,
} from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dentalBrief } from "../../../packages/appspec/test/brief-fixtures.js";
import type { SystemSession } from "../src/api/types.js";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const feed = loadCanvasFeed();
const BRIEF_ROUTE = /\/api\/v1\/systems\/[0-9a-f-]{36}\/(brief(\/versions)?|sessions)(\?.*)?$/;

/** The brief side of a v3 server for one page: versions, PUT with baseVersion, sessions from the versions. */
function serveBrief(page: Page) {
  const first = systemBriefSchema.parse(dentalBrief());
  const versions: BriefVersion[] = [
    {
      version: 1,
      brief: first,
      diff: briefDiff(null, first),
      author: "agent",
      createdAt: new Date().toISOString(),
    },
  ];
  const puts: { baseVersion: number; brief: SystemBrief }[] = [];
  const latest = () => versions[versions.length - 1] as BriefVersion;
  const add = (brief: SystemBrief, author: "agent" | "owner") => {
    const prev = latest();
    versions.push({
      version: prev.version + 1,
      brief,
      diff: briefDiff(prev.brief, brief),
      author,
      createdAt: new Date().toISOString(),
    });
  };
  const sessions = (): SystemSession[] =>
    [...versions].reverse().map((v) => ({
      id: `${v.author}:${v.version}`,
      kind: v.version === 1 ? "interview" : "edit",
      source: v.version === 1 ? null : v.author === "owner" ? "panel" : "chat",
      status: "done",
      startedAt: v.createdAt,
      finishedAt: v.createdAt,
      runIds: [],
      briefVersions: [v.version],
      changes: v.diff.slice(0, 6).map((c) => c.text_ru),
      changesTotal: v.diff.length,
      build: null,
    }));
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  void page.route(BRIEF_ROUTE, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.endsWith("/sessions")) return json(route, 200, { sessions: sessions() });
    if (path.endsWith("/versions"))
      return json(route, 200, {
        versions: [...versions].reverse().map(({ brief: _b, ...v }) => v),
        nextBefore: null,
      });
    if (req.method() === "PUT") {
      const body = req.postDataJSON() as { baseVersion: number; brief: SystemBrief };
      puts.push(body);
      if (body.baseVersion !== latest().version)
        return json(route, 412, { code: "VERSION_CONFLICT", message_ru: "Бриф изменился", details: {} });
      add(systemBriefSchema.parse(body.brief), "owner");
      return json(route, 200, { brief: latest(), diagrams: briefDiagrams(latest().brief), changed: true });
    }
    return json(route, 200, { brief: latest(), diagrams: briefDiagrams(latest().brief) });
  });
  // The interview agent of V3-03 answers a chat edit with a new version of the brief.
  page.on("request", (req) => {
    if (req.method() === "POST" && /\/systems\/[^/]+\/messages$/.test(new URL(req.url()).pathname)) {
      const prev = latest().brief;
      add(
        systemBriefSchema.parse({ ...prev, outOfScope: [...prev.outOfScope, { text: "Отзывы на сайте" }] }),
        "agent",
      );
    }
  });
  return { versions, puts };
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

async function toPlan(page: Page): Promise<void> {
  await page.getByTestId("start-prompt").fill(feed.brief);
  await page.getByTestId("start-submit").click();
  await page.waitForURL(/\/s\/[0-9a-f-]{36}$/);
  await page.getByTestId("canvas-question").waitFor();
  await page.getByTestId("canvas-rest").click();
  await page.getByTestId("canvas-plan-card").waitFor({ timeout: 15_000 });
}

describe.skipIf(!hasChromium)(
  "brief on the canvas in chromium (feed «клиника», brief routes of a v3 server)",
  () => {
    let h: Harness;
    beforeAll(async () => {
      mkdirSync(ARTIFACTS, { recursive: true });
      h = await startHarness({ feed: loadFeed("forum"), canvas: feed, eventDelayMs: 20 });
    }, 180_000);
    afterAll(async () => h?.close());

    const SIZES = [
      { width: 1280, height: 860 },
      { width: 390, height: 844 },
    ] as const;
    for (const vp of SIZES)
      test(`${vp.width}px: short brief before «Собрать», panel edit → version 2, words in chat → version 3, sessions`, async () => {
        const tag = `${vp.width}`;
        const page = await h.page({ viewport: vp, colorScheme: "light", reducedMotion: "reduce" });
        const srv = serveBrief(page);
        await toPlan(page);

        // Short brief in the chat, above the plan card with «Собрать».
        const summary = page.getByTestId("canvas-brief-summary");
        await summary.waitFor();
        expect(await page.getByTestId("p-brief-summary-version").textContent()).toBe("версия 1");
        const n = await page.getByTestId("p-brief-theses").locator("li").count();
        expect(n).toBeGreaterThanOrEqual(5);
        expect(n).toBeLessThanOrEqual(8);
        expect(await summary.locator('[data-testid^="p-brief-thumb-"]').count()).toBe(3);
        const sBox = await summary.boundingBox();
        const pBox = await page.getByTestId("canvas-plan-card").boundingBox();
        expect(sBox && pBox && sBox.y + sBox.height <= pBox.y + 1).toBe(true);
        expect(await page.getByTestId("canvas-approve").isVisible()).toBe(true);
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `brief-canvas-${tag}-1-summary.png`) });

        // The panel: an edit of a goal is PUT with the version it was made on and becomes version 2.
        await page.getByTestId("canvas-brief-toggle").click();
        const panel = page.getByTestId("canvas-brief-panel");
        await panel.waitFor();
        expect(await page.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
        await page.screenshot({ path: join(ARTIFACTS, `brief-canvas-${tag}-2-panel.png`) });
        await page.getByTestId("p-brief-edit-goals").click();
        await page
          .getByTestId("p-brief-editor")
          .getByLabel("Как поймём, что получилось")
          .first()
          .fill("50 записей в месяц");
        await page.getByTestId("p-brief-save").click();
        await expect
          .poll(() => page.getByTestId("p-brief-panel-version").textContent())
          .toContain("Версия 2");
        expect(srv.puts.map((p) => p.baseVersion)).toEqual([1]);
        expect(srv.puts[0]?.brief.goals[0]?.success).toBe("50 записей в месяц");
        expect(await page.getByTestId("p-brief-notice").textContent()).toBe("Сохранено — это версия 2.");
        expect(await page.locator('[data-changed="changed"]').first().textContent()).toContain(
          "50 записей в месяц",
        );
        await page.getByTestId("p-brief-tab-versions").click();
        expect(await page.getByTestId("p-brief-change").first().getAttribute("data-op")).toBe("changed");
        await page.screenshot({ path: join(ARTIFACTS, `brief-canvas-${tag}-3-versions.png`) });
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
          "canvas-brief-toggle",
        );
        expect(await page.getByTestId("p-brief-summary-version").textContent()).toBe("версия 2");

        // In words: «Изменить словами» leads to the input row; the usual chat message; when the server answers the
        // canvas re-reads the brief.
        await page.getByTestId("canvas-brief-toggle").click();
        await page.getByTestId("p-brief-ask").click();
        await panel.waitFor({ state: "detached" });
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
          .toBe("p-composer-input");
        const input = page.getByTestId("canvas-composer").getByTestId("p-composer-input");
        await input.fill("Отзывы на сайте пока не нужны");
        await input.press("Enter");
        await expect
          .poll(() => page.getByTestId("p-brief-summary-version").textContent(), { timeout: 15_000 })
          .toBe("версия 3");
        await page.getByTestId("canvas-brief-toggle").click();
        expect(await page.getByTestId("p-brief-panel-version").textContent()).toContain("Версия 3");
        expect(await page.locator('[data-changed="added"]').textContent()).toContain("Отзывы на сайте");
        await page.getByTestId("p-brief-tab-sessions").click();
        await expect
          .poll(() =>
            page
              .getByTestId("p-session")
              .evaluateAll((xs) =>
                xs.map((x) => `${x.getAttribute("data-kind")}|${x.querySelector("b")?.textContent}`),
              ),
          )
          .toEqual(["edit|Правка словами в чате", "edit|Правка в панели «Бриф»", "interview|Интервью"]);
        expect(await noHorizontalScroll(page)).toBe(true);
        await page.screenshot({ path: join(ARTIFACTS, `brief-canvas-${tag}-4-sessions.png`) });
        await page.context().close();
      }, 90_000);
  },
);
