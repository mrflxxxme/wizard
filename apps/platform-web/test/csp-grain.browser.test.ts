// V3-06: the paper grain of the platform design system v2 (grill-7 #9) under the production CSP of the platform
// (src/csp.ts: default-src 'self', no data: images): the texture is a file of the platform bundle, so the v2 screens
// open without a CSP violation or an error in the console, and the grain layer really draws the texture.
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Harness, hasChromium, startHarness } from "./helpers/harness.js";
import { loadCanvasFeed, loadFeed } from "./mock/server.js";

/** Console errors and CSP violations of the page from its first script on. */
async function watch(page: Page): Promise<string[]> {
  const out: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") out.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => out.push(`page: ${e.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp ??= [];
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return out;
}

describe.skipIf(!hasChromium)("paper grain under the production CSP", () => {
  let h: Harness;
  beforeAll(async () => {
    // The platform answers these as in production: settings of the org, and «no brief yet» for a v2 system.
    h = await startHarness({
      feed: loadFeed("forum"),
      canvas: loadCanvasFeed(),
      eventDelayMs: 20,
      orgSettings: { ruOnly: false },
    });
  }, 180_000);
  afterAll(async () => h?.close());

  test("the start screen and the canvas: no CSP violation, no console error; the grain is a loaded file", async () => {
    const ctx = await h.browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "ru-RU" });
    const page = await ctx.newPage();
    const errors = await watch(page);
    await page.route(/\/api\/v1\/systems\/[0-9a-f-]{36}\/brief$/, (r) =>
      r.fulfill({ status: 200, contentType: "application/json", body: '{"brief":null,"diagrams":null}' }),
    );
    const grain: { url: string; status: number; type: string }[] = [];
    page.on("response", (r) => {
      if (/grain[^/]*\.svg/.test(r.url()))
        grain.push({ url: r.url(), status: r.status(), type: r.headers()["content-type"] ?? "" });
    });
    const missing: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 400) missing.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });
    const res = await page.goto(`${h.origin}/`);
    expect(res?.headers()["content-security-policy"]).toContain("default-src 'self'");
    expect(res?.headers()["content-security-policy"]).not.toContain("data:");
    await page.getByTestId("start-prompt").waitFor();
    const layer = await page.evaluate(() => {
      const el = document.querySelector("[data-p-grain]");
      return el ? getComputedStyle(el, "::before").backgroundImage : null;
    });
    expect(layer).toMatch(/^url\("http[^"]+grain[^"]*\.svg"\)$/);
    expect(layer).not.toContain("data:");
    // The canvas of a system (another v2 screen with its own root and grain).
    await page.getByTestId("start-prompt").fill(loadCanvasFeed().brief);
    await page.getByTestId("start-submit").click();
    await page.waitForURL(/\/s\/[0-9a-f-]{36}$/);
    await page.getByTestId("canvas-question").waitFor();
    await expect.poll(() => grain.length).toBeGreaterThan(0);
    expect(grain.every((g) => g.status === 200 && g.type.startsWith("image/svg+xml"))).toBe(true);
    const csp = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
    expect(csp).toEqual([]);
    expect(errors.filter((e) => /Content Security Policy|Refused to/i.test(e))).toEqual([]);
    expect(missing).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
