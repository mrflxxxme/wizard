// V3-09 in chromium: the «Три направления» screen (/s/:id?view=design) of the built platform under its CSP — at 390 px one
// column of cards, at 1280 px three in a row; no horizontal scroll, touch targets ≥ 44 px, every preview frame
// sandboxed and titled, no console errors; screenshots in test/artifacts/platform-directions-*.png. The directions API
// is stubbed with page.route (its previews are plain documents here; the real built previews are checked by
// apps/platform-api/test/v3-directions.browser.test.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Route } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APP_ROOT } from "../vite.config.js";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadFeed } from "./mock/server.js";

const ARTIFACTS = join(APP_ROOT, "test/artifacts");
const SYS = "33333333-3333-4333-8333-333333333333";
const NAMES = ["Тёплый ремесленный", "Редакционный", "Швейцарская сетка"];
const PROPOSAL = {
  id: "c".repeat(64),
  briefVersion: 1,
  createdAt: "2026-10-09T09:00:00.000Z",
  costRub: 0.5,
  fallback: false,
  references: ["Логотип: фирменный цвет #B5541B."],
  picked: null,
  directions: NAMES.map((name, i) => ({
    n: i + 1,
    archetype: ["warm_craft", "editorial", "swiss"][i],
    name,
    why: "Доверие через содержание: спокойная сетка, цвет только как сигнал, фото без постановки.",
    texts: { title: "Запись на приём с сайта", lead: "Выберите услугу и время.", action: "Записаться" },
    textsSource: "model",
    tuning: i === 1 ? ["теплее", "заголовок крупнее"] : [],
    header: "header-classic",
    hero: "hero-split",
    fonts: { display: "Literata", text: "Commissioner" },
    palette: { background: "#FBFBFA", foreground: "#1C1B1A", accent: "#B5541B" },
    previewHtml: `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head><body><h1>Первый экран ${i + 1}</h1></body></html>`,
  })),
};

const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 860 },
] as const;

describe.skipIf(!hasChromium)("«Три направления» screen at 390 and 1280 px", () => {
  let h: Harness;
  beforeAll(async () => {
    mkdirSync(ARTIFACTS, { recursive: true });
    h = await startHarness({ feed: loadFeed("forum") });
  }, 180_000);
  afterAll(async () => h?.close());

  for (const vp of SIZES)
    test(`${vp.width} px: cards, no horizontal scroll, ≥ 44 px targets, sandboxed frames, no console errors`, async () => {
      const context = await h.browser.newContext({ viewport: vp, locale: "ru-RU" });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("response", (res) => {
        if (res.status() >= 400) errors.push(`${res.status()} ${new URL(res.url()).pathname}`);
      });
      await page.route("**/api/v1/systems/*/directions", async (route: Route) => {
        if (route.request().method() !== "GET") return route.fallback();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ proposal: PROPOSAL }),
        });
      });
      await page.goto(`${h.origin}/s/${SYS}?view=design`);
      await page.getByTestId("direction-3").waitFor({ timeout: 15_000 });
      for (const n of [1, 2, 3]) {
        const frame = page.frameLocator(`[data-testid="direction-preview-${n}"]`);
        await expect(frame.locator("h1").textContent()).resolves.toBe(`Первый экран ${n}`);
      }
      const r = await page.evaluate(() => {
        const rect = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.getBoundingClientRect();
        const targets = [
          ...document.querySelectorAll<HTMLElement>(
            '[data-testid="directions-card"] button, [data-testid="directions-card"] input, [data-testid="directions-card"] summary',
          ),
        ]
          .filter((el) => el.offsetParent !== null && !(el instanceof HTMLInputElement && el.type === "file"))
          .map((el) => ({
            name: el.textContent || el.getAttribute("placeholder") || el.tagName,
            h: el.getBoundingClientRect().height,
          }));
        return {
          scroll: document.documentElement.scrollWidth - window.innerWidth,
          tops: [1, 2, 3].map((n) => Math.round(rect(`direction-${n}`)?.top ?? -1)),
          small: targets.filter((t) => t.h < 44),
          frames: [...document.querySelectorAll("iframe")].map((f) => ({
            sandbox: f.getAttribute("sandbox"),
            title: f.getAttribute("title"),
          })),
        };
      });
      expect(r.scroll).toBeLessThanOrEqual(1);
      if (vp.width === 390) expect(r.tops[1]).toBeGreaterThan(r.tops[0] as number);
      else expect(new Set(r.tops).size).toBe(1);
      expect(r.small, JSON.stringify(r.small)).toEqual([]);
      expect(r.frames).toHaveLength(3);
      for (const f of r.frames) {
        expect(f.sandbox).toBe("allow-scripts");
        expect(f.title).toMatch(/^Первый экран, направление \d: /);
      }
      await page.getByTestId("directions-references").locator("summary").click();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(ARTIFACTS, `platform-directions-${vp.width}.png`), fullPage: true });
      // Not of this screen: the org settings the mock platform does not serve (the console line of a 404 carries no
      // URL — the response listener above names it).
      const own = errors.filter(
        (e) =>
          !/^404 \/api\/v1\/orgs\/[^/]+\/settings$/.test(e) &&
          !/^Failed to load resource: the server responded with a status of 404/.test(e),
      );
      expect(own, own.join("\n")).toEqual([]);
      await context.close();
    }, 90_000);
});
