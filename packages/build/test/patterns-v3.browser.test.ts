// V3-08 acceptance (browser): every pattern of the library × 4 real design systems (V3-07: luxury, bold poster, calm
// medical, night contrast) × 390/1280 px ×
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
import { REAL_DESIGNS as DESIGN_FIXTURES } from "./fixtures-v3.js";
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
  // fonts.ready resolves at once while no face has started loading: every declared face is loaded first, so a width
  // check never measures the fallback font (CI 11.10.2026: «Стоматологическая» cut in every hero of calm_medical).
  await page.evaluate(() => Promise.all([...document.fonts].map((f) => f.load().catch(() => null))));
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
    const lively = await run("bold_poster", "no-preference");
    expect(lively.hidden.length).toBeGreaterThanOrEqual(6);
    expect(lively.hidden.every((id) => id.startsWith("hero-"))).toBe(true);
    expect(lively.stillHidden).toEqual([]);
    expect(await run("bold_poster", "reduce")).toEqual({ hidden: [], stillHidden: [] });
    expect(await run("luxury", "no-preference")).toEqual({ hidden: [], stillHidden: [] });
  }, 60_000);

  test("CLS: every pattern alone on a page loads without a layout shift over 0.1 (empty data and with data, 390 and 1440)", async () => {
    // The critic's measure (builds-v3/critic.ts): layout shifts since navigation without input, read once the page
    // settled — nothing aria-busy, the fonts ready, two frames and a quiet time. The section has the rest of a page
    // after it: a loading state taller or shorter than the loaded one moves it.
    const f = DESIGN_FIXTURES[0];
    if (!f) throw new Error("no fixtures");
    const { spec, files } = previewSystem(f, previewItems(PATTERNS), { solo: true });
    const built = await buildSystem({ spec, files, env: "prod" });
    expect(built.errors).toEqual([]);
    const server = await servePreview(spec, built);
    servers.set("solo", server);
    const observe = () => {
      const w = window as unknown as { __cls: number };
      w.__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { hadRecentInput: boolean; value: number }[])
          if (!e.hadRecentInput) w.__cls += e.value;
      }).observe({ type: "layout-shift", buffered: true });
    };
    const found: string[] = [];
    for (const mode of ["empty", "ok"] as const) {
      server.setMode(mode);
      for (const vp of [
        { width: 390, height: 844 },
        { width: 1440, height: 900 },
      ]) {
        const ctx = await browser.newContext({ viewport: vp, reducedMotion: "reduce", locale: "ru-RU" });
        await ctx.addInitScript(observe);
        const queue = [...PATTERNS];
        const worker = async () => {
          for (let p = queue.shift(); p; p = queue.shift()) await measure(p);
        };
        const measure = async (p: (typeof PATTERNS)[number]) => {
          const page = await ctx.newPage();
          await page.goto(`${server.url}/?p=${p.id}`, { waitUntil: "load" });
          await page
            .waitForFunction(
              () =>
                !!document.querySelector("[data-solo-after]") && !document.querySelector("[aria-busy=true]"),
              undefined,
              { timeout: 5000 },
            )
            .catch(() => {});
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          const cls = await page.evaluate(
            () =>
              new Promise<number>((r) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() =>
                    setTimeout(() => r((window as unknown as { __cls: number }).__cls), 150),
                  ),
                ),
              ),
          );
          if (cls > 0.1) found.push(`${p.id} ${mode} ${vp.width}: CLS ${cls.toFixed(3)}`);
          await page.close();
        };
        // Three pages at a time: the measure is per page (its own observer since its navigation).
        await Promise.all([worker(), worker(), worker()]);
        await ctx.close();
      }
    }
    server.setMode("ok");
    expect(found).toEqual([]);
  }, 600_000);

  test("V3-18 @390px: a first screen's long Russian words stay whole, «Меню» stays on one line", async () => {
    // The critic saw «Стоматологическ/ая», «Екатеринбург/е» and «Ме/ню» on the pilot: words cut without a hyphen.
    const title = "Стоматологическая клиника «Улыбка» в Екатеринбурге";
    const items = PATTERNS.filter((p) => p.sectionType === "hero" || p.sectionType === "header").map((p) => {
      const props = p.slots.parse(p.example) as Record<string, unknown>;
      if (p.sectionType === "hero") props.title = title;
      if (p.sectionType === "header")
        props.brand = { ...(props.brand as object), name: "Стоматологическая клиника в Казани" };
      return { id: p.id, source: p.source, props };
    });
    for (const f of DESIGN_FIXTURES) {
      const { spec, files } = previewSystem(f, items);
      const built = await buildSystem({ spec, files, env: "prod" });
      expect(built.errors).toEqual([]);
      const server = await servePreview(spec, built);
      servers.set(`words-${f.id}`, server);
      const { page } = await open(
        `words-${f.id}`,
        { width: 390, height: 844 },
        "light",
        "reduce",
        items.length,
      );
      const broken = await page.evaluate(() => {
        const out: string[] = [];
        // A word whose range takes more than one line box was cut inside.
        const words = (el: Element) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.textContent ?? "";
            for (const m of text.matchAll(/\S+/g)) {
              const r = document.createRange();
              r.setStart(n, m.index ?? 0);
              r.setEnd(n, (m.index ?? 0) + m[0].length);
              const lines = new Set([...r.getClientRects()].map((x) => Math.round(x.top)));
              if (lines.size > 1)
                out.push(`${el.closest("[data-preview]")?.getAttribute("data-preview")}: ${m[0]}`);
            }
          }
        };
        for (const h of document.querySelectorAll("h1")) words(h);
        for (const b of document.querySelectorAll("button[aria-controls]")) words(b);
        return out;
      });
      expect(broken, f.id).toEqual([]);
      await page.context().close();
    }
  }, 180_000);

  test("headers @390px: «Меню» opens the menu panel, Esc closes it and returns focus to the toggle", async () => {
    const { page } = await open("calm_medical", { width: 390, height: 844 }, "light");
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
