// V3-24: search engines on a system's public pages (apps/runtime/src/seo/site.ts) — /sitemap.xml lists the public
// pages and the published entries of the sources of ui/seo.json (client/assets/seo.json of the bundle) read as the
// public role, /robots.txt closes a draft and the API and cabinets of a published system, and every document gets the
// head of its route: the static tags of ui/seo.json, an entry page its own title, description, image and canonical
// address, a draft or a wrong address «Страница не найдена» with noindex. Without sources in the file they are
// inferred from the spec (the v2 pages of «Контент и блог»). Values are escaped; a broken file is ignored.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, dropSystemRoleDDL, quoteIdent } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrateSystem, schemaName } from "../src/index.js";
import { inferContentSources, parseSystemSeo, publicRoutes, withRouteHead } from "../src/seo/site.js";
import { type Harness, harness, newKey, request, seedRow } from "./helpers.js";

const STATUS = [
  { value: "draft", label: "Черновик" },
  { value: "published", label: "Опубликовано" },
];

const SPEC: AppSpec = {
  specVersion: "1",
  app: { name: "Мастерская «Глина»", locale: "ru" },
  entities: [
    {
      name: "rubric",
      label: "Рубрика",
      fields: [
        { name: "name", label: "Название", type: "string", required: true, maxLength: 80 },
        { name: "slug", label: "Адрес", type: "string", required: true, unique: true, maxLength: 80 },
        { name: "description", label: "Описание", type: "text", maxLength: 300 },
      ],
    },
    {
      name: "article",
      label: "Статья",
      fields: [
        { name: "title", label: "Заголовок", type: "string", required: true, maxLength: 140 },
        { name: "status", label: "Статус", type: "enum", required: true, default: "draft", enum: STATUS },
        { name: "slug", label: "Адрес", type: "string", required: true, unique: true, maxLength: 80 },
        { name: "rubric", label: "Рубрика", type: "ref", ref: { entity: "rubric", onDelete: "set_null" } },
        { name: "excerpt", label: "Анонс", type: "text", maxLength: 300 },
        { name: "cover", label: "Обложка", type: "image" },
        { name: "seo_title", label: "Заголовок для поисковиков", type: "string", maxLength: 70 },
        { name: "seo_description", label: "Описание для поисковиков", type: "string", maxLength: 160 },
      ],
    },
  ],
  roles: [
    { name: "guest", label: "Посетитель", access: "public" },
    { name: "owner", label: "Владелец", access: "login", loginMethods: ["email_otp"], isAdmin: true },
  ],
  permissions: [
    { role: "guest", entity: "rubric", ops: ["read"] },
    { role: "guest", entity: "article", ops: ["read"], rowFilter: { status: "published" } },
    { role: "owner", entity: "rubric", ops: ["read", "create", "update", "delete"] },
    { role: "owner", entity: "article", ops: ["read", "create", "update", "delete"] },
  ],
  pages: [
    { route: "/", title: "Главная", file: "ui/pages/site/Home.tsx", roles: ["guest", "owner"] },
    { route: "/blog", title: "Блог", file: "ui/pages/site/Blog.tsx", roles: ["guest", "owner"] },
    {
      route: "/blog/:slug",
      title: "Статья",
      file: "ui/pages/ContentArticle.tsx",
      roles: ["guest", "owner"],
    },
    {
      route: "/blog/rubric/:slug",
      title: "Рубрика",
      file: "ui/pages/site/BlogRubricBySlug.tsx",
      roles: ["guest", "owner"],
    },
    { route: "/cabinet", title: "Кабинет", file: "ui/pages/Cabinet.tsx", roles: ["owner"] },
  ],
};

/** ui/seo.json as the v3 composer writes it (V3-24 sources). */
const SEO = {
  version: 1,
  site: "Глина",
  pages: {
    "/": {
      title: "Глина — гончарная мастерская",
      description: "Занятия на круге.",
      image: "/_wizard/photos/x/1600",
    },
    "/blog": { title: "Блог — Глина", description: "Заметки мастерской." },
    "/blog/:slug": { title: "Статья — Глина", description: "Статья. Глина: мастерская." },
    "/broken": { title: "", description: "нет заголовка" },
  },
  content: [
    {
      route: "/blog/:slug",
      entity: "article",
      slug: "slug",
      title: "title",
      description: ["seo_description", "excerpt"],
      seoTitle: "seo_title",
      image: "cover",
    },
    {
      route: "/blog/rubric/:slug",
      entity: "rubric",
      slug: "slug",
      title: "name",
      description: ["description"],
    },
    { route: "/nope/:slug", entity: "missing", slug: "slug", title: "title" },
    { route: "/blog/:id", entity: "article", slug: "slug", title: "title" },
  ],
};

/** index.html of the bundle with the home page's tags (as @wizard/build writes them). */
const INDEX = [
  "<!doctype html>",
  '<html lang="ru">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>Глина — гончарная мастерская</title>",
  '<meta name="description" content="Занятия на круге.">',
  '<meta property="og:title" content="Глина — гончарная мастерская">',
  '<meta property="og:site_name" content="Глина">',
  '<script type="module" src="/assets/index-000000000000.js"></script>',
  "</head>",
  '<body><div id="root"></div></body>',
  "</html>",
  "",
].join("\n");

let h: Harness;
let root: string;
const hosts = { draft: "", prod: "" };
const schemas: string[] = [];
const get = (host: string, path: string) => h.rt.fetch(request("GET", host, path));

async function deploy(slug: string, env: "draft" | "prod", seo: unknown | null): Promise<string> {
  const key = newKey();
  const dir = join(root, key);
  mkdirSync(join(dir, "client", "assets"), { recursive: true });
  writeFileSync(join(dir, "client", "index.html"), INDEX);
  if (seo !== null) writeFileSync(join(dir, "client", "assets", "seo.json"), JSON.stringify(seo));
  schemas.push(schemaName(key, env));
  await migrateSystem(h.sql, { systemId: key, env, spec: SPEC, runtimeRole: h.role });
  await h.rt.loadSystem({ systemKey: key, env, spec: SPEC, slug, artifactDir: dir });
  return env === "prod" ? `${slug}.localhost:4100` : `${slug}--draft.localhost:4100`;
}

/** A row of an entity in a system's schema as the superuser (the content the owner would have published). */
const seed = (schema: string, entity: string, row: Record<string, unknown>) =>
  seedRow(h.sql, schema, SPEC, entity, row);

const EMPTY_ARTICLE = { rubric: null, excerpt: null, cover: null, seo_title: null, seo_description: null };

/** The cover of an article (a file id; the data API would take only an uploaded file). */
const COVER = "00000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  h = await harness();
  root = mkdtempSync(join(tmpdir(), "wz-seo-"));
  hosts.draft = await deploy("glina", "draft", SEO);
  hosts.prod = await deploy("glina", "prod", SEO);
  for (const schema of schemas) {
    const rubric = await seed(schema, "rubric", {
      name: "Глазури",
      slug: "glazuri",
      description: "Цвета & слои",
    });
    await seed(schema, "article", {
      ...EMPTY_ARTICLE,
      title: 'Как выбрать глазурь <script>alert("x")</script>',
      slug: "glazur",
      status: "published",
      rubric,
      excerpt: "Матовая или глянцевая.",
      cover: COVER,
    });
    await seed(schema, "article", {
      ...EMPTY_ARTICLE,
      title: "Сушка без трещин",
      slug: "sushka",
      status: "published",
      seo_title: "Как сушить керамику",
      seo_description: "Три правила сушки.",
    });
    await seed(schema, "article", {
      ...EMPTY_ARTICLE,
      title: "Секретный черновик",
      slug: "chernovik",
      status: "draft",
    });
    // As the data API stamps a write: the sitemap's lastmod.
    await h.sql.unsafe(`update ${quoteIdent(schema)}."article" set "updated_at" = now()`);
  }
}, 120_000);

afterAll(async () => {
  for (const s of schemas) {
    await h?.sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`);
    for (const st of dropSystemRoleDDL(s)) await h?.sql.unsafe(st);
  }
  await h?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("/sitemap.xml and /robots.txt", () => {
  test("the sitemap lists the public pages and the published entries with their dates, never drafts or cabinets", async () => {
    for (const host of [hosts.draft, hosts.prod]) {
      const res = await get(host, "/sitemap.xml");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
      const xml = await res.text();
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      // Static pages first (the policy page of the 152-ФЗ package too), then the entries of each source.
      expect(locs.slice(0, 3)).toEqual([`http://${host}/`, `http://${host}/blog`, `http://${host}/privacy`]);
      expect(locs.slice(3).sort()).toEqual([
        `http://${host}/blog/glazur`,
        `http://${host}/blog/rubric/glazuri`,
        `http://${host}/blog/sushka`,
      ]);
      expect(xml).toMatch(/<loc>[^<]+\/blog\/glazur<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
      expect(xml).not.toContain("chernovik");
      expect(xml).not.toContain("/cabinet");
    }
    expect((await get(hosts.draft, "/sitemap.xml")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await get(hosts.prod, "/sitemap.xml")).headers.get("x-robots-tag")).toBeNull();
  });

  test("robots.txt: a draft is closed to robots; a published system closes the API, sign-in and cabinets", async () => {
    expect(await (await get(hosts.draft, "/robots.txt")).text()).toBe("User-agent: *\nDisallow: /\n");
    const res = await get(hosts.prod, "/robots.txt");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe(
      [
        "User-agent: *",
        "Disallow: /_wizard/",
        "Disallow: /api/",
        "Disallow: /cabinet",
        "Disallow: /login",
        "Allow: /",
        "",
        `Sitemap: http://${hosts.prod}/sitemap.xml`,
        "",
      ].join("\n"),
    );
  });
});

describe("the head of a route for crawlers", () => {
  const doc = async (path: string, host = hosts.prod) => {
    const res = await get(host, path);
    return { status: res.status, html: await res.text(), robots: res.headers.get("x-robots-tag") };
  };

  test("a static route gets its tags of ui/seo.json and a canonical address", async () => {
    const { status, html } = await doc("/blog");
    expect(status).toBe(200);
    expect(html).toContain("<title>Блог — Глина</title>");
    expect(html).toContain('<meta name="description" content="Заметки мастерской.">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain(`<link rel="canonical" href="http://${hosts.prod}/blog">`);
    // The build's home tags are replaced, not doubled.
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html).toContain('<script type="module" src="/assets/index-000000000000.js"></script>');
    const home = await doc("/");
    expect(home.html).toContain(
      `<meta property="og:image" content="http://${hosts.prod}/_wizard/photos/x/1600">`,
    );
  });

  test("an entry page: its own title (escaped), description, image and canonical address; og:type article", async () => {
    const a = await doc("/blog/glazur");
    expect(a.html).toContain(
      "<title>Как выбрать глазурь &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; — Глина</title>",
    );
    expect(a.html).not.toContain("<script>alert");
    expect(a.html).toContain('<meta name="description" content="Матовая или глянцевая.">');
    expect(a.html).toContain('<meta property="og:type" content="article">');
    expect(a.html).toContain(
      `<meta property="og:image" content="http://${hosts.prod}/api/files/00000000-0000-4000-8000-000000000001/img/1600">`,
    );
    expect(a.html).toContain(`<link rel="canonical" href="http://${hosts.prod}/blog/glazur">`);
    const b = await doc("/blog/sushka");
    expect(b.html).toContain("<title>Как сушить керамику</title>");
    expect(b.html).toContain('<meta property="og:description" content="Три правила сушки.">');
    const r = await doc("/blog/rubric/glazuri");
    expect(r.html).toContain("<title>Глазури — Глина</title>");
    expect(r.html).toContain('<meta name="description" content="Цвета &#38; слои">');
  });

  test("a draft or a wrong address: «Страница не найдена» with noindex; the draft's title never reaches the document", async () => {
    for (const path of ["/blog/chernovik", "/blog/nope", "/blog/%E0%A4%A"]) {
      const { status, html, robots } = await doc(path);
      expect(status, path).toBe(200);
      expect(html, path).toContain("<title>Страница не найдена — Глина</title>");
      expect(html, path).toContain('<meta name="robots" content="noindex">');
      expect(robots, path).toBe("noindex, nofollow");
      expect(html).not.toContain("Секретный черновик");
    }
  });

  test("a route the file does not describe keeps the document as built; a draft host is noindex", async () => {
    const other = await doc("/somewhere");
    expect(other.html).toContain("<title>Глина — гончарная мастерская</title>");
    expect(other.html).not.toContain("canonical");
    expect(other.html).not.toContain("noindex");
    expect(other.robots).toBeNull();
    expect((await doc("/somewhere", hosts.draft)).robots).toBe("noindex, nofollow");
  });

  test("without ui/seo.json the entry sources are inferred from the spec (the v2 pages)", async () => {
    const host = await deploy("glina-v2", "prod", null);
    await seed(schemas.at(-1) as string, "article", {
      ...EMPTY_ARTICLE,
      title: "Первая заметка",
      slug: "pervaya",
      status: "published",
    });
    expect(await (await get(host, "/sitemap.xml")).text()).toContain(
      `<loc>http://${host}/blog/pervaya</loc>`,
    );
    const html = await (await get(host, "/blog/pervaya")).text();
    expect(html).toContain("<title>Первая заметка — Мастерская «Глина»</title>");
  });
});

describe("parsing and inference", () => {
  test("parseSystemSeo keeps only valid pages and sources whose entity and fields exist", () => {
    const seo = parseSystemSeo(JSON.stringify(SEO), SPEC);
    expect(seo.site).toBe("Глина");
    expect(Object.keys(seo.pages)).toEqual(["/", "/blog", "/blog/:slug"]);
    expect(seo.content.map((s) => [s.route, s.prefix, s.entity, s.image ?? null])).toEqual([
      ["/blog/:slug", "/blog/", "article", "cover"],
      ["/blog/rubric/:slug", "/blog/rubric/", "rubric", null],
    ]);
    // A text field is no image; a broken file falls back to the spec's name and inference.
    const bad = parseSystemSeo(
      JSON.stringify({ ...SEO, content: [{ ...SEO.content[0], image: "excerpt" }] }),
      SPEC,
    );
    expect(bad.content[0]?.image).toBeUndefined();
    const broken = parseSystemSeo("{", SPEC);
    expect(broken.site).toBe("Мастерская «Глина»");
    expect(broken.content.map((s) => s.route)).toEqual(["/blog/:slug", "/blog/rubric/:slug"]);
  });

  test("inference: the entity a page file is named after, else the segment before :slug", () => {
    expect(inferContentSources(SPEC).map((s) => [s.route, s.entity, s.title, s.description])).toEqual([
      ["/blog/:slug", "article", "title", ["seo_description", "excerpt"]],
      ["/blog/rubric/:slug", "rubric", "name", ["description"]],
    ]);
    const named: AppSpec = {
      ...SPEC,
      pages: [
        { route: "/blog/:slug", title: "Статья", file: "ui/pages/ContentArticle.tsx", roles: ["guest"] },
      ],
    };
    expect(inferContentSources(named).map((s) => s.entity)).toEqual(["article"]);
    expect(publicRoutes(SPEC)).toEqual(["/", "/blog"]);
  });

  test("withRouteHead replaces the build's title, description, Open Graph and canonical once", () => {
    const html = withRouteHead(
      INDEX,
      { title: "A & B", description: 'say "hi"', canonical: "http://x/a", entry: true },
      "Сайт",
    );
    expect(html).toContain("<title>A &#38; B</title>");
    expect(html).toContain('<meta name="description" content="say &#34;hi&#34;">');
    expect(html.match(/og:title/g)).toHaveLength(1);
    expect(html.match(/og:site_name/g)).toHaveLength(1);
    expect(html.indexOf("<title>")).toBeLessThan(html.indexOf("</head>"));
  });
});
