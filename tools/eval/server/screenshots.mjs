// B2-24: screenshots of the measured systems for the report grid (eval.yaml#modes.server_d76). The driver's hook
// screenshot(r) opens the draft through the one-time preview link (GET /systems/:id/preview-url) in Chromium at 390
// and 1280 px and saves PNGs next to the results; report.mjs lays them out 3 per row. No secrets reach the files:
// the eval account is a service one and the briefs are synthetic.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/** Viewports of the grid: the phone first (D76 (6): 390 px), then the desktop. */
export const SHOT_VIEWPORTS = [
  { label: "телефон, 390 px", suffix: "390", width: 390, height: 844 },
  { label: "компьютер, 1280 px", suffix: "1280", width: 1280, height: 800 },
];
/**
 * V3-40: the final measurement shoots at the viewports of the template gate (390 and 1440 px) — the blind comparison
 * (tools/eval/blind) puts these next to the competitor's screenshots of the same widths.
 */
export const V3_FINAL_VIEWPORTS = [
  SHOT_VIEWPORTS[0],
  { label: "компьютер, 1440 px", suffix: "1440", width: 1440, height: 900 },
];

/** Chromium of the workspace's Playwright (packages/e2e), loaded lazily: the driver runs without it too. */
export function launchChromium() {
  const require = createRequire(new URL("../../../packages/e2e/package.json", import.meta.url));
  const { chromium } = require("@playwright/test");
  return chromium.launch();
}

const safe = (s) => String(s).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80);

/**
 * The driver hook: `screenshot(r)` → [{label, src}] for a brief with a system. `dir` — where the PNGs go, `src` is
 * `dir/<brief>-<width>.png` as given (the report is read next to it). One browser for the run; close() ends it.
 * `viewports` — SHOT_VIEWPORTS by default (V3_FINAL_VIEWPORTS for the final v3 measurement).
 */
export function previewScreenshots({
  client,
  dir,
  launch = launchChromium,
  log = () => {},
  viewports = SHOT_VIEWPORTS,
}) {
  // Workers run briefs in parallel: one launch shared by all of them.
  let browser = null;
  const ensure = () => {
    browser ??= Promise.resolve().then(launch);
    return browser;
  };
  async function screenshot(r) {
    if (!r.systemId) return [];
    mkdirSync(dir, { recursive: true });
    const b = await ensure();
    const out = [];
    for (const v of viewports) {
      // The preview link is one-time (nonce): a fresh one per viewport.
      const link = (await client.get(`/systems/${r.systemId}/preview-url`)).body;
      if (!link?.url) throw new Error("ссылка на превью не получена");
      const context = await b.newContext({
        viewport: { width: v.width, height: v.height },
        locale: "ru-RU",
        timezoneId: "Europe/Moscow",
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        await page.goto(link.url, { waitUntil: "load", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        const src = join(dir, `${safe(r.id)}-${v.suffix}.png`);
        writeFileSync(src, await page.screenshot({ fullPage: false }));
        out.push({ label: v.label, src });
      } catch (e) {
        log(`${r.id}: снимок ${v.label} не снят: ${e?.message ?? e}`);
      } finally {
        await context.close().catch(() => {});
      }
    }
    return out;
  }
  return {
    screenshot,
    close: async () => {
      const b = browser;
      browser = null;
      if (b) await (await b.catch(() => null))?.close().catch(() => {});
    },
  };
}
