// @vitest-environment happy-dom
// V3-18 (builder-v3.md §3 C3, C4): what the composer's home and inner pages ask of the library — the srcset of every
// picture the runtime serves in widths (srcSetOf), the previews of the catalog and of the articles on home (nothing
// while empty, no «Показать ещё»), a list of the site's pages without dates, and the contacts the owner gave (a phone,
// an e-mail or an address — no hours or map of our own).
import type { AppSpec } from "@wizard/appspec";
import { act, createElement as h } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { createMemoryDataSource } from "../src/testing/index.js";
import { srcSetOf } from "../src/v3/headless/index.js";
import BlogCards from "../src/v3/patterns/blog/cards.js";
import { BLOG_PATTERNS } from "../src/v3/patterns/blog/index.js";
import BlogList from "../src/v3/patterns/blog/list.js";
import CatalogGrid from "../src/v3/patterns/catalog/grid.js";
import { CATALOG_PATTERNS } from "../src/v3/patterns/catalog/index.js";
import ContactsCards from "../src/v3/patterns/contacts/cards.js";
import ContactsCentered from "../src/v3/patterns/contacts/centered.js";
import { CONTACTS_PATTERNS } from "../src/v3/patterns/contacts/index.js";
import HeroSplit from "../src/v3/patterns/hero/split.js";
import ShopGrid from "../src/v3/patterns/shop/grid.js";
import { type Rendered, render } from "./helpers/dom.js";

const app: AppSpec = {
  specVersion: "1",
  app: { name: "Студия", locale: "ru" },
  entities: [
    {
      name: "service",
      label: "Услуга",
      fields: [
        { name: "name", label: "Название", type: "string", required: true },
        { name: "price", label: "Цена", type: "money" },
        { name: "photo", label: "Фото", type: "image" },
        { name: "active", label: "Показывать", type: "bool" },
        { name: "sort_order", label: "Порядок", type: "int" },
      ],
    },
    {
      name: "post",
      label: "Запись",
      fields: [
        { name: "title", label: "Заголовок", type: "string", required: true },
        { name: "slug", label: "Адрес", type: "string" },
        { name: "published_at", label: "Дата", type: "date" },
        { name: "updated_at", label: "Обновлено", type: "date" },
        { name: "excerpt", label: "Анонс", type: "text" },
      ],
    },
    {
      name: "product",
      label: "Товар",
      fields: [
        { name: "name", label: "Название", type: "string", required: true },
        { name: "price", label: "Цена", type: "money" },
        { name: "stock", label: "Остаток", type: "int" },
        { name: "active", label: "В продаже", type: "bool" },
        { name: "sort_order", label: "Порядок", type: "int" },
      ],
    },
  ],
  roles: [{ name: "guest", label: "Посетитель", access: "public" }],
  permissions: [
    { role: "guest", entity: "service", ops: ["read"] },
    { role: "guest", entity: "post", ops: ["read"] },
    { role: "guest", entity: "product", ops: ["read"] },
  ],
};

const FILE = "11111111-2222-4333-8444-555555555555";
const services = Array.from({ length: 8 }, (_, i) => ({
  id: `s${i}`,
  name: `Услуга ${i + 1}`,
  price: 1000 + i,
  photo: FILE,
  active: true,
  sort_order: i,
}));
const posts = Array.from({ length: 5 }, (_, i) => ({
  id: `p${i}`,
  title: `Запись ${i + 1}`,
  slug: `p-${i}`,
  published_at: `2026-09-1${i}`,
  updated_at: `2026-09-2${i}`,
}));

let r: Rendered | undefined;
afterEach(() => {
  r?.unmount();
  r = undefined;
});
const flush = () => act(async () => {});
const mount = async (el: ReturnType<typeof h>, data: Record<string, Record<string, unknown>[]> = {}) => {
  r = await render(el, { app, role: null, ds: createMemoryDataSource(app, data) });
  await flush();
  return r;
};

describe("srcSetOf: the widths the runtime serves", () => {
  test("an image field and a photo of the platform library get 480/960/1600; other addresses none", () => {
    expect(srcSetOf(`/api/files/${FILE}/img/960`)).toBe(
      `/api/files/${FILE}/img/480 480w, /api/files/${FILE}/img/960 960w, /api/files/${FILE}/img/1600 1600w`,
    );
    expect(srcSetOf(`https://sys.example.ru/api/files/${FILE}/img/1600`)).toContain(
      `https://sys.example.ru/api/files/${FILE}/img/480 480w`,
    );
    expect(srcSetOf(`/_wizard/photos/${FILE}/1600`)).toBe(
      `/_wizard/photos/${FILE}/480 480w, /_wizard/photos/${FILE}/960 960w, /_wizard/photos/${FILE}/1600 1600w`,
    );
    expect(srcSetOf("/_wizard/photos/example-hero.webp")).toBeUndefined();
    expect(srcSetOf(null)).toBeUndefined();
  });

  test("a pattern's picture carries the srcset and the sizes of its layout", async () => {
    const src = `/_wizard/photos/${FILE}/1600`;
    const page = await mount(
      h(HeroSplit, {
        title: "Студия",
        action: { label: "Оставить заявку", href: "#form" },
        image: { src, alt: "Зал" },
      }),
    );
    const img = page.q<HTMLImageElement>("img");
    expect(img.getAttribute("srcset")).toBe(srcSetOf(src));
    expect(img.getAttribute("sizes")).toBe("(min-width: 1024px) 50vw, 100vw");
  });
});

describe("previews on home", () => {
  test("the catalog's preview: nothing while empty; the first items with their srcset, no «Показать ещё»", async () => {
    const props = {
      title: "Услуги и цены",
      pageSize: 6,
      preview: true,
      action: { label: "Весь каталог", href: "/services" },
    };
    const empty = await mount(h(CatalogGrid, props));
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();
    r = undefined;
    const full = await mount(h(CatalogGrid, props), { service: services });
    expect(full.$$("wz-itemcard")).toHaveLength(6);
    expect(full.container.textContent).not.toContain("Показать ещё");
    expect(full.q("a[href='/services']").textContent).toBe("Весь каталог");
    expect(full.q("img").getAttribute("srcset")).toBe(srcSetOf(`/api/files/${FILE}/img/960`));
    full.unmount();
    // The same variant on its own page keeps «Показать ещё».
    r = await mount(h(CatalogGrid, { title: "Все услуги", pageSize: 6 }), { service: services });
    expect(r.container.textContent).toContain("Показать ещё");
  });

  test("the articles' preview: nothing while there are none, else the latest without «Показать ещё»", async () => {
    const props = { entity: "post", title: "Блог", pageSize: 3, preview: true, path: "/blog/" };
    const empty = await mount(h(BlogCards, props));
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();
    r = undefined;
    const full = await mount(h(BlogCards, props), { post: posts });
    expect(full.container.querySelectorAll("li")).toHaveLength(3);
    expect(full.container.textContent).toContain("Запись 5");
    expect(full.container.textContent).not.toContain("Показать ещё");
  });

  test("the site's pages go without dates; the variants by months never take them", async () => {
    const page = await mount(
      h(BlogList, { entity: "post", title: "Все страницы", dates: false, fields: { date: "updated_at" } }),
      { post: posts },
    );
    expect(page.container.textContent).toContain("Запись 1");
    expect(page.container.querySelector("time")).toBeNull();
    const archive = BLOG_PATTERNS.find((p) => p.variant === "archive");
    const parsed = archive?.slots.parse({ title: "Все страницы", dates: false }) as Record<string, unknown>;
    expect(parsed.dates).toBeUndefined();
    for (const p of BLOG_PATTERNS.filter((x) => x.variant !== "archive"))
      expect(
        (p.slots.parse({ title: "Т", dates: false, preview: true }) as Record<string, unknown>).dates,
      ).toBe(false);
    // A preview is a slot of every catalog variant that pages its items.
    const paged = CATALOG_PATTERNS.filter((p) => p.variant !== "sections" && p.variant !== "price-list");
    for (const p of paged)
      expect(
        (
          p.slots.safeParse({ title: "Т", preview: true, categoryEntity: "c" }).data as Record<
            string,
            unknown
          >
        )?.preview,
        p.id,
      ).toBe(true);
  });
});

describe("the shop's goods on home", () => {
  test("a preview: nothing while the shop is empty; six goods, the way to all of them, no «Показать ещё»", async () => {
    const props = {
      title: "Товары",
      pageSize: 6,
      preview: true,
      all: { label: "Все товары", href: "/shop" },
      cart: { label: "Корзина", href: "/cart" },
    };
    const empty = await mount(h(ShopGrid, props));
    expect(empty.container.innerHTML).toBe("");
    empty.unmount();
    const goods = Array.from({ length: 8 }, (_, i) => ({
      id: `g${i}`,
      name: `Кружка ${i + 1}`,
      price: 900 + i,
      stock: 3,
      active: true,
      sort_order: i,
    }));
    r = await mount(h(ShopGrid, props), { product: goods });
    expect(r.$$("wz-product")).toHaveLength(6);
    expect(r.q("a[href='/shop']").textContent).toBe("Все товары");
    expect(r.container.textContent).not.toContain("Показать ещё");
  });
});

describe("contacts the owner gave", () => {
  const phone = { number: "+7 843 200-40-50", href: "tel:+78432004050" };
  test("a phone alone, or an address with an e-mail: the variants that lay parts out one by one take them", async () => {
    const partial = CONTACTS_PATTERNS.filter(
      (p) => p.slots.safeParse({ title: "Контакты", phones: [phone] }).success,
    );
    expect(partial.map((p) => p.variant).sort()).toEqual(["cards", "centered"]);
    // Nothing to show — no section.
    for (const p of partial) expect(p.slots.safeParse({ title: "Контакты" }).success).toBe(false);
    const centered = await mount(h(ContactsCentered, { title: "Контакты", phones: [phone] }));
    expect(centered.q("a[href='tel:+78432004050']").textContent).toBe(phone.number);
    expect(centered.container.textContent).not.toContain("Яндекс Картах");
    centered.unmount();
    r = await mount(
      h(ContactsCards, {
        title: "Контакты",
        address: { text: "Казань, ул. Баумана, 15" },
        email: "hello@clinic.ru",
      }),
    );
    expect(r.container.textContent).toContain("Казань, ул. Баумана, 15");
    expect(r.q("a[href='mailto:hello@clinic.ru']")).toBeTruthy();
    expect(r.container.textContent).not.toContain("Часы работы");
    expect(r.container.textContent).not.toContain("Телефон");
  });
});
