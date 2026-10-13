// V4-18 acceptance (static pass): a clean site has no findings; each kind of stub — dead links and empty handlers (S01),
// placeholder texts (S02), one phrase over the cards and cards without a photo (S03), contacts not from the brief
// (S04) — is found with its file, literal and section; the shared rules hold for the page script too.
import { describe, expect, test } from "vitest";
import {
  deadLink,
  knownContacts,
  placeholderOf,
  STUB_CODES,
  STUB_RUBRIC,
  type StubFinding,
  strangeContacts,
  stubFindings,
} from "../src/index.js";

const SITE = JSON.stringify({
  version: 1,
  pages: [
    {
      route: "/",
      file: "ui/pages/site/Home.tsx",
      sections: [{ id: "header" }, { id: "hero" }, { id: "services" }, { id: "form" }],
    },
    { route: "/services", file: "ui/pages/site/Services.tsx", sections: [{ id: "catalog" }] },
    { route: "/services/:id", file: "ui/pages/site/Service.tsx", sections: [] },
  ],
});

const HOME = (body: string) => `import Hero from "../../patterns/hero-split";
export default function HomePage() {
  return (
    <>
      <header id="header"><a href="/">Белая линия</a><a href="/services">Каталог и цены</a><a href="tel:+79161234567">+7 916 123-45-67</a></header>
      <main id="main">
        <div id="hero">
          <Hero {...{"title":"Лечим зубы без боли и очередей","action":{"label":"Оставить заявку","href":"#form"}}} />
        </div>
        <div id="services">
          <h2>Почему мы</h2>
          ${body}
        </div>
        <div id="form"><form><input placeholder="+7 (900) 000-00-00" /><button type="submit">Отправить</button></form></div>
      </main>
      <footer><a href="mailto:hello@belaya-liniya.ru">hello@belaya-liniya.ru</a><a href="/privacy">Политика</a></footer>
    </>
  );
}
`;

const CLEAN_BODY = `<Cards items={[
  { "title": "Современное оборудование", "text": "Томографы и микроскопы в каждом кабинете", "image": "/_wizard/photos/a/960" },
  { "title": "Анестезия", "text": "Лечим без боли даже детей", "image": "/_wizard/photos/b/960" }
]} />
<p>Работаем с 9 до 21 без выходных. <a href="/services#catalog">Все услуги</a> или <a href="/services/42">имплантация</a>.</p>`;

const files = (body: string, extra: Record<string, string> = {}) =>
  new Map<string, string>([
    ["ui/site.json", SITE],
    ["ui/pages/site/Home.tsx", HOME(body)],
    [
      "ui/pages/site/Services.tsx",
      `export default function S() { return <main><div id="catalog"><h1>Каталог</h1></div></main>; }`,
    ],
    ["ui/patterns/hero-split.tsx", `export default function H() { return <a href="#">Заголовок</a>; }`],
    ...Object.entries(extra),
  ]);

const known = knownContacts(["Телефон клиники +7 (916) 123-45-67, почта hello@belaya-liniya.ru"]);
const find = (body: string) => stubFindings({ files: files(body), known });
const codes = (fs: StubFinding[]) => fs.map((f) => f.code);

describe("stubFindings", () => {
  test("a clean site: no findings (form placeholders, the pattern library, the owner's contacts, dynamic routes)", () => {
    expect(find(CLEAN_BODY)).toEqual([]);
  });

  test("S01: «#», empty, javascript:, a page and an anchor the site does not have, an empty handler", () => {
    const fs = find(`<a href="#">Подробнее</a><a href="">Ещё</a><a href="javascript:void(0)">Тык</a>
      <a href="/prices">Цены</a><a href="#reviews">Отзывы</a><a href="/services#nope">Каталог</a>
      <button onClick={() => {}}>Записаться</button>`);
    expect(codes(fs).every((c) => c === "S01")).toBe(true);
    expect(fs.map((f) => f.literal)).toEqual([
      "#",
      "(пусто)",
      "javascript:void(0)",
      "/prices",
      "#reviews",
      "/services#nope",
      "onClick={() => {}}",
    ]);
    expect(fs[0]).toMatchObject({ file: "ui/pages/site/Home.tsx", route: "/", section: "services" });
    expect(fs[3]?.message_ru).toBe("страницы /prices на сайте нет");
  });

  test("S02: placeholder texts in JSX, props and alt; real texts are not", () => {
    const fs = find(`<h3>Заголовок</h3><p>Lorem ipsum dolor sit amet</p>
      <Cards items={[{ "title": "Описание услуги", "text": "Подробности" }, { "title": "Иван Иванов", "text": "Отзыв" }]} />
      <img src="/_wizard/photos/a/960" alt="Текст" /><p>Скоро здесь появятся отзывы</p><p>Звоните: +7 000 000-00-00</p>
      <p>TODO: добавить цены</p><p>Пишите на info@example.com</p>`);
    expect(codes(fs).every((c) => c === "S02")).toBe(true);
    expect(fs.map((f) => f.literal)).toEqual(
      expect.arrayContaining([
        "Заголовок",
        "Lorem ipsum dolor sit amet",
        "Описание услуги",
        "Иван Иванов",
        "Текст",
        "Скоро здесь появятся отзывы",
        "Звоните: +7 000 000-00-00",
        "TODO: добавить цены",
        "Пишите на info@example.com",
      ]),
    );
  });

  test("S03: one phrase over the cards, cards without a photo among cards with one", () => {
    const fs = find(`<Cards items={[
      { "title": "Чистка", "text": "Качественно и быстро", "image": "/_wizard/photos/a/960" },
      { "title": "Пломба", "text": "Качественно и быстро", "image": "/_wizard/photos/b/960" },
      { "title": "Коронка", "text": "Из диоксида циркония" }
    ]} />`);
    expect(fs.map((f) => [f.code, f.message_ru])).toEqual([
      ["S03", "одна фраза в 2 карточках из 3"],
      ["S03", "карточки без фото: 1 из 3, у остальных фото есть"],
    ]);
  });

  test("S04: a phone and an e-mail the owner did not give, in texts and in tel:/mailto:", () => {
    const fs = find(`<p>Звоните +7 (495) 765-43-21</p><a href="mailto:sales@other.ru">Почта</a>`);
    expect(fs.map((f) => [f.code, f.literal])).toEqual([
      ["S04", "+7 (495) 765-43-21"],
      ["S04", "sales@other.ru"],
    ]);
  });

  test("sections: a free-code section file and its route; the pattern library is never read", () => {
    const fs = stubFindings({
      files: files(CLEAN_BODY, {
        "ui/sections/Promo.tsx": `export default function P() { return <section><h2>Подзаголовок</h2></section>; }`,
      }),
      known,
    });
    expect(fs).toEqual([
      expect.objectContaining({ code: "S02", file: "ui/sections/Promo.tsx", literal: "Подзаголовок" }),
    ]);
  });
});

describe("rules", () => {
  test("placeholderOf: whole placeholder texts and fragments; labels and real texts pass", () => {
    for (const t of [
      "Заголовок",
      "  текст. ",
      "lorem ipsum",
      "Coming soon",
      "[Название компании]",
      "{{name}}",
      "8 (999) 999-99-99",
      "Услуга 1",
      "Товар №12",
    ])
      expect(placeholderOf(t), t).not.toBeNull();
    for (const t of [
      "Телефон",
      "Адрес",
      "Имя",
      "Описание",
      "Лечим зубы без боли",
      "Наш адрес: Казань, ул. Баумана, 1",
      // The empty state of a data list the owner has not filled yet (ui-kit catalog) is not a stub.
      "Позиции каталога скоро появятся.",
      "Зал 1",
      "Услуга для детей 1-го класса",
    ])
      expect(placeholderOf(t), t).toBeNull();
  });

  test("contacts: the owner's are known in any spelling; placeholder phones are not counted twice", () => {
    expect(strangeContacts("8 916 123 45 67 или HELLO@belaya-liniya.ru", known)).toEqual([]);
    expect(strangeContacts("+7 000 000-00-00", known)).toEqual([]);
    expect(strangeContacts("+7 900 111-22-33", known)).toEqual(["+7 900 111-22-33"]);
  });

  test("deadLink: external, system and dynamic routes go somewhere", () => {
    const at = { route: "/", routes: ["/", "/services", "/services/:id"] };
    for (const h of [
      "https://vk.com/x",
      "tel:+79000000000",
      "/privacy",
      "/login?next=/",
      "/services/7",
      "/_wizard/photos/a/960",
      "/offer",
      "/returns",
    ])
      expect(deadLink(h, at), h).toBeNull();
    expect(deadLink("/blog", at)).toBe("страницы /blog на сайте нет");
  });

  test("the rubric covers every code", () => {
    expect(Object.keys(STUB_RUBRIC).sort()).toEqual([...STUB_CODES]);
  });
});

test("S04: one phone in two spellings (text and tel:) counts once", () => {
  const fs = stubFindings({
    files: files(`<p><a href="tel:+74957654321">+7 (495) 765-43-21</a></p>`),
    known,
  });
  expect(fs.map((f) => f.code)).toEqual(["S04"]);
});
