// V3-24 acceptance in Chromium: a multi-page site of the v3 front with «Контент и блог» — the dental clinic of the
// V3-12 fixtures with articles, rubrics and pages of the site, compiled in backend mode and composed by the page
// composer from the library (article-*, rubric-*, blog-* patterns, one header and footer with the page list) — passes
// G0 and G1 with the module's goal scenarios on the v3 pages (390 px light, 1280 px dark): the owner publishes an
// article in the cabinet → it is in the list, has its own address, the sitemap lists it, a draft stays hidden. A site
// walk of a visitor through the header menu, an article, its rubric and a page of the site checks every page: no
// errors, no sideways scroll, AA contrast, named controls, one h1 and heading order, touch targets on the phone; the
// runtime gives crawlers the head of each page. Screenshots go to test/artifacts/content-v3-*.png.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import type { AppSpec } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import {
  type GateContext,
  type GateReport,
  type GoalProgram,
  type GoalRun,
  runG0,
  runG1,
} from "@wizard/gates";
import { closeExecutors, createRuntimeApp, MemoryRegistry, type RuntimeApp } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createPageComposer,
  readSite,
  type SiteModel,
  withSitePages,
} from "../../agents/src/builder/v3/compose/index.js";
import { contentContext } from "../../agents/test/v3-content-fixtures.js";
import { V3_CHECKS_SCRIPT, type V3CheckResult } from "../../build/test/v3-checks.js";
import { CATALOG, compilePlan } from "../src/index.js";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const DATABASE_URL =
  process.env.WIZARD_DB_URL ?? process.env.DATABASE_URL ?? "postgres://wizard@localhost:5433/wizard";
const ARTIFACTS = join(dirname(fileURLToPath(import.meta.url)), "artifacts");
const keyPrefix = `v324${randomBytes(3).toString("hex")}`;
const SITE_WALK = "V324-site";

let db: postgres.Sql;
let rt: RuntimeApp;
let role: string;
let root: string;
let browser: Browser;
let spec: AppSpec;
let files: Map<string, string>;
let site: SiteModel;
let scenarios: { id: string; module: string; goal: string; title: string; steps: never[]; expect: never[] }[];

beforeAll(async () => {
  const ctx = contentContext({ systemId: "sys-v324" });
  const skeleton = await createPageComposer().skeleton(ctx);
  files = new Map(ctx.files);
  for (const [p, v] of skeleton.files) {
    if (v === null) files.delete(p);
    else files.set(p, v);
  }
  site = readSite(files) as SiteModel;
  spec = withSitePages(ctx.spec, site);
  const compiled = compilePlan(ctx.plan, CATALOG, { appName: "Белая линия", front: "backend" });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  scenarios = compiled.scenarios.filter((s) => s.module === "content") as unknown as typeof scenarios;
  if (!hasChromium) return;
  mkdirSync(ARTIFACTS, { recursive: true });
  db = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
  role = `wz_v324_rt_${randomBytes(4).toString("hex")}`;
  await db.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  root = mkdtempSync(join(tmpdir(), "wz-v324-"));
  rt = createRuntimeApp({
    db,
    registry: new MemoryRegistry(),
    dbRole: role,
    artifactsRoot: join(root, "artifacts"),
    connectors: "outbox",
    secrets: () => staticSecretReader({ [QR_SECRET]: serializeQrKeyring(newQrKeyring()) }),
    env: {
      authModeDev: true,
      devLogin: false,
      unsafeLocalExec: true,
      publicScheme: "http",
      platformOrigin: "http://localhost:5173",
      systemsDomain: "localhost",
      nodeEnv: "test",
      kubernetes: false,
    },
  });
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  if (!hasChromium) return;
  await browser?.close();
  await closeExecutors();
  await db?.unsafe(`DROP OWNED BY ${role}`).catch(() => {});
  await db?.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await db?.end();
  if (root) rmSync(root, { recursive: true, force: true });
});

const failed = (r: GateReport) =>
  r.checks
    .filter((c) => c.severity === "blocker" && (c.status === "fail" || c.status === "error"))
    .map((c) => `${c.id}: ${c.message_ru} ${c.evidence ?? ""}`);

/** A record through the data API as the current actor; its id. */
async function create(t: GoalRun, entity: string, data: Record<string, unknown>): Promise<string> {
  const r = await t.api("POST", `/api/data/${entity}`, data);
  const id = (r.body as { item?: { id?: string } } | null)?.item?.id;
  if (r.status >= 300 || !id) t.fail(`не создалась запись «${entity}»`, JSON.stringify(r.body).slice(0, 300));
  return id;
}

/** The v3 checks over the whole page: the app root as one «hero-…» root (exactly one h1). */
async function pageChecks(t: GoalRun): Promise<V3CheckResult> {
  await t.page.evaluate(() => document.getElementById("root")?.setAttribute("data-preview", "hero-page"));
  // The runtime CSP refuses inline scripts: the checks go in through the debugger protocol.
  await t.page.evaluate(V3_CHECKS_SCRIPT);
  return t.page.evaluate(
    (touch) =>
      (window as unknown as { __v3: { run(o: { touch: boolean }): V3CheckResult } }).__v3.run({ touch }),
    t.viewport.width <= 390,
  );
}

/**
 * The visitor's walk over the site (a program of G1 over the composed v3 pages): the owner's content through the data
 * API, then the header menu → the list → an article → its rubric → the pages of the site, each page checked and shot;
 * the crawler's view from the runtime (sitemap, robots, the head of an article).
 */
function siteWalk(problems: string[]): GoalProgram {
  return async (t) => {
    const cell = `${t.viewport.width}-${t.scheme}`;
    const tag = randomBytes(3).toString("hex");
    const today = t.now.toISOString().slice(0, 10);
    t.step("Владелец публикует рубрику, две статьи и страницу сайта");
    await t.as("owner");
    const rubric = await create(t, "rubric", {
      name: "Профилактика",
      slug: `profilaktika-${tag}`,
      description: "Как сохранить зубы здоровыми между приёмами.",
      sort_order: 1,
    });
    const pageSlug = `oplata-${tag}`;
    await create(t, "site_page", {
      title: "Оплата и документы",
      slug: pageSlug,
      status: "published",
      excerpt: "Как оплатить лечение и получить документы для налогового вычета.",
      body: "Оплатить приём можно картой или наличными в клинике.\n\n## Налоговый вычет\n\nСправку для вычета выдаём по запросу.",
    });
    const slug = `kak-chistit-${tag}`;
    const title = "Как правильно чистить зубы";
    await create(t, "article", {
      title,
      slug,
      status: "published",
      published_at: today,
      rubric,
      excerpt: "Три правила, которые советуют врачи клиники.",
      body: [
        "Чистите зубы **дважды в день** по две минуты.",
        "",
        "## Что понадобится",
        "",
        "- щётка средней жёсткости",
        "- паста с фтором",
        "- зубная нить",
        "",
        "> Нить очищает то, до чего щётка не достаёт.",
        "",
        `Остальное — на странице [оплаты](/pages/${pageSlug}).`,
      ].join("\n"),
      seo_title: "Как чистить зубы — советы врачей",
      seo_description: "Три правила чистки зубов от врачей клиники «Белая линия».",
    });
    await create(t, "article", {
      title: "Черновик, которого не видно",
      slug: `draft-${tag}`,
      status: "draft",
      published_at: today,
    });

    const check = async (name: string, ready: string) => {
      await t.page
        .getByText(ready, { exact: false })
        .first()
        .waitFor({ state: "visible", timeout: 8_000 })
        .catch(() => problems.push(`${cell} ${name}: не дождались «${ready}»`));
      await t.page.evaluate(() => document.fonts.ready);
      const r = await pageChecks(t);
      if (r.scroll) problems.push(`${cell} ${name}: прокрутка вбок ${r.scroll}px`);
      for (const [id, list] of Object.entries(r.result))
        problems.push(`${cell} ${name} ${id}: ${list.join("; ")}`);
      writeFileSync(
        join(ARTIFACTS, `content-v3-${name}-${cell}.png`),
        await t.page.screenshot({ fullPage: true }),
      );
    };
    const go = async (link: string, path: string) => {
      const a = t.page.getByRole("link", { name: link, exact: true }).first();
      await a.waitFor({ state: "visible", timeout: 8_000 }).catch(() => {});
      if ((await a.count()) === 0) return t.fail(`нет ссылки «${link}»`);
      await a.click();
      await t.page
        .waitForURL((u) => decodeURIComponent(u.pathname) === path, { timeout: 8_000 })
        .catch(() => {
          t.fail(`ссылка «${link}» ведёт не на ${path}`, new URL(t.page.url()).pathname);
        });
      await t.settle();
    };

    t.step("Посетитель открывает главную и переходит в блог через меню");
    await t.as("visitor");
    await t.open("/");
    if (t.viewport.width <= 390) {
      const menu = t.page.locator("header button[aria-expanded]").first();
      if ((await menu.count()) > 0) await menu.click();
    }
    await go("Блог", "/blog");
    await check("blog", title);
    if ((await t.page.locator("body").innerText()).includes("Черновик, которого не видно"))
      problems.push(`${cell} blog: черновик виден в списке`);

    t.step("Переходит к статье, затем к её рубрике");
    await go(title, `/blog/${slug}`);
    await check("article", "Что понадобится");
    if (!(await t.page.title()).includes("Как чистить зубы")) problems.push(`${cell} article: title вкладки`);
    if ((await t.page.locator("strong", { hasText: "дважды в день" }).count()) !== 1)
      problems.push(`${cell} article: жирный текст не размечен`);
    if ((await t.page.locator("main li", { hasText: "паста с фтором" }).count()) !== 1)
      problems.push(`${cell} article: список не размечен`);
    await go("Профилактика", `/blog/rubric/profilaktika-${tag}`);
    await check("rubric", title);
    const h1 = (await t.page.locator("h1").first().innerText()).trim();
    if (h1 !== "Профилактика") problems.push(`${cell} rubric: h1 «${h1}»`);

    t.step("Открывает страницы сайта через меню и страницу «Оплата и документы»");
    if (t.viewport.width <= 390) {
      const menu = t.page.locator("header button[aria-expanded]").first();
      if ((await menu.count()) > 0) await menu.click();
    }
    await go("Информация", "/pages");
    await check("pages", "Оплата и документы");
    await go("Оплата и документы", `/pages/${pageSlug}`);
    await check("page", "Налоговый вычет");

    t.step("Поисковый робот читает карту сайта, robots.txt и страницу статьи");
    const fetchText = (p: string) =>
      t.page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: "omit" });
        return { status: r.status, text: await r.text() };
      }, p);
    const map = await fetchText("/sitemap.xml");
    for (const p of [
      "/",
      "/blog",
      "/pages",
      `/blog/${slug}`,
      `/blog/rubric/profilaktika-${tag}`,
      `/pages/${pageSlug}`,
    ])
      if (!map.text.includes(`${p}</loc>`)) problems.push(`${cell} sitemap: нет ${p}`);
    if (map.text.includes(`draft-${tag}`)) problems.push(`${cell} sitemap: черновик в карте сайта`);
    const robots = await fetchText("/robots.txt");
    if (!robots.text.startsWith("User-agent: *\nDisallow: /"))
      problems.push(`${cell} robots: черновик открыт роботам`);
    const doc = await fetchText(`/blog/${slug}`);
    for (const s of [
      "<title>Как чистить зубы — советы врачей</title>",
      '<meta name="description" content="Три правила чистки зубов от врачей клиники «Белая линия».">',
      '<meta property="og:type" content="article">',
      `/blog/${slug}">`,
    ])
      if (!doc.text.includes(s)) problems.push(`${cell} head статьи: нет ${s}`);
    const services = await fetchText("/services");
    const seo = site.pages.find((p) => p.route === "/services")?.seo;
    if (seo && !services.text.includes(`<title>${seo.title}</title>`))
      problems.push(`${cell} head /services: title`);
  };
}

describe.skipIf(!hasChromium)("V3-24: multi-page v3 site with «Контент и блог» in Chromium", () => {
  test("the composed site: lists, entry and rubric pages from the library, menus without entry pages", () => {
    expect(site.pages.map((p) => [p.route, p.kind])).toEqual([
      ["/", "home"],
      ["/services", "catalog"],
      ["/blog", "content"],
      ["/pages", "content"],
      ["/blog/:slug", "entry"],
      ["/blog/rubric/:slug", "rubric"],
      ["/pages/:slug", "entry"],
      ["/photos", "credits"],
    ]);
    const header = site.pages[0]?.sections.find((s) => s.type === "header")?.props as {
      nav: { href: string }[];
    };
    // V3-18: the lists of «Контент и блог» start empty — the footer links them, the header does not.
    expect(header.nav.map((l) => l.href)).toEqual(["/", "/services"]);
    const footer = site.pages[0]?.sections.find((s) => s.type === "footer")?.props as {
      columns: { links: { href: string }[] }[];
    };
    expect(footer.columns.flatMap((c) => c.links.map((l) => l.href))).toEqual(
      expect.arrayContaining(["/blog", "/pages"]),
    );
    expect(spec.pages?.map((p) => p.route)).toEqual(expect.arrayContaining(["/blog/:slug", "/pages/:slug"]));
    expect(scenarios.map((s) => s.id)).toEqual([
      "GS-content-1",
      "GS-content-2",
      "GS-content-3",
      "GS-content-4",
      "GS-content-5",
    ]);
  });

  test("G0 and G1 with the goal scenarios on the v3 pages (390 light, 1280 dark) and the site walk", async () => {
    const problems: string[] = [];
    const ctx: GateContext = {
      spec,
      prevSpec: null,
      specVersion: 1,
      files,
      env: "draft",
      systemKey: `${keyPrefix}_${randomBytes(4).toString("hex")}`,
      db,
      milestone: "M1",
      runtime: rt,
      runtimeRole: role,
      browser,
      goalScenarios: [
        ...scenarios,
        {
          id: SITE_WALK,
          module: "content",
          goal: "attract",
          title: "Посетитель обходит сайт",
          steps: [],
          expect: [],
        },
      ],
    };
    expect(failed(await runG0(ctx)), "G0").toEqual([]);
    const g1 = await runG1(ctx, { goals: { programs: { [SITE_WALK]: siteWalk(problems) } } });
    expect(failed(g1), "G1").toEqual([]);
    expect(g1.checks.find((c) => c.id === "G1-RENDER-01")?.status).toBe("pass");
    for (const s of [...scenarios.map((x) => x.id), SITE_WALK])
      expect(g1.checks.find((c) => c.id === `G1-GOAL-${s}`)?.status, s).toBe("pass");
    expect(problems).toEqual([]);
  }, 900_000);
});
