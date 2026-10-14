// V4-24: a chat edit of a built site with a clear goal in words («сделай первый экран короче») finds its section on
// the home page and goes to «Укажи и измени» of it, not to the brief and a rebuild; no clear goal — the interview as
// before. A section written as code and a pattern alike: the element's wzId is the one of the build's wz-map.
import { fileKey, injectWzIds } from "@wizard/build";
import { describe, expect, test } from "vitest";
import { chatEditTarget, chatGoal } from "../src/builds-v3/edit/chat-target.js";

const PAGE = "ui/pages/site/Home.tsx";
const SOURCE = [
  'import HeaderFloating from "../../patterns/header-floating";',
  'import HomeHero from "../../sections/home-hero";',
  'import CatalogList from "../../patterns/catalog-list";',
  'import FooterContactFirst from "../../patterns/footer-contact-first";',
  "export default function HomePage() {",
  "  return (",
  "    <>",
  '      <HeaderFloating {...{"brand":{"name":"Белая линия"}}} />',
  '      <main id="main">',
  '        <div id="hero">',
  '          <HomeHero {...{"title":"Лечим зубы без боли"}} />',
  "        </div>",
  '        <div id="catalog">',
  '          <CatalogList {...{"entity":"service","title":"Услуги"}} />',
  "        </div>",
  "      </main>",
  '      <FooterContactFirst {...{"brand":{"name":"Белая линия"}}} />',
  "    </>",
  "  );",
  "}",
].join("\n");
const section = (id: string, type: string, pattern = type) => ({ id, type, pattern, props: {} });
const SITE = JSON.stringify({
  version: 1,
  seed: "x",
  pages: [
    {
      route: "/",
      title: "Главная",
      kind: "home",
      file: PAGE,
      component: "Home",
      nav: "Главная",
      header: true,
      roles: [],
      seo: { title: "", description: "" },
      sections: [
        section("header", "header", "header-floating"),
        { ...section("hero", "signature", "signature"), file: "ui/sections/home-hero.tsx" },
        section("catalog", "catalog", "catalog-list"),
        section("footer", "footer", "footer-contact-first"),
      ],
    },
  ],
});
const FILES = new Map([
  ["ui/site.json", SITE],
  [PAGE, SOURCE],
]);
const key = fileKey(PAGE);

describe("V4-24: a chat edit with a clear goal goes to «Укажи и измени» of its section", () => {
  test("the goal by words: one part of the page and a request to change it", () => {
    expect(chatGoal("Сделай первый экран короче")).toBe("hero");
    expect(chatGoal("поменяй текст кнопки на «Записаться»")).toBe("hero");
    expect(chatGoal("Подвал сделай светлее")).toBe("footer");
    expect(chatGoal("Увеличь блок с ценами")).toBe("catalog");
    // No request to change, two parts, nothing named — the interview.
    expect(chatGoal("Какие цены у конкурентов?")).toBeNull();
    expect(chatGoal("Сделай первый экран короче и подвал светлее")).toBeNull();
    expect(chatGoal("Добавь онлайн-оплату")).toBeNull();
    // A new block, section or page is a change of the structure — the interview, not an edit of a section.
    expect(chatGoal("Добавь блок с отзывами")).toBeNull();
    expect(chatGoal("Сделай отдельную страницу с ценами")).toBeNull();
    expect(chatGoal("Добавь новую секцию про врачей")).toBeNull();
    expect(chatGoal("Убери блок с отзывами")).toBeNull();
    expect(chatGoal("Удалите раздел вопросов")).toBeNull();
    // An addition inside a part that is there stays its edit.
    expect(chatGoal("Добавь в первый экран телефон")).toBe("hero");
    expect(chatGoal("Убери из блока с отзывами фото")).toBe("testimonials");
  });

  test("the element of the section on the home page — the wzId of the build's wz-map", () => {
    const ids = new Map(injectWzIds(PAGE, SOURCE).entries.map(([id, e]) => [e.componentName, id]));
    expect(chatEditTarget("Сделай первый экран короче", FILES)).toEqual({
      wzId: ids.get("HomeHero"),
      componentName: "HomeHero",
      file: PAGE,
      line: 11,
      route: "/",
      section: "hero",
    });
    expect(chatEditTarget("Увеличь блок с ценами", FILES)).toMatchObject({
      wzId: ids.get("CatalogList"),
      componentName: "CatalogList",
      section: "catalog",
    });
    expect(chatEditTarget("Подвал сделай светлее", FILES)).toMatchObject({
      wzId: `${key}:4`,
      componentName: "FooterContactFirst",
    });
    expect(chatEditTarget("Шапку сделай белой", FILES)).toMatchObject({
      wzId: `${key}:1`,
      componentName: "HeaderFloating",
    });
  });

  test("no clear goal, no such section, no site model — null (the interview)", () => {
    expect(chatEditTarget("Добавь онлайн-оплату", FILES)).toBeNull();
    // A part the home page does not have («сделай отзывы ярче» without reviews) — not an edit into nowhere.
    expect(chatEditTarget("Отзывы сделай крупнее", FILES)).toBeNull();
    expect(chatEditTarget("Сделай отзывы ярче", FILES)).toBeNull();
    expect(chatEditTarget("Добавь блок с ценами", FILES)).toBeNull();
    expect(chatEditTarget("Сделай первый экран короче", new Map([[PAGE, SOURCE]]))).toBeNull();
  });
});
