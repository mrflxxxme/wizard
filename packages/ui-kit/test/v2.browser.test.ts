// B2-32 acceptance in chromium on the demo page demo/v2: screenshots 390/1280 light/dark, contrast/labels/touch/overflow,
// «материализация» and breathing on transform/opacity and off with prefers-reduced-motion, self-hosted fonts, business
// colour, glass fallback, the pull-up chat sheet.
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { A11Y_SCRIPT, type A11yApi } from "./a11y/checks.js";
import { ARTIFACTS, type DemoHarness, hasChromium, startDemo } from "./helpers/demo.js";

async function a11y<K extends keyof A11yApi>(page: Page, check: K) {
  await page.addScriptTag({ content: A11Y_SCRIPT });
  return page.evaluate(
    (c) => (window as unknown as { __a11y: Record<string, () => unknown> }).__a11y[c]?.(),
    check,
  ) as Promise<ReturnType<A11yApi[K]>>;
}

const cssVar = (page: Page, name: string) =>
  page.evaluate(
    (n) =>
      getComputedStyle(document.querySelector("[data-p-root]") as Element)
        .getPropertyValue(n)
        .trim(),
    name,
  );

/** animation-name of an element (or its pseudo-element) found by selector. */
const animation = (page: Page, sel: string, pseudo?: string) =>
  page.evaluate(
    ([s, p]) => getComputedStyle(document.querySelector(s as string) as Element, p).animationName,
    [sel, pseudo ?? null] as const,
  );

describe.skipIf(!hasChromium)("design system v2 in chromium", () => {
  let demo: DemoHarness;
  beforeAll(async () => {
    demo = await startDemo("v2");
  }, 120_000);
  afterAll(async () => demo?.close());

  const SIZES = [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ] as const;
  for (const vp of SIZES)
    for (const scheme of ["light", "dark"] as const)
      test(`demo v2 ${vp.width}px ${scheme}: screenshot, WCAG AA contrast, labels, no horizontal scroll`, async () => {
        // Motion off: the screenshot and the contrast walk see the final state of every block.
        const page = await demo.page({
          path: "v2/",
          query: "sheet=inline&history=open",
          viewport: vp,
          colorScheme: scheme,
          reducedMotion: "reduce",
        });
        await page.evaluate(() => document.fonts.ready);
        expect(await cssVar(page, "--p-bg")).toBe(scheme === "light" ? "#F8F7F4" : "#1B1A18");
        await page.screenshot({ path: join(ARTIFACTS, `v2-${vp.width}-${scheme}.png`), fullPage: true });
        expect(await a11y(page, "overflow")).toEqual([]);
        expect(await a11y(page, "labels")).toEqual([]);
        expect(await a11y(page, "contrast")).toEqual([]);
        if (vp.width === 390) expect(await a11y(page, "touch")).toEqual([]);
        await page.context().close();
      });

  test("materialization and breathing run on transform/opacity; prefers-reduced-motion switches them off", async () => {
    const page = await demo.page({ path: "v2/", reducedMotion: "no-preference" });
    const live = '[data-testid="demo-block-Запись"]';
    const thinking = '[data-testid="demo-composer-thinking"] [data-testid="p-composer-row"]';
    await page.getByTestId("demo-replay").click();
    expect(await page.locator(live).getAttribute("data-state")).toBe("materializing");
    expect(await animation(page, live)).not.toBe("none");
    expect(await animation(page, `${live} [data-testid="p-block-edge"]`)).not.toBe("none");
    expect(await animation(page, thinking, "::after")).not.toBe("none");
    // The block becomes ready after MATERIALIZE_MS.
    await expect.poll(() => page.locator(live).getAttribute("data-state"), { timeout: 5000 }).toBe("ready");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByTestId("demo-replay").click();
    // With motion off the block skips straight to ready, nothing animates or transitions.
    await expect.poll(() => page.locator(live).getAttribute("data-state")).toBe("ready");
    const off = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll("[data-p-root] *")) {
        for (const p of [null, "::before", "::after"]) {
          const s = getComputedStyle(el, p);
          if (s.animationName !== "none") out.push(`${el.className} ${p ?? ""} animation ${s.animationName}`);
          if (s.transitionDuration.split(",").some((d) => Number.parseFloat(d) > 0))
            out.push(`${el.className} ${p ?? ""} transition ${s.transitionDuration}`);
        }
      }
      return out;
    });
    expect(off).toEqual([]);
    await page.context().close();
  });

  test("fonts: Inter and Source Serif 4 load from the demo's own origin, no external requests", async () => {
    const ctx = await demo.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const hosts = new Set<string>();
    page.on("request", (r) => hosts.add(new URL(r.url()).host));
    await page.goto(demo.url("", "v2/"));
    await page.evaluate(() => document.fonts.ready);
    const loaded = await page.evaluate(() => ({
      inter: document.fonts.check('16px "Inter"', "Привет"),
      serif: document.fonts.check('16px "Source Serif 4"', "Привет"),
      faces: [...document.fonts].filter((f) => f.status === "loaded").map((f) => `${f.family} ${f.weight}`),
    }));
    expect(loaded.inter).toBe(true);
    expect(loaded.serif).toBe(true);
    expect(loaded.faces).toEqual(expect.arrayContaining(["Inter 400", "Inter 600", "Source Serif 4 400"]));
    expect([...hosts]).toEqual([new URL(demo.url()).host]);
    await ctx.close();
  });

  test("business colour: the tint becomes the client colour and back to graphite; text on it stays readable", async () => {
    const page = await demo.page({ path: "v2/", reducedMotion: "reduce" });
    expect(await cssVar(page, "--p-biz")).toBe("#0F766E");
    expect(await cssVar(page, "--p-tint")).toBe("#0F766E");
    await page.getByTestId("demo-biz").click();
    expect(await cssVar(page, "--p-tint")).toBe("#1D1C1A");
    await page.goto(demo.url("biz=%23FFE600&theme=light", "v2/"));
    expect(await cssVar(page, "--p-biz")).not.toBe("#FFE600"); // too light for the page → darkened to ≥ 3:1
    expect(await a11y(page, "contrast")).toEqual([]);
    await page.context().close();
  });

  test("glass: blur by default, solid fallback with data-p-glass=off", async () => {
    const page = await demo.page({ path: "v2/" });
    const glass = () =>
      page.evaluate(() => {
        const s = getComputedStyle(document.querySelector('[data-testid="p-sheet-dock"]') as Element);
        return { filter: s.backdropFilter, bg: s.backgroundColor };
      });
    const on = await glass();
    expect(on.filter).toContain("blur(22px)");
    await page.goto(demo.url("glass=off", "v2/"));
    const off = await glass();
    expect(off.filter).toBe("none");
    expect(off.bg).toBe("rgb(251, 250, 247)");
    await page.context().close();
  });

  test("chat sheet on the phone: drag the handle up opens the history, down or Esc closes it", async () => {
    const page = await demo.page({ path: "v2/", viewport: { width: 390, height: 844 }, hasTouch: true });
    const grab = page.getByTestId("p-sheet-grab");
    const history = page.getByTestId("p-sheet-history");
    expect(await grab.getAttribute("aria-expanded")).toBe("false");
    const box = await grab.boundingBox();
    if (!box) throw new Error("no handle");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 40, { steps: 4 });
    await page.mouse.up();
    expect(await grab.getAttribute("aria-expanded")).toBe("true");
    await expect.poll(() => history.evaluate((e) => getComputedStyle(e).visibility)).toBe("visible");
    await page.keyboard.press("Escape");
    expect(await grab.getAttribute("aria-expanded")).toBe("false");
    await grab.click();
    expect(await grab.getAttribute("aria-expanded")).toBe("true");
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 40, { steps: 4 });
    await page.mouse.up();
    expect(await grab.getAttribute("aria-expanded")).toBe("false");
    // Sending from the sheet adds the message to the history.
    const input = page.getByTestId("p-sheet-dock").getByTestId("p-composer-input");
    await input.fill("Добавьте онлайн-оплату");
    await input.press("Enter");
    await grab.click();
    expect(await history.textContent()).toContain("Добавьте онлайн-оплату");
    await page.context().close();
  });
});
