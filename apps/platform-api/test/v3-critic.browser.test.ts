// V3-13 acceptance (browser part): the critic's inspector in the process Chromium (builds-v3/critic.ts) on the clinic's
// composed site (V3-12 skeleton on the real pattern library) — built by buildSystem and opened without network at
// 390/768/1440 (light) and 390 (dark): screenshots downscaled to JPEG for the model, deterministic checks without a model
// (contrast, overflow, fonts, CLS, names) attributed to sections; then the whole critic hook: a section variant that
// overflows is swapped by code, two critic_visual cycles on recorded answers (T0, ≤ 40 ₽) with an edit re-checked by
// G0 and the browser; the result builds. V3-40: the critic judges the site the visitor sees — the draft's demo rows of
// the public role in the catalog, shop and blog (private entities stay empty), the library's photos loaded in the shots
// even when the shared storage answers after the page has rendered.
import { existsSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { chromium, type Page } from "@playwright/test";
import {
  CRITIC_VIEWPORTS,
  type CriticInspection,
  readSite,
  runCritic,
  seedHintsFromBrief,
  shotPlan,
  withSitePages,
} from "@wizard/agents/builder";
import { buildSystem } from "@wizard/build";
import { MemoryFileStorage, storeLibraryPhoto } from "@wizard/runtime";
import { PATTERNS, type PatternMeta } from "@wizard/ui-kit/v3/patterns";
import { afterAll, describe, expect, test } from "vitest";
import { siteFacts, siteFiles } from "../../../packages/agents/src/builder/v3/compose/index.js";
import { briefSite, evalRequest } from "../../../packages/agents/test/v3-brief-site.js";
import {
  criticContext,
  critique,
  critiqueLines,
  firstPrompt,
  fixtureRoute,
  registry,
} from "../../../packages/agents/test/v3-critic-fixtures.js";
import { CERAMICS_SHOP, EVAL_BRIEFS, KARELIA_TOURS } from "../../../packages/agents/test/v3-eval-briefs.js";
import { chromiumProvider, type GoalBrowserProvider } from "../src/agents/goal-browser.js";
import {
  CRITIC_ORIGIN,
  criticInspector,
  criticLibraryPhotos,
  draftDemoRows,
  platformCritic,
} from "../src/builds-v3/critic.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const browser = chromiumProvider({ slots: 1 });
afterAll(() => browser.close());

const ctx = await criticContext();
const fonts = [ctx.design.fonts.display.family, ctx.design.fonts.text.family];
const routes = ctx.site.pages.map((p) => p.route);
const HOME = "ui/pages/site/Home.tsx";

/** The home page with problems put into its sections by hand (the build does not lint, the browser sees them). */
function brokenHome(src: string): string {
  return src
    .replace("\nimport ", '\nimport { useEffect, useState } from "react";\nimport ')
    .replace(
      "export default function",
      [
        "function Late() {",
        "  const [on, setOn] = useState(false);",
        "  useEffect(() => {",
        // 100 ms after the page is shown (the first paint waits for the data, @wizard/build): a block pushes the page.
        "    const t = setInterval(() => {",
        '      if (document.getElementById("root")?.style.opacity === "0") return;',
        "      clearInterval(t);",
        "      setTimeout(() => setOn(true), 100);",
        "    }, 10);",
        "    return () => clearInterval(t);",
        "  }, []);",
        "  return on ? <div style={{ height: 420 }} /> : null;",
        "}",
        "",
        "export default function",
      ].join("\n"),
    )
    .replace('<div id="hero">', '<div id="hero">\n          <Late />')
    .replace(
      '<div id="services">',
      [
        '<div id="services">',
        '          <div style={{ width: 1200, height: 8 }} className="bg-foreground" />',
        '          <p style={{ color: "#d6d6d6" }}>Светло-серый текст на светлом фоне</p>',
        '          <img src="/_wizard/photos/00000000-0000-4000-8000-000000000001/800" width={80} height={60} />',
      ].join("\n"),
    );
}

describe.skipIf(!hasChromium)("V3-13 critic in Chromium", () => {
  test("screenshots at 390/768/1440 for the model and a clean site without problems", async () => {
    const r = await criticInspector({ browser })({
      spec: ctx.spec,
      files: ctx.files,
      routes,
      viewports: CRITIC_VIEWPORTS,
      shots: shotPlan(ctx.site),
      fonts,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.stubPhotos).toBe(true);
    expect(
      r.shots.map((s) => `${s.route}@${s.width}:${s.kind} ${s.px.width}×${s.px.height <= s.maxHeight}`),
    ).toEqual(["/@390:screen 390×true", "/@1440:page 360×true"]);
    for (const s of r.shots) {
      expect(s.mime).toBe("image/jpeg");
      expect(Buffer.from(s.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
      // Small images keep a cycle cheap: ≤ 60 KB each.
      expect(s.data.length).toBeLessThan(80_000);
    }
    expect(r.shots[0]?.sections.slice(0, 2)).toEqual(["header", "hero"]);
    expect(r.shots[1]?.sections[0]).toMatch(/^header 0–\d+$/);
  }, 120_000);

  test("V3-18: every page of the eval brief sites loads without a layout shift and without other problems", async () => {
    // The paid checkpoint: CLS > 0,1 on /#hero, /blog, /services, /booking, the header, the footer — the fallback font
    // swapped for the design one, sections bound to data jumped from their loading state to the loaded one.
    const found: string[] = [];
    for (const [id, input] of Object.entries(EVAL_BRIEFS)) {
      const b = await briefSite(id, input);
      if (!b.site.pages.length) continue;
      const r = await criticInspector({ browser })({
        spec: withSitePages(b.spec, b.site),
        files: b.files,
        routes: b.site.pages.map((p) => p.route.replace(/:\w+/g, "x")),
        viewports: CRITIC_VIEWPORTS,
        shots: [],
        fonts: [b.ctx.design.fonts.display.family, b.ctx.design.fonts.text.family],
      });
      expect(r.ok, r.error).toBe(true);
      for (const p of r.problems)
        found.push(`${id} ${p.code} ${p.route}@${p.width} ${p.scheme}: ${p.message_ru}`);
    }
    expect(found).toEqual([]);
  }, 300_000);

  test("deterministic checks without a model: overflow, contrast, CLS, fonts, alt — by section", async () => {
    const files = new Map(ctx.files);
    files.set(HOME, brokenHome(ctx.files.get(HOME) ?? ""));
    const r: CriticInspection = await criticInspector({ browser })({
      spec: ctx.spec,
      files,
      routes: ["/"],
      viewports: CRITIC_VIEWPORTS,
      shots: [],
      fonts: [...fonts, "Несуществующий Гротеск"],
    });
    expect(r.ok, r.error).toBe(true);
    const at = (code: string) => r.problems.filter((p) => p.code === code);
    // Overflow on the phone and the tablet, not on the desktop.
    expect([...new Set(at("L11").map((p) => `${p.section}@${p.width}`))].sort()).toEqual([
      "services@390",
      "services@768",
    ]);
    expect(at("C08").some((p) => p.section === "services" && p.message_ru.includes("Светло-серый"))).toBe(
      true,
    );
    expect(at("CLS").length).toBeGreaterThan(0);
    expect(at("CLS")[0]?.message_ru).toMatch(/CLS \d\.\d{3}/);
    expect(at("T16").map((p) => p.message_ru)).toContain(
      "шрифт «Несуществующий Гротеск» не объявлен на странице",
    );
    expect(
      at("A08").some((p) => p.section === "services" && p.message_ru.startsWith("картинка без alt")),
    ).toBe(true);
    // The design fonts themselves load (no fallback).
    expect(at("T16").every((p) => p.message_ru.includes("Несуществующий"))).toBe(true);
    // The light grey holds on the dark page; problems of the dark theme say so.
    expect(
      at("C08")
        .filter((p) => p.message_ru.includes("Светло-серый"))
        .map((p) => p.scheme),
    ).not.toContain("dark");
    expect(at("L11").some((p) => p.scheme === "dark" && p.message_ru.endsWith("(тёмная тема)"))).toBe(true);
  }, 120_000);

  test("the critic hook end to end: code swaps an overflowing variant, 2 model cycles on T0, edits re-checked", async () => {
    // A services variant that is too wide on phones (outside the library: only this test has it).
    const base = PATTERNS.find((p) => p.id === "services-editorial") as PatternMeta;
    const wide: PatternMeta = {
      ...base,
      id: "services-wide",
      variant: "wide",
      file: "ui/patterns/services-wide.tsx",
      source: base.source.replace(
        /<section([^>]*)>/,
        '<section$1>\n      <div className="h-2 bg-foreground" style={{ width: 1100 }} />',
      ),
    };
    const library = [...PATTERNS, wide];
    const site = structuredClone(ctx.site);
    const services = site.pages[0]?.sections.find((s) => s.id === "services");
    if (services) services.pattern = "services-wide";
    const files = new Map(ctx.files);
    for (const [p, v] of siteFiles(site, siteFacts(ctx).name, ctx.design, ctx.files, new Map(), library))
      v === null ? files.delete(p) : files.set(p, v);
    const fx = fixtureRoute(
      critiqueLines(firstPrompt(ctx), [
        critique(2, [
          {
            sign: "форма заявки ниже услуг уводит действие вниз",
            where: "/@390#form",
            severity: "P1",
            evidence: "изображение 4, форма внизу",
            replace: "форма сразу после первого экрана",
            edit: { op: "reorder", route: "/", order: ["hero", "form", "services"] },
          },
        ]),
        critique(3, [], "production"),
      ]),
    );
    const started = Date.now();
    const r = await runCritic({ ...ctx, files, site, route: fx.route } as typeof ctx, {
      inspect: criticInspector({ browser }),
      patterns: library,
      registry,
    });
    const ms = Date.now() - started;
    expect(r.status).toBe("done");
    expect(r.fixes).toEqual([
      expect.stringMatching(/^\/#services: вариант services-wide → services-\S+ \(L11\)$/),
    ]);
    expect(r.before.penalty).toBeGreaterThan(0);
    expect(r.after.penalty).toBe(0);
    expect(r.stop).toBe("pass");
    expect(r.cycles.map((c) => `${c.n}:${c.tier}:${c.model}`)).toEqual(["1:T0:kimi-k2.6", "2:T0:kimi-k2.6"]);
    expect(r.cycles[0]?.applied).toEqual(["/: порядок секций hero → form → services"]);
    expect(r.rolledBack).toEqual([]);
    expect(r.spentRub).toBeLessThanOrEqual(40);
    // Real screenshots went to the model: two images per call (CRITIC_MAX_IMAGES).
    for (const c of fx.calls) {
      const user = c.messages.find((m) => m.role === "user");
      expect(user && "attachments" in user ? user.attachments?.length : 0).toBe(2);
    }
    // The result builds and the site model has the changes.
    const out = new Map(files);
    for (const [p, v] of r.files) v === null ? out.delete(p) : out.set(p, v);
    expect(readSite(out)?.pages[0]?.sections.map((s) => s.id)).toEqual([
      "header",
      "hero",
      "form",
      "services",
      "footer",
    ]);
    expect(out.has("ui/patterns/services-wide.tsx")).toBe(false);
    const built = await buildSystem({ spec: ctx.spec, files: out, env: "prod" });
    expect(built.ok, JSON.stringify(built.errors)).toBe(true);
    // The stage stays within its time (D77 (10): the critic's ETA is 2 min).
    expect(ms).toBeLessThan(240_000);
  }, 300_000);

  test("platformCritic is a stage hook: files layer and notes", async () => {
    const fx = fixtureRoute(critiqueLines(firstPrompt(ctx), [critique(3, [], "production")]));
    const out = await platformCritic(browser, { registry, verify: null })({ ...ctx, route: fx.route });
    expect(out.status).toBe("done");
    expect(out.files?.size ?? 0).toBe(0);
    expect(out.notes?.[0]).toMatch(
      /^Посмотрел сайт на телефоне, планшете и компьютере глазами дизайнера: 1 круг, оценка 75 из 100\.$/,
    );
    expect(out.note).toContain("стоп pass");
  }, 120_000);
});

/** What a page of the inspector showed when it was done with it (after the checks and the shots). */
interface SeenPage {
  path: string;
  width: number;
  text: string;
  images: { src: string; loaded: boolean; hero: boolean }[];
}

/**
 * The process Chromium whose pages of the inspector report what they show right before the inspector closes them; `probe`
 * runs in the first page of the site (same origin: its requests go through the inspector's routes).
 */
function watched(seen: SeenPage[], probe?: (page: Page) => Promise<void>): GoalBrowserProvider {
  let probed = false;
  const report = async (page: Page) => {
    const url = new URL(page.url());
    if (url.origin !== CRITIC_ORIGIN) return;
    const shown = await page.evaluate(() => ({
      text: document.body.innerText,
      images: [...document.images].map((i) => ({
        src: i.currentSrc,
        loaded: i.complete && i.naturalWidth > 0,
        hero: !!i.closest("#hero"),
      })),
    }));
    seen.push({ path: url.pathname, width: page.viewportSize()?.width ?? 0, ...shown });
    if (probe && !probed) {
      probed = true;
      await probe(page);
    }
  };
  return {
    available: () => browser.available(),
    close: async () => {},
    async acquire(signal) {
      const lease = await browser.acquire(signal);
      if (!lease) return null;
      const real = lease.browser;
      const newContext: typeof real.newContext = async (...args) => {
        const context = await real.newContext(...args);
        context.on("page", (page) => {
          const close = page.close.bind(page);
          page.close = async (o) => {
            await report(page);
            return close(o);
          };
        });
        return context;
      };
      const proxied = new Proxy(real, {
        get(t, k) {
          if (k === "newContext") return newContext;
          const v = Reflect.get(t, k);
          return typeof v === "function" ? v.bind(t) : v;
        },
      });
      return { browser: proxied, release: () => lease.release() };
    },
  };
}

/** GET (or another method) of the inspector's routes from a page of the site: status and JSON body. */
const call = (page: Page, path: string, method = "GET") =>
  page.evaluate(
    async ({ path, method }) => {
      const r = await fetch(path, { method, ...(method === "GET" ? {} : { body: "{}" }) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    { path, method },
  );

/** A solid-colour PNG (the stock photo the test puts into the library). */
function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const row = Buffer.alloc(width * 3 + 1);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const chunk = (type: string, data: Uint8Array) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

/** Share of the pixels of a JPEG shot close to a colour (decoded in the browser). */
async function colourShare(jpeg: string, rgb: readonly [number, number, number]): Promise<number> {
  const lease = await browser.acquire();
  if (!lease) throw new Error("no browser");
  const context = await lease.browser.newContext();
  try {
    const page = await context.newPage();
    return await page.evaluate(
      async ({ b64, rgb }) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4)
          if (
            Math.abs((d[i] as number) - rgb[0]) < 40 &&
            Math.abs((d[i + 1] as number) - rgb[1]) < 40 &&
            Math.abs((d[i + 2] as number) - rgb[2]) < 40
          )
            n++;
        return n / (d.length / 4);
      },
      { b64: jpeg, rgb },
    );
  } finally {
    await context.close();
    lease.release();
  }
}

const DESKTOP = CRITIC_VIEWPORTS.filter((v) => v.width === 1440 && v.scheme === "light");

describe.skipIf(!hasChromium)("V3-40 the critic sees the visitor's site", () => {
  test("the draft's demo rows: catalog, blog and shop filled with the brief's names, private entities empty", async () => {
    // Karelia: a catalog of tours (service, active only), a blog (published articles only), leads (create only).
    const k = await briefSite("v3-04-karelia-tours", KARELIA_TOURS);
    const kSpec = withSitePages(k.spec, k.site);
    const kRows = draftDemoRows(
      kSpec,
      "critic-karelia",
      seedHintsFromBrief(kSpec, k.ctx.brief, evalRequest("v3-04-karelia-tours")),
    );
    const tours = (kRows.service ?? []).map((r) => r.name as string);
    expect(tours).toEqual(["Сплавы", "Пешие маршруты", "Зимние поездки на снегоходах"]);
    const articles = kRows.article ?? [];
    const published = articles.filter((a) => a.status === "published").map((a) => a.title as string);
    const drafts = articles.filter((a) => a.status !== "published").map((a) => a.title as string);
    expect(published.length).toBeGreaterThan(0);
    expect(drafts.length).toBeGreaterThan(0);
    const lead = kRows.lead?.[0];
    expect(lead).toBeDefined();
    const second = kRows.service?.[1] as Record<string, unknown>;
    const seen: SeenPage[] = [];
    const api: Record<string, { status: number; body: Record<string, unknown> }> = {};
    const lines: Record<string, unknown>[] = [];
    const r = await criticInspector({
      browser: watched(seen, async (page) => {
        for (const path of [
          "/api/data/lead",
          `/api/data/lead/${lead?.id}`,
          "/api/data/service?filter[active]=true&sort=-sort_order&page=1&limit=2",
          `/api/data/service?filter[id]=${second.id}&limit=1`,
          `/api/data/service/${second.id}`,
          "/api/data/article?limit=50",
          "/api/data/article?filter[status]=draft",
        ])
          api[path] = await call(page, path);
        api["POST /api/data/service"] = await call(page, "/api/data/service", "POST");
      }),
      data: () => kRows,
      log: (msg, f) => lines.push({ msg, ...f }),
    })({
      spec: kSpec,
      files: k.files,
      routes: ["/", "/services", "/blog"],
      viewports: DESKTOP,
      shots: [],
      fonts: [k.ctx.design.fonts.display.family, k.ctx.design.fonts.text.family],
    });
    expect(r.ok, r.error).toBe(true);
    const text = (path: string) => seen.find((p) => p.path === path)?.text ?? "";
    for (const name of tours) expect(text("/services")).toContain(name);
    for (const title of published) expect(text("/blog")).toContain(title);
    for (const title of drafts) expect(text("/blog")).not.toContain(title);
    // The data API as the runtime answers the anonymous visitor.
    expect(api["/api/data/lead"]?.body).toMatchObject({ items: [], total: 0, hasMore: false });
    expect(api[`/api/data/lead/${lead?.id}`]?.status).toBe(404);
    const page = api["/api/data/service?filter[active]=true&sort=-sort_order&page=1&limit=2"]?.body;
    expect(page).toMatchObject({ page: 1, limit: 2, total: 3, hasMore: true });
    const names = (body: Record<string, unknown> | undefined, field: string) =>
      ((body?.items ?? []) as Record<string, unknown>[]).map((x) => x[field]);
    expect(names(page, "name")).toEqual(["Зимние поездки на снегоходах", "Пешие маршруты"]);
    expect(api[`/api/data/service?filter[id]=${second.id}&limit=1`]?.body).toMatchObject({
      total: 1,
      items: [{ id: second.id, name: "Пешие маршруты" }],
    });
    expect(api[`/api/data/service/${second.id}`]?.body).toMatchObject({
      item: { id: second.id, name: "Пешие маршруты", created_by: null },
    });
    // The runtime's order (created_at desc, then id): the seed writes them in one transaction, so by id here.
    expect(names(api["/api/data/article?limit=50"]?.body, "title").sort()).toEqual([...published].sort());
    expect(api["/api/data/article?filter[status]=draft"]?.body).toMatchObject({ items: [], total: 0 });
    expect(api["POST /api/data/service"]?.status).toBe(403);
    expect(lines.find((l) => l.msg === "critic_inspection")?.dataRows).toBeGreaterThan(0);

    // Ceramics: the shop's products (and a product's own page) by the brief's names; orders stay empty.
    const c = await briefSite("v3-05-ceramics-shop", CERAMICS_SHOP);
    const cSpec = withSitePages(c.spec, c.site);
    const cRows = draftDemoRows(
      cSpec,
      "critic-ceramics",
      seedHintsFromBrief(cSpec, c.ctx.brief, evalRequest("v3-05-ceramics-shop")),
    );
    const products = (cRows.product ?? []).map((r) => r.name as string);
    expect(products).toEqual(["Кружки", "Тарелки", "Вазы ручной работы"]);
    expect(cRows.shop_order?.length).toBeGreaterThan(0);
    const one = cRows.product?.[1] as Record<string, unknown>;
    const shop: SeenPage[] = [];
    const orders: Record<string, { status: number; body: Record<string, unknown> }> = {};
    const rc = await criticInspector({
      browser: watched(shop, async (p) => {
        orders.list = await call(p, "/api/data/shop_order");
      }),
      data: async () => cRows,
    })({
      spec: cSpec,
      files: c.files,
      routes: ["/shop", `/shop/${one.id}`],
      viewports: DESKTOP,
      shots: [],
      fonts: [c.ctx.design.fonts.display.family, c.ctx.design.fonts.text.family],
    });
    expect(rc.ok, rc.error).toBe(true);
    for (const name of products) expect(shop.find((p) => p.path === "/shop")?.text).toContain(name);
    expect(shop.find((p) => p.path === `/shop/${one.id}`)?.text).toContain("Тарелки");
    expect(orders.list?.body).toMatchObject({ items: [], total: 0 });
  }, 180_000);

  test("the library photo of the hero is loaded in the shots although the storage answers late", async () => {
    // A real library copy (the runtime's image pipeline: WebP 480/960/1600) of a photo of one bright colour.
    const colour = [214, 40, 180] as const;
    const storage = new MemoryFileStorage();
    const copy = await storeLibraryPhoto(storage, solidPng(1200, 800, colour), {
      source: "pexels:v3-40-critic",
    });
    // The clinic's plan photos are this library copy.
    const files = new Map(
      [...ctx.files].map(([p, v]) => [p, v.replace(/0000000\d-0000-4000-8000-00000000000\d/g, copy.id)]),
    );
    const library = criticLibraryPhotos(storage);
    // The shared storage of the pilot (S3: head + get) answers after the page has rendered.
    const late: typeof library = async (path) => {
      await new Promise((r) => setTimeout(r, 400));
      return library(path);
    };
    const seen: SeenPage[] = [];
    const lines: Record<string, unknown>[] = [];
    const r = await criticInspector({
      browser: watched(seen),
      photo: late,
      log: (msg, f) => lines.push({ msg, ...f }),
    })({
      spec: ctx.spec,
      files,
      routes: ["/"],
      viewports: CRITIC_VIEWPORTS,
      shots: shotPlan(ctx.site),
      fonts,
    });
    expect(r.ok, r.error).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.stubPhotos).toBe(false);
    const line = lines.find((l) => l.msg === "critic_inspection");
    expect(line?.photosLibrary).toBeGreaterThan(0);
    expect(line?.photosStub).toBe(0);
    // Every page at every viewport: the hero's photo is the library's WebP and has loaded.
    expect(seen.map((p) => `${p.path}@${p.width}`)).toEqual(["/@390", "/@768", "/@1440", "/@390"]);
    for (const p of seen) {
      const hero = p.images.filter((i) => i.hero);
      expect(hero.length).toBeGreaterThan(0);
      for (const i of hero) {
        expect(i.src).toMatch(new RegExp(`^${CRITIC_ORIGIN}/_wizard/photos/${copy.id}/(480|960|1600)$`));
        expect(i.loaded).toBe(true);
      }
    }
    // The screenshots the model gets show the photo, not the grey frame of a picture still loading.
    const first = r.shots.find((s) => s.kind === "screen");
    expect(first).toBeDefined();
    expect(await colourShare(first?.data ?? "", colour)).toBeGreaterThan(0.15);
    const page = r.shots.find((s) => s.kind === "page");
    expect(await colourShare(page?.data ?? "", colour)).toBeGreaterThan(0.05);
  }, 180_000);
});
