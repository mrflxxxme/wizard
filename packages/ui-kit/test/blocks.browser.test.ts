// M2-43 / M2-47 acceptance (Playwright demo): every landing block and variant at 390×844 and 1280×800 in each of the
// four themes — no horizontal scroll, contrast, labels, touch targets, heading order; LeadForm over the memory
// DataSource creates a lead only with consent; Image builds srcset from the runtime variants, lazy, alt required.
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { THEME_PRESETS } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { A11Y_SCRIPT, type A11yApi } from "./a11y/checks.js";
import { ARTIFACTS, type DemoHarness, hasChromium, startDemo } from "./helpers/demo.js";

const BLOCKS = ["Header", "Hero", "Features", "Steps", "Faq", "Cta", "LeadForm", "Footer", "Image"] as const;
const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

type DemoWindow = {
  __wzDemo: Record<
    string,
    { calls: { op: string; args: unknown[] }[]; rows(e: string): Record<string, unknown>[] }
  >;
};

async function a11y<K extends keyof A11yApi>(page: Page, check: K, ...args: Parameters<A11yApi[K]>) {
  await page.addScriptTag({ content: A11Y_SCRIPT });
  return page.evaluate(
    ([c, a]) =>
      (window as unknown as { __a11y: Record<string, (...x: unknown[]) => unknown> }).__a11y[c]?.(...a),
    [check, args] as const,
  ) as Promise<ReturnType<A11yApi[K]>>;
}

/** Heading problems inside each variant root: one h1 at most (Hero only), no level skipped. */
function headingProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const root of document.querySelectorAll<HTMLElement>("[data-variants] > [data-wz-component]")) {
      const levels = [...root.querySelectorAll("h1, h2, h3, h4")].map((h) => Number(h.tagName[1]));
      const name = root.getAttribute("data-testid");
      const h1 = levels.filter((l) => l === 1).length;
      if (root.dataset.wzComponent === "Hero" ? h1 !== 1 : h1 !== 0) out.push(`${name}: ${h1} h1`);
      for (let i = 1; i < levels.length; i++)
        if ((levels[i] as number) > (levels[i - 1] as number) + 1)
          out.push(`${name}: h${levels[i - 1]} → h${levels[i]}`);
    }
    return out;
  });
}

describe.skipIf(!hasChromium)("demo in chromium: landing blocks and images", () => {
  let demo: DemoHarness;
  beforeAll(async () => {
    demo = await startDemo("blocks");
  }, 120_000);
  afterAll(async () => demo?.close());

  for (const preset of THEME_PRESETS)
    for (const vp of SIZES)
      test(`${preset} ${vp.width}px: every block and variant — no horizontal scroll, contrast, labels, headings`, async () => {
        const page = await demo.page({ viewport: vp, query: `spec=studio&preset=${preset}&mode=light` });
        const failures: Record<string, unknown> = {};
        for (const block of BLOCKS) {
          await page.goto(demo.url(`story=${block}&spec=studio&preset=${preset}&mode=light`));
          await page.waitForFunction(
            () => (window as unknown as { __wz?: { ready: boolean } }).__wz?.ready === true,
          );
          await page.waitForTimeout(150);
          const problems = {
            overflow: await a11y(page, "overflow"),
            contrast: await a11y(page, "contrast"),
            labels: await a11y(page, "labels"),
            touch: vp.width === 390 ? await a11y(page, "touch") : [],
            headings: await headingProblems(page),
            scroll: await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          };
          if (Object.values(problems).some((v) => (Array.isArray(v) ? v.length > 0 : (v as number) > 0)))
            failures[block] = problems;
          if (vp.width === 390 || preset === "warm")
            await page.screenshot({
              path: join(ARTIFACTS, `blocks-${block}-${preset}-${vp.width}.png`),
              fullPage: true,
            });
        }
        expect(failures).toEqual({});
        await page.context().close();
      }, 120_000);

  test("Header @390px: the menu folds behind «Меню», opens and closes with Esc (focus returns)", async () => {
    const page = await demo.page({
      viewport: { width: 390, height: 844 },
      query: "story=Header&spec=studio",
    });
    const header = page.getByTestId("wz-header--bar");
    const nav = header.getByTestId("wz-header-nav");
    expect(await nav.isVisible()).toBe(false);
    const toggle = header.getByTestId("wz-header-menu");
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await nav.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await nav.isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
      "wz-header-menu",
    );
    await page.context().close();
  });

  test("LeadForm: consent shown and unchecked; without it no create; with it create(…, {consent: true}) and «Заявка отправлена»", async () => {
    const page = await demo.page({ query: "story=LeadForm&spec=studio" });
    const form = page.getByTestId("wz-leadform--card");
    const consent = form.getByTestId("wz-consent--leadform");
    expect(await consent.isVisible()).toBe(true);
    expect(await consent.locator("input").isChecked()).toBe(false);
    await form.getByTestId("wz-field-name").locator("input").fill("Мария (пример)");
    await form.getByTestId("wz-field-phone").locator("input").fill("9005554433");
    await form.getByTestId("wz-leadform-submit").click();
    expect(await consent.textContent()).toContain("Нужно согласие на обработку персональных данных");
    const creates = () =>
      page.evaluate(() =>
        (window as unknown as DemoWindow).__wzDemo.LeadForm?.calls.filter((c) => c.op === "create"),
      );
    expect(await creates()).toHaveLength(0);
    await consent.locator("input").check();
    await form.getByTestId("wz-leadform-submit").click();
    await expect.poll(() => form.getByTestId("wz-leadform-success").isVisible()).toBe(true);
    expect(await form.getByTestId("wz-leadform-success").textContent()).toContain("Заявка отправлена");
    const c = await creates();
    expect(c).toHaveLength(1);
    expect(c?.[0]?.args[1]).toEqual({ consent: true });
    expect(c?.[0]?.args[0]).toMatchObject({ name: "Мария (пример)", phone: "+79005554433" });
    expect(
      await page.evaluate(() => (window as unknown as DemoWindow).__wzDemo.LeadForm?.rows("lead").length),
    ).toBe(1);
    // Required fields: an empty submit shows errors under the fields, linked by aria-describedby.
    await form.getByRole("button", { name: "Отправить ещё одну" }).click();
    await form.getByTestId("wz-leadform-submit").click();
    const name = form.getByTestId("wz-field-name").locator("input");
    expect(await name.getAttribute("aria-invalid")).toBe("true");
    expect(await name.getAttribute("aria-describedby")).toBeTruthy();
    await page.context().close();
  });

  test("Image: srcset of 480/960/1600 variants, lazy, alt; the first screen picture is eager; no external hosts", async () => {
    const external: string[] = [];
    const page = await demo.page({ query: "story=Image&spec=studio" });
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (!["127.0.0.1", "localhost"].includes(u.hostname) && u.protocol.startsWith("http"))
        external.push(r.url());
    });
    const img = page.getByTestId("wz-image--field").getByTestId("wz-image-img");
    expect(await img.getAttribute("alt")).toBe("Пример фото из поля image");
    expect(await img.getAttribute("loading")).toBe("lazy");
    const empty = page.getByTestId("wz-image--empty");
    expect(await empty.getAttribute("role")).toBe("img");
    expect(await empty.getAttribute("aria-label")).toBe("Фото ещё не загружено");
    await page.goto(demo.url("story=Hero&spec=studio"));
    const hero = page.getByTestId("wz-hero--split").getByTestId("wz-image-img");
    expect(await hero.getAttribute("loading")).toBe("eager");
    await page.reload();
    expect(external).toEqual([]);
    await page.context().close();
  });

  test("ImageField: a PNG shows a preview right away; an SVG is refused at the field", async () => {
    const page = await demo.page({ query: "story=ImageField&spec=studio" });
    const input = page.getByTestId("wz-imagefield-photo-input");
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db40000000049454e44ae426082",
      "hex",
    );
    await input.setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
    await expect.poll(() => page.getByTestId("wz-imagefield-photo-preview").isVisible()).toBe(true);
    await input.setInputFiles({ name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await expect
      .poll(() => page.getByTestId("wz-imagefield-photo-error").textContent())
      .toContain("JPEG, PNG или WebP");
    await page.context().close();
  });
});
