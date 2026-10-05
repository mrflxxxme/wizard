// Playwright on the demo: tokens (applyTokens < 50 ms, dark), AppShell, a11y, responsive, wz_id (backlog M0-08).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { forum } from "../demo/fixtures.js";
import { toRoleSpec } from "../src/index.js";
import { A11Y_SCRIPT, type A11yApi } from "./a11y/checks.js";
import {
  ARTIFACTS,
  type DemoHarness,
  hasChromium,
  specComponents,
  startDemo,
  UI_KIT_ROOT,
} from "./helpers/demo.js";

const SPEC_YAML = readFileSync(join(UI_KIT_ROOT, "../../specs/ui/ui-kit.yaml"), "utf8");
const COMPONENTS = [...specComponents(SPEC_YAML), ...specComponents(SPEC_YAML, "M2")];

async function a11y<K extends keyof A11yApi>(page: Page, check: K, ...args: Parameters<A11yApi[K]>) {
  await page.addScriptTag({ content: A11Y_SCRIPT });
  return page.evaluate(
    ([c, a]) =>
      (window as unknown as { __a11y: Record<string, (...x: unknown[]) => unknown> }).__a11y[c]?.(...a),
    [check, args] as const,
  ) as Promise<ReturnType<A11yApi[K]>>;
}

describe.skipIf(!hasChromium)("demo in chromium: base", () => {
  let demo: DemoHarness;
  beforeAll(async () => {
    demo = await startDemo("base");
  }, 120_000);
  afterAll(async () => demo?.close());

  test("applyTokens with a new accent restyles the button without reload in < 50 ms", async () => {
    const page = await demo.page({ query: "story=Button" });
    const r = await page.evaluate(() => {
      (window as unknown as { marker: number }).marker = 42;
      const btn = document.querySelector(
        '[data-testid="wz-button"][data-wz-component="Button"]',
      ) as HTMLElement;
      const before = getComputedStyle(btn).backgroundColor;
      const navs = performance.getEntriesByType("navigation").length;
      const t0 = performance.now();
      (window as unknown as { __wz: { applyTokens(t: object): number } }).__wz.applyTokens({
        accent: "#0A7D3E",
      });
      const after = getComputedStyle(btn).backgroundColor;
      const dt = performance.now() - t0;
      return { before, after, dt, navs, navsAfter: performance.getEntriesByType("navigation").length };
    });
    expect(r.before).not.toBe(r.after);
    expect(r.after).toBe("rgb(10, 125, 62)");
    expect(r.dt).toBeLessThan(50);
    expect(r.navsAfter).toBe(r.navs);
    expect(await page.evaluate(() => (window as unknown as { marker: number }).marker)).toBe(42);
    await page.context().close();
  });

  test("mode=auto + prefers-color-scheme dark → --w-bg = #0F1115", async () => {
    const page = await demo.page({ query: "story=Badge&mode=auto", colorScheme: "dark" });
    const bg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--w-bg").trim(),
    );
    expect(bg).toBe("#0F1115");
    await page.emulateMedia({ colorScheme: "light" });
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--w-bg").trim()),
    ).toBe("#F6F6F4");
    await page.context().close();
  });

  test.each(["participant", "organizer", "moderator"])(
    "AppShell nav for %s = pages with roles ∋ role",
    async (role) => {
      const page = await demo.page({ query: `story=AppShell&role=${role}` });
      const links = await page.getByTestId("wz-appshell-nav").locator("a").allTextContents();
      const expected = toRoleSpec(forum, role)
        .pages.filter((p) => p.nav !== false && !p.route.includes(":"))
        .map((p) => p.title);
      expect(links).toEqual(expected);
      for (const p of forum.pages ?? []) if (!p.roles.includes(role)) expect(links).not.toContain(p.title);
      await expect
        .poll(() => page.getByTestId("wz-appshell-user").textContent())
        .toContain(forum.roles.find((r) => r.name === role)?.label);
      await page.context().close();
    },
  );

  test("@390px navigation lives in a drawer operated by keyboard", async () => {
    const page = await demo.page({
      query: "story=AppShell&role=organizer",
      viewport: { width: 390, height: 844 },
    });
    const nav = page.getByTestId("wz-appshell-nav");
    await expect.poll(() => nav.isVisible()).toBe(false);
    const toggle = page.getByTestId("wz-appshell-menu-toggle");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => nav.isVisible()).toBe(true);
    expect(await nav.getAttribute("role")).toBe("dialog");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('[data-testid="wz-appshell-nav"]')),
    ).toBe(true);
    // Focus trap: Tab from the last item goes back into the drawer.
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('[data-testid="wz-appshell-nav"]')),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect.poll(() => nav.isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "wz-appshell-menu-toggle",
    );
    await page.context().close();
  });

  test("phone_otp with the memory dev-sender logs in and shows the role in the menu", async () => {
    const page = await demo.page({ query: "story=AppShell" });
    await page.getByTestId("wz-appshell-login").click();
    await expect.poll(() => page.getByTestId("demo-path").textContent()).toMatch(/^\/login/);
    await page.getByTestId("wz-login-method-phone_otp").click();
    await page.getByLabel("Телефон").fill("9001234510");
    await page.getByTestId("wz-login-submit").click();
    const code = ((await page.getByTestId("demo-outbox").textContent()) ?? "").match(/(\d{6})$/)?.[1] ?? "";
    expect(code).toMatch(/^\d{6}$/);
    await page.getByLabel("Код из сообщения").fill(code);
    await page.getByTestId("wz-login-submit").click();
    await expect.poll(() => page.getByTestId("wz-appshell-user").textContent()).toContain("Участник");
    expect(await page.getByTestId("demo-path").textContent()).toBe("/");
    await page.context().close();
  });

  const SIZES = [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ] as const;
  const SCHEMES = ["light", "dark"] as const;
  for (const vp of SIZES)
    for (const scheme of SCHEMES)
      test(`whole demo ${vp.width}px ${scheme}: contrast, labels, wz_id, no horizontal scroll`, async () => {
        const page = await demo.page({ viewport: vp, colorScheme: scheme, query: "mode=auto" });
        await page.waitForTimeout(250);
        await page.screenshot({ path: join(ARTIFACTS, `base-${vp.width}-${scheme}.png`), fullPage: true });
        expect(await a11y(page, "overflow")).toEqual([]);
        expect(await a11y(page, "wz", COMPONENTS)).toEqual([]);
        expect(await a11y(page, "labels")).toEqual([]);
        expect(await a11y(page, "contrast")).toEqual([]);
        if (vp.width === 390) expect(await a11y(page, "touch")).toEqual([]);
        await page.context().close();
      });

  test("every focusable element shows a ≥ 2px focus ring in DOM order", async () => {
    const page = await demo.page({ query: "story=Field" });
    await page.addScriptTag({ content: A11Y_SCRIPT });
    const total = await a11y(page, "focusables");
    const bad: string[] = [];
    for (let i = 0; i < Math.min(total, 60); i++) {
      await page.keyboard.press("Tab");
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        return {
          id: el.id || el.getAttribute("data-testid") || el.tagName,
          w: parseFloat(s.outlineWidth),
          style: s.outlineStyle,
        };
      });
      if (r && (r.w < 2 || r.style === "none")) bad.push(`${r.id}: ${r.w}px ${r.style}`);
    }
    expect(bad).toEqual([]);
    await page.context().close();
  });
});
