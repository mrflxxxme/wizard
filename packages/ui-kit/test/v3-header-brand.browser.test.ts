// Pilot 10.10.2026 (final measurement): on a 390 px phone the brand of a v3 header broke inside a word —
// «Турфирма из / Петрозаводс / ка» in the brand block. Every header variant × the design systems of every archetype
// (each display face, type scale, density and text face its seeds pick) at 390×844 with long brands from briefs, with
// and without a logo: no word is split across lines unless this Chromium hyphenates (hyphens: auto with a dictionary),
// nothing overflows the page, the brand's own box (the colour block) or the «Меню» button, the brand stays ≥ 13 px; at
// 1280 the brand keeps the size of its type step (the desktop look is unchanged). The page is built like a system's:
// Tailwind v4 of @wizard/build over the design system CSS (codegen's ui/design.css) with the ui-kit base CSS in its
// layer (body overflow-wrap: anywhere), the headers rendered by React. FONT_ADVANCE is re-measured for every face.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { compileTailwind, layeredCss, tailwindCandidates } from "../../build/src/tailwind.js";
import { FONT_CATALOG, fontFaceCss } from "../src/tokens/fonts.js";
import {
  ARCHETYPES,
  type DesignSystemV3,
  designSystemCss,
  designSystemV3,
  FIT_WORDS_CSS,
  FIT_WORDS_MAX,
  FONT_ADVANCE,
} from "../src/v3/design/index.js";
import { fitWords, FIT_WORDS_MAX as HEADLESS_FIT_MAX } from "../src/v3/headless/fit.js";
import HeaderBrandBlock from "../src/v3/patterns/header/brand-block.js";
import HeaderCentered from "../src/v3/patterns/header/centered.js";
import HeaderClassic from "../src/v3/patterns/header/classic.js";
import HeaderFloating from "../src/v3/patterns/header/floating.js";
import { HEADER_EXAMPLE, HEADER_PATTERNS } from "../src/v3/patterns/header/index.js";
import HeaderMasthead from "../src/v3/patterns/header/masthead.js";
import HeaderMenuFirst from "../src/v3/patterns/header/menu-first.js";
import HeaderSplitNav from "../src/v3/patterns/header/split-nav.js";
import HeaderUtilityBar from "../src/v3/patterns/header/utility-bar.js";
import { ARTIFACTS, hasChromium, UI_KIT_ROOT } from "./helpers/demo.js";

const ORIGIN = "http://header.wizard.test";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const BRANDS = ["Турфирма из Петрозаводска", "Стоматологическая клиника в Казани"] as const;
const LOGO = { src: "/_wizard/photos/logo.svg", alt: "Логотип" };
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72"><rect width="72" height="72" rx="12" fill="#2f6f4f"/></svg>';

const COMPONENTS: Record<string, unknown> = {
  classic: HeaderClassic,
  centered: HeaderCentered,
  "split-nav": HeaderSplitNav,
  "utility-bar": HeaderUtilityBar,
  floating: HeaderFloating,
  "menu-first": HeaderMenuFirst,
  masthead: HeaderMasthead,
  "brand-block": HeaderBrandBlock,
};

/** Long Russian words of business names, wide letters (ж, ш, щ, ы, м, ю) included: the corpus of FONT_ADVANCE. */
const LONG_WORDS =
  "турфирма петрозаводска стоматологическая екатеринбурге парикмахерская автомастерская кондитерская юридическая " +
  "бухгалтерская ветеринарная строительная фотостудия шиномонтаж хлебопекарня косметологическая многопрофильная " +
  "психологический логопедический архитектурное туристическое транспортная недвижимость широкоформатная мебельная " +
  "ювелирная электромонтаж деревообработка медицинский образовательный ортодонтическая хореографическая " +
  "художественная музыкальная железнодорожный электрощитовая шоколадница фармацевтическая металлообработка " +
  "энергосбытовая железногорска мурманска новосибирска владивостока красноярска сельскохозяйственная мастерская " +
  "барбершоп маникюра химчистка гостиница шумоизоляция мемориальный журналистика мясокомбинат шашлычная " +
  "шиномонтажная фотошкола шахматная межевание юриспруденция иммунология маммология массажистка вышивальщица " +
  "мыловаренная мебельщики щитовая жемчужина мурманский чемпионат";

/** Design systems of an archetype: one per display face × weight × text face × type scale × density its seeds pick. */
function systemsOf(archetype: string): DesignSystemV3[] {
  const out = new Map<string, DesignSystemV3>();
  for (let seed = 0; seed < 200; seed++) {
    const ds = designSystemV3({
      archetype: archetype as DesignSystemV3["archetype"],
      seed,
      niche: "Турфирма",
    });
    const key = [
      ds.fonts.display.family,
      ds.fonts.display.weight,
      ds.fonts.text.family,
      ds.type.scale,
      ds.grid.rhythm.density,
    ].join("|");
    if (!out.has(key)) out.set(key, ds);
  }
  return [...out.values()];
}

type Case = { id: string; html: string };

/** Every header variant with each brand (and the long one with a logo where the variant shows one). */
function cases(): Case[] {
  const out: Case[] = [];
  for (const p of HEADER_PATTERNS) {
    const Component = COMPONENTS[p.variant] as FunctionComponent<Record<string, unknown>>;
    const brands: { name: string; logo?: typeof LOGO }[] = BRANDS.map((name) => ({ name }));
    if (p.variant !== "masthead") brands.push({ name: BRANDS[1], logo: LOGO });
    brands.forEach((b, i) => {
      const props = p.slots.parse({ ...HEADER_EXAMPLE, brand: { ...b, href: "/" } }) as Record<
        string,
        unknown
      >;
      const id = `${p.id}/${b.logo ? "logo" : i}`;
      out.push({ id, html: renderToStaticMarkup(createElement(Component, props)) });
    });
  }
  return out;
}

const BASE_CSS = readFileSync(join(UI_KIT_ROOT, "src/base.css"), "utf8");
const CANDIDATES = tailwindCandidates(
  new Map([
    ...HEADER_PATTERNS.map((p) => [p.file, p.source] as const),
    ["ui/pages/Preview.tsx", 'const x = "bg-background";'] as const,
  ]),
);

/** The stylesheet of a system with these headers: Tailwind over ui/design.css (as codegen writes it), base CSS layered. */
async function systemCss(ds: DesignSystemV3): Promise<string> {
  const design = designSystemCss(ds, { fonts: true }).replaceAll(":root[data-scheme=auto]", ":root");
  const tw = await compileTailwind(design, CANDIDATES);
  if (!tw.ok) throw new Error(tw.error);
  return layeredCss(tw.css, BASE_CSS);
}

const html = (css: string, body: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body>${body}</body></html>`;

let browser: Browser;
let CASES: Case[] = [];
beforeAll(async () => {
  if (!hasChromium) return;
  CASES = cases();
  browser = await chromium.launch();
  mkdirSync(ARTIFACTS, { recursive: true });
}, 60_000);
afterAll(async () => browser?.close());

/** Opens the page on a fake origin that serves /_wizard/fonts/* (like the runtime) and the logo. */
async function open(doc: string): Promise<Page> {
  const ctx = await browser.newContext({ locale: "ru-RU", viewport: PHONE, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html; charset=utf-8", body: doc });
    if (path === LOGO.src) return route.fulfill({ contentType: "image/svg+xml", body: LOGO_SVG });
    const font = /^\/_wizard\/fonts\/([\w.-]+\.woff2)$/.exec(path);
    if (!font) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      contentType: "font/woff2",
      body: readFileSync(join(UI_KIT_ROOT, "fonts", font[1] as string)),
    });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.fonts.status === "loaded");
  return page;
}

/** A new viewport, once the page lays out at it (media queries included). */
async function resize(page: Page, vp: { width: number; height: number }): Promise<void> {
  await page.setViewportSize(vp);
  await page.waitForFunction((w) => innerWidth === w && matchMedia(`(width: ${w}px)`).matches, vp.width);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

type Measure = { problems: string[]; sizes: Record<string, [number, number]>; floor: string[] };

/**
 * In-page check of every [data-case]: each word of the brand on one line (a split passes only where this Chromium
 * hyphenates and the brand has hyphens: auto), the brand inside the page, its link box and clear of the menu button,
 * no horizontal scroll; sizes[id] = [brand px, its link's px]; floor — the cases at the smallest size.
 */
function inPage(minPx: number): Measure {
  const probe = document.createElement("p");
  probe.lang = "ru";
  probe.style.cssText = "position:absolute;width:4em;hyphens:auto;font:16px sans-serif;overflow-wrap:normal";
  probe.textContent = "Стоматологическая";
  document.body.append(probe);
  const range = document.createRange();
  range.selectNodeContents(probe);
  const hyphenates = new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1;
  probe.remove();

  const problems: string[] = [];
  const sizes: Record<string, [number, number]> = {};
  const floor: string[] = [];
  const lines = (rects: DOMRectList) => new Set([...rects].map((r) => Math.round(r.top + r.height / 2))).size;
  for (const root of document.querySelectorAll<HTMLElement>("[data-case]")) {
    const id = root.dataset.case ?? "?";
    const text = root.querySelector<HTMLElement>("[data-fit-words]");
    const link = text?.closest("a");
    if (!text || !link) {
      problems.push(`${id}: нет названия`);
      continue;
    }
    const cs = getComputedStyle(text);
    const px = Number.parseFloat(cs.fontSize);
    sizes[id] = [px, Number.parseFloat(getComputedStyle(link).fontSize)];
    if (px < minPx - 0.01) problems.push(`${id}: кегль ${px.toFixed(1)} px < ${minPx}`);
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    const box = link.getBoundingClientRect();
    // A word too long even at the smallest size is left to hyphenation (hyphens: auto); without a Russian dictionary in
    // this Chromium it runs on past a link without a background — but never past a colour block, the button or the screen.
    const atFloor = px <= minPx + 0.05;
    const fallback = atFloor && cs.hyphens === "auto" && !hyphenates;
    const clear = /^(?:transparent|rgba\(0, 0, 0, 0\))$/.test(getComputedStyle(link).backgroundColor);
    if (atFloor) floor.push(id);
    const toggle = root.querySelector("button[aria-expanded]")?.getBoundingClientRect();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const s = n.textContent ?? "";
      for (const m of s.matchAll(/\S+/g)) {
        const r = document.createRange();
        r.setStart(n, m.index ?? 0);
        r.setEnd(n, (m.index ?? 0) + m[0].length);
        const rects = r.getClientRects();
        const count = lines(rects);
        if (count > 1 && !(hyphenates && cs.hyphens === "auto"))
          problems.push(`${id}: «${m[0]}» разорвано на ${count} строки без дефиса (${px.toFixed(1)} px)`);
        for (const q of rects) {
          if (q.left < -1 || q.right > innerWidth + 1)
            problems.push(`${id}: «${m[0]}» за краем экрана ${Math.round(q.left)}…${Math.round(q.right)}`);
          if ((q.left < box.left - 1 || q.right > box.right + 1) && !(fallback && clear))
            problems.push(
              `${id}: «${m[0]}» вылезает из ссылки ${Math.round(q.right)} > ${Math.round(box.right)} (${px.toFixed(1)} px, ${cs.letterSpacing})`,
            );
          if (
            toggle &&
            toggle.width > 0 &&
            q.right > toggle.left &&
            q.left < toggle.right &&
            q.bottom > toggle.top &&
            q.top < toggle.bottom
          )
            problems.push(`${id}: «${m[0]}» налезает на кнопку «Меню»`);
        }
      }
    }
    if (toggle && toggle.width > 0 && (toggle.right > innerWidth + 1 || toggle.left < -1))
      problems.push(`${id}: кнопка «Меню» за краем экрана`);
  }
  const scroll = document.documentElement.scrollWidth - innerWidth;
  if (scroll > 0) problems.push(`горизонтальная прокрутка ${scroll} px`);
  return { problems, sizes, floor };
}

describe.skipIf(!hasChromium)("v3 headers: the brand on a 390 px phone", () => {
  test("every header variant is covered; fitWords and the design CSS agree on the longest word", () => {
    expect(HEADER_PATTERNS.map((p) => p.variant).sort()).toEqual(Object.keys(COMPONENTS).sort());
    expect(HEADLESS_FIT_MAX).toBe(FIT_WORDS_MAX);
    expect(FIT_WORDS_CSS).toContain(`[data-fit-words="${FIT_WORDS_MAX}"]{--fit-chars:${FIT_WORDS_MAX}}`);
    expect(fitWords(" Турфирма  из Петрозаводска ")).toEqual({
      words: [
        { at: 0, text: "Турфирма" },
        { at: 10, text: "из" },
        { at: 13, text: "Петрозаводска" },
      ],
      chars: 13,
    });
    expect(fitWords("Сельскохозяйственнаяпроизводственнаякооперация").chars).toBe(FIT_WORDS_MAX);
    for (const c of CASES) expect(c.html, c.id).toContain("data-fit-words=");
  });

  test("FONT_ADVANCE: no catalog face draws a long word wider than its entry (re-measured at 400 and 700)", async () => {
    const page = await open(html(fontFaceCss(FONT_CATALOG.map((f) => f.family)), ""));
    const measured = await page.evaluate(
      async ({ families, words }) => {
        const out: Record<string, [number, number, number, number]> = {};
        const ctx = document.createElement("canvas").getContext("2d") as CanvasRenderingContext2D;
        for (const family of families) {
          const row: number[] = [];
          for (const weight of [400, 700]) {
            await document.fonts.load(`${weight} 100px "${family}"`, "Привет");
            ctx.font = `${weight} 100px "${family}"`;
            let lower = 0;
            let caps = 0;
            for (const w of words) {
              const cap = (w[0] ?? "").toUpperCase() + w.slice(1);
              lower = Math.max(lower, ctx.measureText(cap).width / (100 * w.length));
              caps = Math.max(caps, ctx.measureText(w.toUpperCase()).width / (100 * w.length));
            }
            row.push(lower, caps);
          }
          out[family] = row as [number, number, number, number];
        }
        return out;
      },
      { families: FONT_CATALOG.map((f) => f.family), words: LONG_WORDS.split(" ") },
    );
    await page.context().close();
    expect(Object.keys(FONT_ADVANCE).sort()).toEqual(FONT_CATALOG.map((f) => f.family).sort());
    const off: string[] = [];
    for (const [family, m] of Object.entries(measured)) {
      const t = FONT_ADVANCE[family];
      if (!t) continue;
      const table = [t[400][0], t[400][1], t[700][0], t[700][1]];
      table.forEach((v, i) => {
        const got = m[i] as number;
        // At least as wide as the face draws, and not so wide that brands shrink for nothing.
        if (got > v + 1e-6 || v - got > 0.02) off.push(`${family} [${i}]: ${v} ≠ ${got.toFixed(4)}`);
      });
    }
    expect(off).toEqual([]);
  }, 60_000);

  for (const a of ARCHETYPES)
    test(`${a.id}: every variant keeps each word of the brand whole at 390, nothing overflows; 1280 unchanged`, async () => {
      const body = `<main class="bg-background">${CASES.map((c) => `<div data-case="${c.id}">${c.html}</div>`).join("")}</main>`;
      const found: string[] = [];
      for (const [i, ds] of systemsOf(a.id).entries()) {
        const label = `${ds.fonts.display.family} ${ds.fonts.display.weight}/${ds.fonts.text.family}, ${ds.type.scale}, ${ds.grid.rhythm.density}`;
        const page = await open(html(await systemCss(ds), body));
        const phone = await page.evaluate(inPage, 13);
        found.push(...phone.problems.map((p) => `${label} 390: ${p}`));
        // Without a logo both brands fit above the smallest size everywhere: the fallback is for logos and longer words.
        found.push(
          ...phone.floor.filter((id) => !id.endsWith("/logo")).map((id) => `${label} 390: ${id} на минимуме`),
        );
        await resize(page, DESKTOP);
        const desk = await page.evaluate(inPage, 0);
        // The desktop look is unchanged: the brand has the size of its type step (the link's), whatever its length.
        for (const [id, [px, step]] of Object.entries(desk.sizes))
          if (Math.abs(px - step) > 0.01) found.push(`${label} 1280: ${id} ${px} px ≠ ступень ${step} px`);
        if (i === 0) {
          await resize(page, PHONE);
          await page.screenshot({ path: join(ARTIFACTS, `header-brand-${a.id}-390.png`), fullPage: true });
        }
        await page.context().close();
      }
      expect(found).toEqual([]);
    }, 120_000);
});
