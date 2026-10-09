// @vitest-environment happy-dom
// V3-24 (builder-v3.md §3 C3, C4): the headless helpers of «Контент и блог» — richText (a markdown subset into blocks,
// never HTML; unsafe links lose their address, foreign images are text), safeHref, slugFromPath; useEntry (an entry by
// the slug of the address, a draft is not found for a visitor — the module's rowFilter) and useRubric (the posts of
// the rubric of the address, every post without one) over the memory DataSource with the runtime's permission
// semantics; the article and rubric patterns render the entry, its rubric link and the body with React elements only.
import type { AppSpec } from "@wizard/appspec";
import { act, createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { createMemoryDataSource, type MemoryDataSource } from "../src/testing/index.js";
import {
  RICH_TEXT_MAX,
  type RichBlock,
  type RichInline,
  richInline,
  richPlain,
  richText,
  safeHref,
  slugFromPath,
  useEntry,
  useRubric,
} from "../src/v3/headless/index.js";
import ArticleAside from "../src/v3/patterns/article/aside.js";
import ArticleColumn from "../src/v3/patterns/article/column.js";
import ArticleCover from "../src/v3/patterns/article/cover.js";
import ArticleEditorial from "../src/v3/patterns/article/editorial.js";
import RubricCards from "../src/v3/patterns/rubric/cards.js";
import RubricList from "../src/v3/patterns/rubric/list.js";
import RubricSplit from "../src/v3/patterns/rubric/split.js";
import { type Rendered, render } from "./helpers/dom.js";

/** The inline content of a paragraph, heading or quote block. */
const inlineOf = (b: RichBlock | undefined): RichInline[] => (b && "children" in b ? b.children : []);

describe("richText: a markdown subset into blocks", () => {
  test("paragraphs, headings (h2/h3 — the h1 is the title), lists, quotes, rules, line breaks", () => {
    const blocks = richText(
      [
        "# Заголовок первого уровня",
        "Первый абзац,",
        "вторая строка.",
        "",
        "### Подраздел",
        "- раз",
        "- два",
        "  продолжение",
        "",
        "1. первый",
        "2) второй",
        "",
        "> цитата",
        "> в две строки",
        "",
        "---",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "list",
      "list",
      "quote",
      "rule",
    ]);
    expect(blocks[0]).toEqual({
      type: "heading",
      level: 2,
      children: [{ type: "text", text: "Заголовок первого уровня" }],
    });
    expect(blocks[1]).toEqual({
      type: "paragraph",
      children: [
        { type: "text", text: "Первый абзац," },
        { type: "br" },
        { type: "text", text: "вторая строка." },
      ],
    });
    expect(blocks[2]).toMatchObject({ type: "heading", level: 3 });
    expect(blocks[3]).toEqual({
      type: "list",
      ordered: false,
      items: [[{ type: "text", text: "раз" }], [{ type: "text", text: "два продолжение" }]],
    });
    expect(blocks[4]).toMatchObject({ type: "list", ordered: true });
    expect(richPlain(inlineOf(blocks[5]))).toBe("цитата в две строки");
  });

  test("inline: bold, italic, code and links; snake_case and arithmetic stay text", () => {
    expect(richInline("**жирный** и *курсив*, _тоже_ и `код`")).toEqual([
      { type: "strong", children: [{ type: "text", text: "жирный" }] },
      { type: "text", text: " и " },
      { type: "em", children: [{ type: "text", text: "курсив" }] },
      { type: "text", text: ", " },
      { type: "em", children: [{ type: "text", text: "тоже" }] },
      { type: "text", text: " и " },
      { type: "code", text: "код" },
    ]);
    expect(richInline("snake_case_name и 2*3*4")).toEqual([
      { type: "text", text: "snake_case_name и 2*3*4" },
    ]);
    expect(richInline("[сайт](https://example.ru/a) и [раздел](/blog#x)")).toEqual([
      {
        type: "link",
        href: "https://example.ru/a",
        external: true,
        children: [{ type: "text", text: "сайт" }],
      },
      { type: "text", text: " и " },
      { type: "link", href: "/blog#x", external: false, children: [{ type: "text", text: "раздел" }] },
    ]);
  });

  test("nothing is HTML: tags stay text, unsafe links lose their address, foreign images are not images", () => {
    const blocks = richText(
      [
        '<script>alert("x")</script>',
        "",
        "[нажми](javascript:alert(1)) [данные](data:text/html;base64,AAA) [чужой](//evil.example/x)",
        "",
        "![фото](https://evil.example/x.jpg)",
        "",
        "![Мастерская](/api/files/abc/img/960)",
      ].join("\n"),
    );
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", text: '<script>alert("x")</script>' }],
    });
    expect(JSON.stringify(blocks[1])).not.toContain('"link"');
    expect(richPlain(inlineOf(blocks[1]))).toBe("нажми данные чужой");
    expect(blocks[2]).toMatchObject({ type: "paragraph" });
    expect(blocks[3]).toEqual({ type: "image", src: "/api/files/abc/img/960", alt: "Мастерская" });
    expect(richText(null)).toEqual([]);
    expect(richText("x".repeat(RICH_TEXT_MAX + 10))[0]).toMatchObject({ type: "paragraph" });
  });

  test("safeHref and slugFromPath", () => {
    expect(safeHref("https://ya.ru")).toEqual({ href: "https://ya.ru", external: true });
    expect(safeHref("mailto:a@b.ru")).toEqual({ href: "mailto:a@b.ru", external: false });
    expect(safeHref("tel:+79990001122")).toMatchObject({ external: false });
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:x",
      "data:text/html,x",
      "//evil.ru",
      "vbscript:x",
      "ftp://x",
    ])
      expect(safeHref(bad), bad).toBeNull();
    expect(slugFromPath("/blog/kak-nachat", "/blog/")).toBe("kak-nachat");
    expect(slugFromPath("/blog/kak-nachat/", "/blog")).toBe("kak-nachat");
    expect(slugFromPath("/blog/%D0%B3%D0%BB%D0%B8%D0%BD%D0%B0", "/blog/")).toBe("глина");
    expect(slugFromPath("/blog/", "/blog/")).toBeNull();
    expect(slugFromPath("/blog/rubric/x", "/blog/")).toBeNull();
    expect(slugFromPath("/shop/x", "/blog/")).toBeNull();
    expect(slugFromPath("/blog/%E0%A4%A", "/blog/")).toBeNull();
  });
});

const app: AppSpec = {
  specVersion: "1",
  app: { name: "Мастерская", locale: "ru" },
  entities: [
    {
      name: "rubric",
      label: "Рубрика",
      fields: [
        { name: "name", label: "Название", type: "string", required: true },
        { name: "slug", label: "Адрес", type: "string", required: true },
        { name: "description", label: "Описание", type: "text" },
        { name: "sort_order", label: "Порядок", type: "int" },
      ],
    },
    {
      name: "article",
      label: "Статья",
      fields: [
        { name: "title", label: "Заголовок", type: "string", required: true },
        { name: "slug", label: "Адрес", type: "string", required: true },
        {
          name: "status",
          label: "Статус",
          type: "enum",
          required: true,
          default: "draft",
          enum: [
            { value: "draft", label: "Черновик" },
            { value: "published", label: "Опубликовано" },
          ],
        },
        { name: "published_at", label: "Дата", type: "date", required: true },
        { name: "rubric", label: "Рубрика", type: "ref", ref: { entity: "rubric" } },
        { name: "excerpt", label: "Анонс", type: "text" },
        { name: "body", label: "Текст", type: "text" },
        { name: "cover", label: "Обложка", type: "image" },
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
    { role: "owner", entity: "article", ops: ["read", "create", "update", "delete"] },
  ],
};

const BODY = [
  "Первый абзац с **важным**.",
  "",
  "## Что взять",
  "",
  "- фартук",
  "- резинку",
  "",
  '<img src=x onerror="alert(1)"> и [ссылка](javascript:alert(1)) и [карта](https://yandex.ru/maps)',
].join("\n");

function memory(): MemoryDataSource {
  return createMemoryDataSource(app, {
    rubric: [
      { id: "r1", name: "Новичкам", slug: "novichkam", sort_order: 1 },
      { id: "r2", name: "Глазури", slug: "glazuri", description: "Цвета и обжиг", sort_order: 2 },
    ],
    article: [
      {
        id: "a1",
        title: "Как начать",
        slug: "kak-nachat",
        status: "published",
        published_at: "2026-09-30",
        rubric: "r1",
        excerpt: "С чего начать.",
        body: BODY,
      },
      {
        id: "a2",
        title: "Матовая глазурь",
        slug: "glazur",
        status: "published",
        published_at: "2026-09-12",
        rubric: "r2",
      },
      {
        id: "a3",
        title: "Черновик",
        slug: "draft",
        status: "draft",
        published_at: "2026-10-01",
        rubric: "r2",
      },
    ],
  });
}

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
  window.history.replaceState(null, "", "/");
});

const at = (path: string) => window.history.replaceState(null, "", path);
const flush = () => act(async () => {});

async function mountHook<T>(hook: () => T) {
  let current: T | undefined;
  function Probe(): ReactNode {
    current = hook();
    return null;
  }
  r = await render(h(Probe), { app, role: null, ds: memory() });
  await flush();
  return () => current as T;
}

describe("useEntry and useRubric", () => {
  test("an entry by the slug of the address; a draft is not found for a visitor; a fixed slug wins", async () => {
    at("/blog/kak-nachat");
    const get = await mountHook(() => useEntry("article", { path: "/blog/" }));
    expect(get()).toMatchObject({ slug: "kak-nachat", notFound: false, isLoading: false, canRead: true });
    expect(get().entry).toMatchObject({ id: "a1", title: "Как начать" });
    r?.unmount();

    at("/blog/draft");
    const draft = await mountHook(() => useEntry("article", { path: "/blog/" }));
    expect(draft()).toMatchObject({ slug: "draft", entry: null, notFound: true });
    r?.unmount();

    at("/");
    const fixed = await mountHook(() => useEntry("article", { path: "/blog/", slug: "glazur" }));
    expect(fixed().entry).toMatchObject({ id: "a2" });
  });

  test("the posts of the rubric of the address; every published post without one", async () => {
    at("/blog/rubric/glazuri");
    const get = await mountHook(() => useRubric({ path: "/blog/rubric/" }));
    expect(get().all).toBe(false);
    expect(get().rubric.entry).toMatchObject({ id: "r2", name: "Глазури" });
    expect(get().posts.items.map((p) => p.id)).toEqual(["a2"]);
    expect(get().rubrics.items.map((x) => x.id)).toEqual(["r1", "r2"]);
    r?.unmount();

    at("/blog");
    const all = await mountHook(() => useRubric({ path: "/blog/rubric/" }));
    expect(all().all).toBe(true);
    expect(all().posts.items.map((p) => p.id)).toEqual(["a1", "a2"]);
  });
});

describe("article and rubric patterns", () => {
  const ARTICLES = {
    column: ArticleColumn,
    cover: ArticleCover,
    aside: ArticleAside,
    editorial: ArticleEditorial,
  };
  test.each(Object.entries(ARTICLES))(
    "article-%s: the title is the one h1, the body is React elements, no HTML of the owner, safe links",
    async (_name, Article) => {
      at("/blog/kak-nachat");
      r = await render(
        h(Article, {
          path: "/blog/",
          rubric: { path: "/blog/rubric/" },
          back: { label: "Все заметки", href: "/blog" },
        }),
        { app, role: null, ds: memory() },
      );
      await flush();
      await flush();
      const c = r.container;
      expect([...c.querySelectorAll("h1")].map((x) => x.textContent)).toEqual(["Как начать"]);
      expect(c.querySelector("h2")?.textContent).toBe("Что взять");
      expect([...c.querySelectorAll("li")].map((x) => x.textContent)).toEqual(["фартук", "резинку"]);
      expect(c.querySelector("strong")?.textContent).toBe("важным");
      // The owner's markup is text: no element came from it.
      expect(c.querySelector("img[onerror]")).toBeNull();
      expect(c.textContent).toContain('<img src=x onerror="alert(1)">');
      expect(c.querySelector('a[href^="javascript"]')).toBeNull();
      const external = c.querySelector('a[href="https://yandex.ru/maps"]');
      expect(external?.getAttribute("target")).toBe("_blank");
      expect(external?.getAttribute("rel")).toBe("noopener noreferrer");
      expect(c.querySelector('a[href="/blog/rubric/novichkam"]')?.textContent).toBe("Новичкам");
      expect(c.querySelector('a[href="/blog"]')?.textContent).toContain("Все заметки");
      expect(c.querySelector("time")?.getAttribute("dateTime")).toBe("2026-09-30");
    },
  );

  test("article: a draft or a wrong address says «Страница не найдена» with the way back", async () => {
    at("/blog/draft");
    r = await render(h(ArticleColumn, { path: "/blog/", back: { label: "Все заметки", href: "/blog" } }), {
      app,
      role: null,
      ds: memory(),
    });
    await flush();
    expect(r.container.querySelector("h1")?.textContent).toBe("Страница не найдена");
    expect(r.container.textContent).not.toContain("Черновик");
  });

  const RUBRICS = { cards: RubricCards, list: RubricList, split: RubricSplit };
  test.each(Object.entries(RUBRICS))(
    "rubric-%s: the rubric page has its name as the h1, its posts as h2 links, the current rubric marked",
    async (_name, Rubric) => {
      at("/blog/rubric/glazuri");
      r = await render(
        h(Rubric, {
          path: "/blog/",
          rubrics: { path: "/blog/rubric/" },
          title: "Все записи",
          level: 1,
          all: { label: "Все", href: "/blog" },
        }),
        { app, role: null, ds: memory() },
      );
      await flush();
      await flush();
      const c = r.container;
      expect([...c.querySelectorAll("h1")].map((x) => x.textContent)).toEqual(["Глазури"]);
      expect(c.textContent).toContain("Цвета и обжиг");
      expect([...c.querySelectorAll("h2 a")].map((a) => a.getAttribute("href"))).toEqual(["/blog/glazur"]);
      expect(c.querySelector('a[aria-current="page"]')?.getAttribute("href")).toBe("/blog/rubric/glazuri");
      expect(c.textContent).not.toContain("Черновик");
    },
  );

  test("rubric under a first screen (level 2): every post, the heading is an h2, «Все» is current", async () => {
    at("/blog");
    r = await render(
      h(RubricCards, {
        rubrics: { path: "/blog/rubric/" },
        path: "/blog/",
        title: "Все записи",
        all: { label: "Все", href: "/blog" },
      }),
      { app, role: null, ds: memory() },
    );
    await flush();
    await flush();
    const c = r.container;
    expect(c.querySelector("h1")).toBeNull();
    expect(c.querySelector("h2")?.textContent).toBe("Все записи");
    expect([...c.querySelectorAll("h3 a")].map((a) => a.getAttribute("href"))).toEqual([
      "/blog/kak-nachat",
      "/blog/glazur",
    ]);
    expect(c.querySelector('a[aria-current="page"]')?.textContent).toBe("Все");
  });
});
