// V3-24: the page composer with «Контент и блог» (builder-v3.md C6 «skeleton»; the composer additions of V3-24) — the
// list of articles with the rubric links, the pages of an entry and of a rubric on routes with :slug (bound to the
// module's entities by its screens, CONTENT_SCREENS), the list of the site's pages; menus and the footer without entry
// pages; ui/seo.json with the entry sources the runtime reads (sitemap, the head of an entry page); the page linter
// over the rubric's heading level; the composed system passes G0 (imports, types, build).
import { runG0 } from "@wizard/gates";
import { CONTENT_ROUTES } from "@wizard/modules";
import { PATTERNS } from "@wizard/ui-kit/v3/patterns";
import { describe, expect, test } from "vitest";
import {
  composeSite,
  createPageComposer,
  isParamRoute,
  lintErrors,
  lintPage,
  lintSitePage,
  plannedPages,
  readSite,
  SEO_JSON,
  type SiteModel,
  seoContent,
  withSitePages,
} from "../src/builder/v3/compose/index.js";
import type { V3BuildContext, V3ComposeResult } from "../src/builder/v3/contract.js";
import { contentContext } from "./v3-content-fixtures.js";

function apply(files: ReadonlyMap<string, string>, out: V3ComposeResult): Map<string, string> {
  const next = new Map(files);
  for (const [p, v] of out.files) {
    if (v === null) next.delete(p);
    else next.set(p, v);
  }
  return next;
}

async function skeleton(ctx: V3BuildContext) {
  const out = await createPageComposer().skeleton(ctx);
  const files = apply(ctx.files, out);
  const site = readSite(files) as SiteModel;
  return { out, files, site, spec: withSitePages(ctx.spec, site) };
}

const page = (site: SiteModel, route: string) => {
  const p = site.pages.find((x) => x.route === route);
  if (!p) throw new Error(`no page ${route}`);
  return p;
};
const section = (site: SiteModel, route: string, type: string) =>
  page(site, route).sections.find((s) => s.type === type);
const libraryOf = (id: string) => PATTERNS.find((p) => p.id === id);

describe("pages of «Контент и блог»", () => {
  test("the public screens become the list, the entry and the rubric pages; entry pages after the lists", () => {
    const ctx = contentContext();
    const planned = plannedPages(ctx.spec, ctx.publicFront);
    expect(planned.map((p) => [p.route, p.kind, p.screen])).toEqual([
      ["/", "home", "home"],
      ["/services", "catalog", "services"],
      ["/blog", "content", "blog"],
      ["/pages", "content", "pages"],
      ["/blog/:slug", "entry", "article"],
      ["/blog/rubric/:slug", "rubric", "rubric"],
      ["/pages/:slug", "entry", "site_page"],
      ["/photos", "credits", "credits"],
    ]);
  });

  test("each page binds the entity of its screen: rubric list on /blog, article and rubric pages, the pages list", () => {
    const { site } = composeSite(contentContext());
    const blog = section(site, "/blog", "rubric");
    expect(libraryOf(blog?.pattern ?? "")?.sectionType).toBe("rubric");
    expect(blog?.props).toMatchObject({
      entity: "article",
      path: "/blog/",
      rubrics: { path: "/blog/rubric/" },
      level: 2,
      all: { label: "Все", href: "/blog" },
    });
    expect(section(site, "/blog", "blog")).toBeUndefined();
    expect(page(site, "/blog").sections.map((s) => s.type)).toEqual([
      "header",
      "hero",
      "rubric",
      "cta",
      "footer",
    ]);

    const article = section(site, "/blog/:slug", "article");
    expect(libraryOf(article?.pattern ?? "")?.needs).toBe("content");
    expect(article?.props).toEqual({
      entity: "article",
      path: "/blog/",
      rubric: { path: "/blog/rubric/" },
      back: { label: "Блог", href: "/blog" },
      missing: "Возможно, запись убрали или адрес набран с ошибкой.",
    });
    // The entry is the heading of its page: no first screen above it.
    expect(page(site, "/blog/:slug").sections.map((s) => s.type)).toEqual([
      "header",
      "article",
      "cta",
      "footer",
    ]);

    expect(section(site, "/blog/rubric/:slug", "rubric")?.props).toMatchObject({ level: 1, path: "/blog/" });
    expect(section(site, "/pages", "blog")?.props).toMatchObject({
      entity: "site_page",
      fields: { date: "updated_at" },
      path: "/pages/",
    });
    expect(section(site, "/pages/:slug", "article")?.props).toMatchObject({
      entity: "site_page",
      path: "/pages/",
      back: { label: "Информация", href: "/pages" },
    });
    expect(section(site, "/pages/:slug", "article")?.props).not.toHaveProperty("rubric");
  });

  test("menus and the footer list the pages without the entry pages; the owner's name of the blog is the title", () => {
    const { site } = composeSite(contentContext({ params: { blog_title: "Новости" } }));
    const home = page(site, "/");
    const header = home.sections.find((s) => s.type === "header")?.props as
      | { nav: { label: string; href: string }[] }
      | undefined;
    const nav = header?.nav;
    expect(nav).toEqual([
      { label: "Главная", href: "/" },
      { label: "Каталог и цены", href: "/services" },
      { label: "Новости", href: "/blog" },
      { label: "Информация", href: "/pages" },
    ]);
    const footer = home.sections.find((s) => s.type === "footer")?.props as {
      columns: { links: { href: string }[] }[];
    };
    const links = footer.columns.flatMap((c) => c.links.map((l) => l.href));
    expect(links.some(isParamRoute)).toBe(false);
    expect(links).toEqual(expect.arrayContaining(["/blog", "/pages"]));
    for (const p of site.pages)
      expect(p.header, p.route).toBe(!isParamRoute(p.route) && p.kind !== "credits");
    expect(page(site, "/blog").title).toBe("Новости");
    expect(page(site, "/blog").seo.title).toBe("Новости — Белая линия");
  });

  test("without rubrics and pages: the list of articles is a blog pattern, no rubric or page routes", () => {
    const { site } = composeSite(
      contentContext({ params: { with_rubrics: false, with_pages: false, blog_title: "Новости" } }),
    );
    expect(site.pages.map((p) => p.route)).toEqual(["/", "/services", "/blog", "/blog/:slug", "/photos"]);
    const list = section(site, "/blog", "blog");
    expect(libraryOf(list?.pattern ?? "")?.sectionType).toBe("blog");
    expect(list?.props).toMatchObject({
      entity: "article",
      path: "/blog/",
      fields: { date: "published_at" },
    });
    expect(section(site, "/blog/:slug", "article")?.props).not.toHaveProperty("rubric");
  });

  test("every page passes the page linter; the rubric's dynamic heading counts at its level", () => {
    const r = composeSite(contentContext());
    for (const p of r.site.pages) expect(lintErrors(lintSitePage(r.site, p, r.facts)), p.route).toEqual([]);
    const rubric = section(r.site, "/blog/rubric/:slug", "rubric");
    const meta = libraryOf(rubric?.pattern ?? "");
    const hero = PATTERNS.find((p) => p.id === "hero-centered");
    if (!meta || !hero || !rubric) throw new Error("patterns");
    // Level 1 is the page's h1: a first screen above it makes two.
    const codes = (level: 1 | 2) =>
      lintErrors(
        lintPage({
          sections: [
            { id: "hero", type: "hero", pattern: hero.id, source: hero.source, props: hero.example },
            {
              id: "rubric",
              type: "rubric",
              pattern: meta.id,
              source: meta.source,
              props: { ...rubric.props, level },
            },
          ],
        }),
      ).map((i) => i.code);
    expect(codes(1)).toContain("multiple-h1");
    expect(codes(2)).toEqual([]);
  });

  test("ui/seo.json: per-route tags and the entry sources of the article, rubric and page routes", async () => {
    const ctx = contentContext();
    const { files, site, spec } = await skeleton(ctx);
    const seo = JSON.parse(files.get(SEO_JSON) as string) as {
      site: string;
      pages: Record<string, { title: string }>;
      content: unknown[];
    };
    expect(seo.site).toBe("Белая линия");
    expect(Object.keys(seo.pages)).toEqual(site.pages.map((p) => p.route));
    expect(seo.content).toEqual(seoContent(site));
    expect(seo.content).toEqual([
      {
        route: CONTENT_ROUTES.article,
        entity: "article",
        slug: "slug",
        title: "title",
        description: ["seo_description", "excerpt"],
        seoTitle: "seo_title",
        image: "cover",
      },
      {
        route: CONTENT_ROUTES.rubric,
        entity: "rubric",
        slug: "slug",
        title: "name",
        description: ["description"],
      },
      {
        route: CONTENT_ROUTES.page,
        entity: "site_page",
        slug: "slug",
        title: "title",
        description: ["seo_description", "excerpt"],
        seoTitle: "seo_title",
        image: "cover",
      },
    ]);
    // The spec gets the entry pages too (the runtime serves them, the G1 checks open them).
    expect(spec.pages?.filter((p) => isParamRoute(p.route)).map((p) => p.route)).toEqual([
      "/blog/:slug",
      "/blog/rubric/:slug",
      "/pages/:slug",
    ]);
  });

  test("G0: imports, types and the build of the composed content site pass (draft and prod)", async () => {
    const { files, spec } = await skeleton(contentContext());
    for (const env of ["draft", "prod"] as const) {
      const report = await runG0(
        { spec, prevSpec: null, specVersion: 0, files, env, systemKey: "v3_content", db: undefined as never },
        { only: ["G0-IMP-01", "G0-SEC-01", "G0-TS-01", "G0-BUILD-01", "G0-SPEC-03", "G0-SPEC-04"] },
      );
      expect(
        report.checks.filter((c) => c.status === "fail" || c.status === "error").map((c) => c.message_ru),
        env,
      ).toEqual([]);
    }
  }, 120_000);
});
