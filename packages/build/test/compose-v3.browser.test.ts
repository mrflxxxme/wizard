// V3-12 acceptance (browser): a public site composed by the page composer — three pages from library patterns, a page
// written for a scenario with a signature section in free code, a form bound to the headless hook — built by
// buildSystem (Tailwind over the client's design system, React and Motion in the bundle) and checked in Chromium at
// 390 px (light) and 1280 px (dark): no errors, no horizontal overflow, contrast AA, named controls, alt texts, one h1
// and heading order, touch targets ≥ 44 px on phones. Every page carries its title, description and Open Graph tags;
// the menu leads from page to page. Screenshots go to test/artifacts/compose-v3/.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "@playwright/test";
import type { AppSpec, BriefScenario } from "@wizard/appspec";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createPageComposer,
  type PageComposeAnswer,
  readSite,
  type SiteModel,
  withSitePages,
} from "../../agents/src/builder/v3/compose/index.js";
import type { V3BuildContext, V3ComposeResult } from "../../agents/src/builder/v3/contract.js";
import { BRIEF, composeContext, SIGNATURE_OK } from "../../agents/test/v3-compose-fixtures.js";
import { type BuildResult, buildSystem } from "../src/index.js";
import { PKG_ROOT } from "./helpers.js";
import { V3_CHECKS_SCRIPT, type V3CheckResult } from "./v3-checks.js";
import { type PreviewServer, servePreview } from "./v3-harness.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const SHOTS = join(PKG_ROOT, "test/artifacts/compose-v3");
const TOP = "/_wizard/photos/00000000-0000-4000-8000-000000000000/1600";

const HOME: PageComposeAnswer & { signature: { after: string; title: string; idea: string } } = {
  sections: [
    {
      id: "hero",
      pattern: "hero-full-bleed",
      props: {
        title: "Лечим зубы без боли и очередей",
        lead: "Оставьте заявку на сайте — администратор перезвонит за 15 минут и подберёт время приёма.",
        action: { label: "Записаться на приём", href: "#form" },
        image: { src: TOP, alt: "Светлый кабинет клиники с креслом у окна" },
      },
    },
    {
      id: "form",
      pattern: "form-centered",
      props: {
        title: "Запишитесь на приём",
        text: "Оставьте имя и телефон — перезвоним за 15 минут.",
        submit: "Записаться на приём",
        sent: { title: "Заявка отправлена" },
      },
    },
  ],
  seo: {
    title: "Белая линия — лечение зубов без боли",
    description:
      "Стоматологическая клиника «Белая линия»: оставьте заявку на сайте, администратор перезвонит за 15 минут.",
  },
  signature: {
    after: "hero",
    title: "Как проходит первый приём",
    idea: "Путь пациента по шагам из брифа: заявка на сайте, звонок администратора, приём у врача.",
  },
};

/** Recorded answers of the two model calls (page_compose, signature_section), no network. */
type Route = V3BuildContext["route"];
const route: Route = async (input) => {
  const page = input.callType === "page_compose";
  return {
    tier: "T1",
    model: "glm-5.3",
    result: {
      toolCalls: [
        { id: "c1", name: page ? "submit_page" : "submit_section", args: page ? HOME : SIGNATURE_OK },
      ],
      finishReason: "tool-calls",
    },
    usage: { inputTokens: 6000, cachedTokens: 0, outputTokens: 1500 },
    creditsCharged: 0.6,
    creditsMilli: 600,
    routeReason: "default_T1",
    scrubbed: true,
    ruFallback: false,
  } as Awaited<ReturnType<Route>>;
};

function apply(files: ReadonlyMap<string, string>, out: V3ComposeResult): Map<string, string> {
  const next = new Map(files);
  for (const [p, v] of out.files) {
    if (v === null) next.delete(p);
    else next.set(p, v);
  }
  return next;
}

/** A photo-like SVG for /_wizard/photos/<id>/<width> (the preview server knows one-segment names only). */
const PHOTO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067" viewBox="0 0 1600 1067"><rect width="1600" height="1067" fill="#5d7f8f"/><circle cx="1000" cy="480" r="260" fill="#c9d6dc"/></svg>';

let browser: Browser;
let server: PreviewServer;
let built: BuildResult;
let site: SiteModel;
let spec: AppSpec;

beforeAll(async () => {
  if (!hasChromium) return;
  mkdirSync(SHOTS, { recursive: true });
  const base = composeContext();
  const composer = createPageComposer({
    patterns: PATTERNS,
    verify: async () => ({ ok: true, problems: [] }),
  });
  const skeleton = await composer.skeleton(base);
  const ctx: V3BuildContext = { ...base, files: apply(base.files, skeleton), route };
  const scenario = await composer.scenario(ctx, BRIEF.scenarios[0] as BriefScenario);
  const files = apply(ctx.files, scenario);
  site = readSite(files) as SiteModel;
  spec = withSitePages(ctx.spec, site);
  built = await buildSystem({ spec, files, env: "prod" });
  if (!built.ok) throw new Error(JSON.stringify(built.errors, null, 1));
  server = await servePreview(spec, built);
  browser = await chromium.launch();
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function open(path: string, vp: { width: number; height: number }, mode: "light" | "dark") {
  const ctx = await browser.newContext({
    viewport: vp,
    colorScheme: mode,
    reducedMotion: "reduce",
    locale: "ru-RU",
  });
  await ctx.route("**/_wizard/photos/**", (r) =>
    r.fulfill({ contentType: "image/svg+xml", body: PHOTO_SVG }),
  );
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(`${server.url}${path}`);
  await page.waitForSelector("#main");
  await page.evaluate(() => document.fonts.ready);
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

/** The v3 checks over the whole page: the app root as one «hero-…» root (exactly one h1). */
async function checks(page: Page, touch: boolean): Promise<V3CheckResult> {
  await page.evaluate(() => document.getElementById("root")?.setAttribute("data-preview", "hero-page"));
  await page.addScriptTag({ content: V3_CHECKS_SCRIPT });
  return page.evaluate(
    (t) =>
      (window as unknown as { __v3: { run(o: { touch: boolean }): V3CheckResult } }).__v3.run({ touch: t }),
    touch,
  );
}

const meta = (page: Page, sel: string) =>
  page.evaluate((s) => document.head.querySelector(s)?.getAttribute("content") ?? null, sel);

describe.skipIf(!hasChromium)("composed v3 site in chromium", () => {
  test("the site: three pages, the scenario page with its signature section and the bound form", () => {
    expect(site.pages.map((p) => p.route)).toEqual(["/", "/services", "/photos"]);
    expect(site.pages[0]?.sections.map((s) => s.id)).toEqual([
      "header",
      "hero",
      "first-visit",
      "form",
      "footer",
    ]);
  });

  const runs = ["/", "/services", "/photos"].flatMap((path) => [
    [path, 390, "light", { width: 390, height: 844 }] as const,
    [path, 1280, "dark", { width: 1280, height: 800 }] as const,
  ]);
  test.each(runs)(
    "%s at %ipx (%s): no errors, no overflow, AA contrast, names, one h1, heading order, touch targets",
    async (path, width, mode, vp) => {
      const { page, errors } = await open(path, vp, mode);
      const r = await checks(page, width === 390);
      expect({ errors, scroll: r.scroll, problems: r.result }).toEqual({
        errors: [],
        scroll: 0,
        problems: {},
      });
      const name = path === "/" ? "home" : path.slice(1);
      await page.screenshot({ path: join(SHOTS, `${name}-${width}-${mode}.png`), fullPage: true });
      await page.context().close();
    },
    120_000,
  );

  test("SEO: every page sets its title, description and Open Graph; index.html carries the home page's tags", async () => {
    const html = new TextDecoder().decode(built.client.get("index.html"));
    expect(html).toContain(`<title>${HOME.seo.title}</title>`);
    expect(html).toContain('<meta property="og:title" content="Белая линия — лечение зубов без боли">');
    expect(html).toContain(`<meta property="og:image" content="${TOP}">`);
    expect(html).toContain('<meta name="description" content="Стоматологическая клиника');
    for (const p of site.pages) {
      const { page } = await open(p.route, { width: 1280, height: 800 }, "light");
      await expect.poll(() => page.title()).toBe(p.seo.title);
      expect(await meta(page, 'meta[name="description"]')).toBe(p.seo.description);
      expect(await meta(page, 'meta[property="og:title"]')).toBe(p.seo.title);
      expect(await meta(page, 'meta[property="og:description"]')).toBe(p.seo.description);
      expect(await meta(page, 'meta[property="og:image"]')).toBe(
        p.seo.image ? `${server.url}${p.seo.image}` : null,
      );
      await page.context().close();
    }
  }, 120_000);

  test("navigation: the header menu leads to the catalog page and back, the footer lists every page", async () => {
    const { page } = await open("/", { width: 1280, height: 800 }, "light");
    await page.locator("header").getByRole("link", { name: "Каталог и цены" }).first().click();
    await page.waitForURL("**/services");
    await page.waitForSelector("#main");
    await expect.poll(() => page.title()).toBe("Каталог и цены — Белая линия");
    const footer = await page.locator("footer a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(footer).toEqual(expect.arrayContaining(["/", "/services", "/photos", "/privacy"]));
    await page.locator("header").getByRole("link", { name: "Главная" }).first().click();
    await page.waitForURL(/\/$/);
    await expect.poll(() => page.title()).toBe(HOME.seo.title);
    await page.context().close();
  }, 60_000);
});
