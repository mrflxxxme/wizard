// V3-08 acceptance (browser): every pattern of the library × 4 design systems (fixtures after C2) × 390/1280 px ×
// light and dark — built by buildSystem (Tailwind v4 over ui/design.css, React and Motion in the bundle) and rendered
// in Chromium without errors, horizontal overflow, contrast below WCAG AA (text over photos against white and black),
// unnamed controls, images without alt, broken heading order, and with touch targets ≥ 44 px at 390. Screenshots of
// each pattern in one design system per size and scheme go to test/artifacts/patterns-v3/.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildSystem } from "../src/index.js";
import { DESIGN_FIXTURES } from "./fixtures-v3.js";
import { PKG_ROOT } from "./helpers.js";
import { V3_CHECKS_SCRIPT, type V3CheckResult } from "./v3-checks.js";
import { type PreviewServer, previewItems, previewSystem, servePreview } from "./v3-harness.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;
const MODES = ["light", "dark"] as const;
export const SHOTS = join(PKG_ROOT, "test/artifacts/patterns-v3");

let browser: Browser;
const servers = new Map<string, PreviewServer>();

beforeAll(async () => {
  if (!hasChromium) return;
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch();
  await Promise.all(
    DESIGN_FIXTURES.map(async (f) => {
      const { spec, files } = previewSystem(f, previewItems(PATTERNS));
      const built = await buildSystem({ spec, files, env: "prod" });
      if (!built.ok) throw new Error(`${f.id}: ${JSON.stringify(built.errors, null, 1)}`);
      servers.set(f.id, await servePreview(spec, built));
    }),
  );
}, 180_000);

afterAll(async () => {
  await browser?.close();
  for (const s of servers.values()) await s.close();
});

async function open(
  fixture: string,
  vp: { width: number; height: number },
  mode: string,
  motion = "reduce",
  count = PATTERNS.length,
) {
  const ctx = await browser.newContext({
    viewport: vp,
    colorScheme: mode as "light" | "dark",
    reducedMotion: motion as "reduce" | "no-preference",
    locale: "ru-RU",
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(servers.get(fixture)?.url ?? "");
  await page.waitForFunction((n) => document.querySelectorAll("[data-preview]").length === n, count);
  await page.evaluate(() => document.fonts.ready);
  // Lazy photos below the fold load too: every image is checked (loaded, alt), not only the first screen.
  await page.evaluate(() =>
    Promise.all(
      [...document.images].map((i) => {
        i.loading = "eager";
        return i.complete
          ? null
          : new Promise((r) => {
              i.addEventListener("load", r);
              i.addEventListener("error", r);
              setTimeout(r, 5000);
            });
      }),
    ),
  );
  return { page, errors };
}

async function checks(page: Page, touch: boolean): Promise<V3CheckResult> {
  await page.addScriptTag({ content: V3_CHECKS_SCRIPT });
  return page.evaluate(
    (t) =>
      (window as unknown as { __v3: { run(o: { touch: boolean }): V3CheckResult } }).__v3.run({ touch: t }),
    touch,
  );
}

describe.skipIf(!hasChromium)("pattern library v3 in chromium", () => {
  const runs = DESIGN_FIXTURES.flatMap((f, fi) =>
    SIZES.flatMap((vp) => MODES.map((mode) => [f.id, vp.width, mode, fi, vp] as const)),
  );
  test.each(runs)(
    "%s %ipx %s: every pattern renders without overflow, with AA contrast, names, headings, touch targets",
    async (fixture, width, mode, fi, vp) => {
      const { page, errors } = await open(fixture, vp, mode);
      const r = await checks(page, width === 390);
      expect({ errors, scroll: r.scroll, problems: r.result }).toEqual({
        errors: [],
        scroll: 0,
        problems: {},
      });
      for (const [pi, p] of PATTERNS.entries())
        if (pi % DESIGN_FIXTURES.length === fi)
          await page
            .locator(`[data-preview="${p.id}"]`)
            .screenshot({ path: join(SHOTS, `${p.id}-${fixture}-${width}-${mode}.png`) });
      await page.context().close();
    },
    120_000,
  );

  test("motion: the first screen enters once only with the lively profile and without reduced motion, then stays visible", async () => {
    // Records the sections whose elements were ever rendered hidden (opacity 0) by Motion.
    const record = () => {
      const w = window as unknown as { __hidden: Set<string> };
      w.__hidden = new Set();
      const look = (el: Element) => {
        for (const e of [el, ...el.querySelectorAll("*")])
          if (e instanceof HTMLElement && e.style.opacity === "0")
            w.__hidden.add(e.closest("[data-preview]")?.getAttribute("data-preview") ?? "?");
      };
      new MutationObserver((ms) => {
        for (const m of ms) {
          if (m.target instanceof Element) look(m.target);
          for (const n of m.addedNodes) if (n instanceof Element) look(n);
        }
      }).observe(document, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
    };
    const run = async (fixture: string, motion: "reduce" | "no-preference") => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: motion });
      await ctx.addInitScript(record);
      const page = await ctx.newPage();
      await page.goto(servers.get(fixture)?.url ?? "");
      await page.waitForFunction(
        (n) => document.querySelectorAll("[data-preview]").length === n,
        PATTERNS.length,
      );
      await page.waitForTimeout(1500);
      const hidden = await page.evaluate(() =>
        [...(window as unknown as { __hidden: Set<string> }).__hidden].sort(),
      );
      const stillHidden = await page.evaluate(() =>
        [...document.querySelectorAll("[data-preview] *")]
          .filter((e) => getComputedStyle(e).opacity !== "1")
          .map((e) => e.closest("[data-preview]")?.getAttribute("data-preview")),
      );
      await ctx.close();
      return { hidden, stillHidden };
    };
    const lively = await run("afisha", "no-preference");
    expect(lively.hidden.length).toBeGreaterThanOrEqual(6);
    expect(lively.hidden.every((id) => id.startsWith("hero-"))).toBe(true);
    expect(lively.stillHidden).toEqual([]);
    expect(await run("afisha", "reduce")).toEqual({ hidden: [], stillHidden: [] });
    expect(await run("reestr", "no-preference")).toEqual({ hidden: [], stillHidden: [] });
  }, 60_000);

  test("headers @390px: «Меню» opens the menu panel, Esc closes it and returns focus to the toggle", async () => {
    const { page } = await open("zabota", { width: 390, height: 844 }, "light");
    const headers = PATTERNS.filter((p) => p.sectionType === "header");
    for (const h of headers) {
      const root = page.locator(`[data-preview="${h.id}"]`);
      const toggle = root.locator("button[aria-controls]");
      await toggle.click();
      expect(await toggle.getAttribute("aria-expanded"), h.id).toBe("true");
      const panel = page.locator(`[id="${await toggle.getAttribute("aria-controls")}"]`);
      expect(await panel.isVisible(), h.id).toBe(true);
      expect(await panel.locator("a").count(), h.id).toBeGreaterThanOrEqual(5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), h.id).toBe(
        0,
      );
      await page.keyboard.press("Escape");
      await expect.poll(() => panel.count(), { timeout: 2000 }).toBe(0);
      expect(await toggle.getAttribute("aria-expanded"), h.id).toBe("false");
      expect(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-controls") ?? null),
        h.id,
      ).not.toBeNull();
    }
    await page.context().close();
  }, 60_000);

  test("the checks catch what they look for: overflow, contrast, photo without scrim, alt, names, headings, touch", async () => {
    const broken = {
      id: "broken-sample",
      props: {},
      source: [
        "export default function BrokenSample() {",
        "  return (",
        '    <section className="bg-background text-foreground">',
        "      <h1>Лишний заголовок первого уровня</h1>",
        '      <p className="text-border">Бледный текст на фоне страницы</p>',
        '      <div className="w-[640px]">Слишком широкий блок</div>',
        '      <div className="relative h-40">',
        '        <img src="/_wizard/photos/broken.webp" className="absolute inset-0 h-full w-full" />',
        '        <p className="relative text-background">Текст прямо на фото</p>',
        "      </div>",
        '      <a href="/x" className="text-small">Мелко</a>',
        '      <button type="button" className="size-11"></button>',
        "    </section>",
        "  );",
        "}",
        "",
      ].join("\n"),
    };
    const f = DESIGN_FIXTURES[0];
    if (!f) throw new Error("no fixtures");
    const { spec, files } = previewSystem(f, [broken]);
    const built = await buildSystem({ spec, files, env: "prod" });
    expect(built.errors).toEqual([]);
    const server = await servePreview(spec, built);
    servers.set("broken", server);
    const { page } = await open("broken", { width: 390, height: 844 }, "light", "reduce", 1);
    const r = await checks(page, true);
    const found = (r.result["broken-sample"] ?? []).join("\n");
    expect(r.scroll).toBeGreaterThan(0);
    for (const what of [
      "переполнение: div «Слишком широкий блок»",
      "контраст: p «Бледный текст на фоне страницы»",
      "контраст: p «Текст прямо на фото» → ",
      "(на фото)",
      "доступность: img без alt",
      "доступность: button без имени",
      "заголовки: 1 h1",
      "касание: a «Мелко»",
    ])
      expect(found).toContain(what);
    await page.context().close();
  }, 60_000);
});
