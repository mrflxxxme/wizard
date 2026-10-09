// V3-12 acceptance 3 (build side): ui/seo.json of the page composer → the home page's title, description and Open
// Graph tags in index.html and the per-route tags set by the client entry; a wrong file is a build error; a system
// without it builds byte for byte as before.
import { describe, expect, test } from "vitest";
import { parseSeo, SEO_PATH, seoHeadTags, seoTitle } from "../src/index.js";
import { build, clientText, forumFiles } from "./helpers.js";

const SEO = {
  version: 1,
  site: "Белая линия",
  pages: {
    "/": {
      title: "Белая линия — лечение зубов без боли",
      description: "Стоматологическая клиника «Белая линия»: заявка на сайте, перезвоним за 15 минут.",
      image: "/_wizard/photos/00000000-0000-4000-8000-000000000000/1600",
    },
    "/services": { title: "Каталог и цены — Белая линия", description: "Услуги клиники с ценами." },
  },
};

describe("parseSeo", () => {
  test("a valid file; every wrong place is named", () => {
    const ok = parseSeo(JSON.stringify(SEO));
    expect(ok).toEqual({ ok: true, seo: { site: SEO.site, pages: SEO.pages } });
    const bad = (v: unknown) => (parseSeo(JSON.stringify(v)) as { ok: false; error: string }).error;
    expect((parseSeo("{") as { error: string }).error).toMatch(/^не JSON/);
    expect(bad({ ...SEO, site: "" })).toMatch(/^site/);
    expect(bad({ ...SEO, pages: { "/Услуги": SEO.pages["/services"] } })).toMatch(/маршрут/);
    expect(
      bad({ ...SEO, pages: { "/": { ...SEO.pages["/"], image: "https://cdn.example.com/a.jpg" } } }),
    ).toMatch(/image/);
    expect(bad({ ...SEO, pages: { "/": { ...SEO.pages["/"], title: "x".repeat(121) } } })).toMatch(/title/);
  });

  test("head tags are escaped; a route without its own SEO gets the site name", () => {
    const seo = {
      site: "«Кафе» & <бар>",
      pages: { "/": { title: 'Кафе "у дома"', description: "Меню & цены" } },
    };
    expect(seoTitle(seo)).toBe('Кафе "у дома"');
    expect(seoTitle(seo, "/menu")).toBe("«Кафе» & <бар>");
    const tags = seoHeadTags(seo).join("\n");
    expect(tags).toContain('<meta property="og:title" content="Кафе &#34;у дома&#34;">');
    expect(tags).toContain('<meta property="og:site_name" content="«Кафе» &#38; &#60;бар&#62;">');
    expect(tags).not.toContain("og:image");
  });
});

describe("buildSystem with ui/seo.json", () => {
  test("index.html carries the home page's tags; the client sets the route's tags on navigation", async () => {
    const files = forumFiles().set(SEO_PATH, JSON.stringify(SEO));
    const r = await build({ files });
    expect(r.errors).toEqual([]);
    const html = new TextDecoder().decode(r.client.get("index.html"));
    expect(html).toContain(`<title>${SEO.pages["/"].title}</title>`);
    expect(html).toContain('<meta name="description" content="Стоматологическая клиника');
    expect(html).toContain(`<meta property="og:image" content="${SEO.pages["/"].image}">`);
    expect(html).toContain('<meta property="og:locale" content="ru_RU">');
    expect(html).not.toMatch(/<script>(?!<)/);
    const js = clientText(r);
    expect(js).toContain("Каталог и цены — Белая линия");
    expect(js).toContain("og:description");
  });

  test("a wrong ui/seo.json is a build error (G0-BUILD-01) naming the file", async () => {
    const r = await build({ files: forumFiles().set(SEO_PATH, '{"site": ""}') });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([
      expect.objectContaining({
        id: "G0-BUILD-01",
        file: SEO_PATH,
        message_ru: expect.stringContaining("ui/seo.json"),
      }),
    ]);
  });

  test("without ui/seo.json the bundle is unchanged", async () => {
    const a = await build();
    const b = await build({ files: forumFiles() });
    expect(a.manifest.contentHash).toBe(b.manifest.contentHash);
    expect(clientText(a)).not.toContain("__wzSeo");
    expect(new TextDecoder().decode(a.client.get("index.html"))).not.toContain("og:title");
  });
});
