// V3-18: the preview of a v3 system shows its seed — without a hint the generic values are honest and plausible: a
// neutral «<entity> N» name (never «Товар «Летний»»), no invented descriptions (D49), an optional price left empty and a
// required one round by the niche, durations on the booking grid, Latin slugs from the title, a demo address and
// opening hours of a pickup point; hints of the brief replace the names and drop the vocabulary's text of their rows.
import type { AppSpec, Entity } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import { slugify } from "../src/g1/realistic.js";
import { generateSeed, type SeedHint, seedDlp } from "../src/index.js";
import { loadBakery } from "./g1-helpers.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");

// Entities in the shape of the modules «Каталог и прайс», «Магазин» and «Контент и блог» (packages/modules compile.ts).
const entities: Entity[] = [
  {
    name: "service_category",
    label: "Раздел каталога",
    fields: [
      { name: "name", label: "Название", type: "string", required: true, maxLength: 80 },
      { name: "sort_order", label: "Порядок на витрине", type: "int", min: 0, max: 9999 },
    ],
  },
  {
    name: "service",
    label: "Услуга",
    fields: [
      { name: "name", label: "Название", type: "string", required: true, maxLength: 120 },
      { name: "price", label: "Цена, ₽", type: "money", min: 0 },
      { name: "duration_min", label: "Длительность, мин", type: "int", required: true, min: 5, max: 720 },
      {
        name: "category",
        label: "Раздел",
        type: "ref",
        ref: { entity: "service_category", onDelete: "set_null" },
      },
      { name: "active", label: "На витрине", type: "bool", required: true, default: true },
      { name: "description", label: "Описание", type: "text", maxLength: 1000 },
      { name: "sort_order", label: "Порядок на витрине", type: "int", min: 0, max: 9999 },
    ],
  },
  {
    name: "product_category",
    label: "Раздел магазина",
    fields: [{ name: "name", label: "Название", type: "string", required: true, maxLength: 80 }],
  },
  {
    name: "product",
    label: "Товар",
    fields: [
      { name: "name", label: "Название", type: "string", required: true, maxLength: 120 },
      { name: "price", label: "Цена, ₽", type: "money", required: true, min: 0 },
      {
        name: "stock",
        label: "В наличии, шт.",
        type: "int",
        required: true,
        default: 0,
        min: 0,
        max: 1000000,
      },
      {
        name: "category",
        label: "Раздел",
        type: "ref",
        ref: { entity: "product_category", onDelete: "set_null" },
      },
      { name: "active", label: "В продаже", type: "bool", required: true, default: true },
      { name: "description", label: "Описание", type: "text", maxLength: 1000 },
      { name: "sku", label: "Артикул", type: "string", maxLength: 50 },
      { name: "weight_g", label: "Вес, г", type: "int", min: 1, max: 100000 },
    ],
  },
  {
    name: "pickup_point",
    label: "Пункт самовывоза",
    fields: [
      { name: "name", label: "Название", type: "string", required: true, maxLength: 80 },
      { name: "address", label: "Адрес", type: "string", required: true, maxLength: 200 },
      { name: "hours", label: "Часы работы", type: "string", maxLength: 120 },
      { name: "active", label: "Работает", type: "bool", required: true, default: true },
    ],
  },
  {
    name: "article",
    label: "Статья",
    fields: [
      { name: "title", label: "Заголовок", type: "string", required: true, maxLength: 140 },
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
      { name: "published_at", label: "Дата публикации", type: "date", required: true },
      {
        name: "slug",
        label: "Адрес статьи: латиница, цифры и дефис",
        type: "string",
        required: true,
        unique: true,
        maxLength: 80,
      },
      { name: "excerpt", label: "Анонс", type: "text", maxLength: 300 },
      { name: "body", label: "Текст: абзацы через пустую строку, ## подзаголовок, - список", type: "text" },
      { name: "seo_title", label: "Заголовок для поисковиков", type: "string", maxLength: 70 },
      { name: "seo_description", label: "Описание для поисковиков", type: "string", maxLength: 160 },
    ],
  },
  {
    name: "shop_order_line",
    label: "Позиция заказа",
    fields: [
      { name: "name", label: "Товар", type: "string", required: true, maxLength: 120 },
      { name: "qty", label: "Количество", type: "int", required: true, min: 1, max: 999 },
      { name: "price", label: "Цена, ₽", type: "money", required: true, min: 0 },
      { name: "sum", label: "Сумма, ₽", type: "money", required: true, min: 0 },
      { name: "product", label: "Товар", type: "ref", ref: { entity: "product", onDelete: "set_null" } },
    ],
  },
];

const specOf = (description: string): AppSpec =>
  ({
    specVersion: "1",
    app: { name: "Проверка", description, locale: "ru" },
    entities,
    roles: [
      { name: "owner", label: "Владелец", access: "login" },
      { name: "guest", label: "Посетитель", access: "public" },
    ],
    permissions: entities.map((e) => ({
      role: "owner",
      entity: e.name,
      ops: ["read", "create", "update", "delete"],
    })),
    pages: [],
    acceptance: [],
  }) as unknown as AppSpec;

const spec = specOf("Студия дизайна интерьеров");
const rowsOf = (seed: ReturnType<typeof generateSeed>, e: string) => seed.rows[e] ?? [];
const TEMPLATE_ADJ = /«(Основной|Пробный|Весенний|Базовый|Расширенный|Летний|Новый|Особый)»/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe("generic seed values without a hint (V3-18)", () => {
  const seed = generateSeed(spec, "key-1", { now: NOW });

  test("names: the entity's label and the row number, never an invented adjective; the module's qualifier dropped", () => {
    expect(rowsOf(seed, "service").map((r) => r.name)).toEqual(["Услуга 1", "Услуга 2", "Услуга 3"]);
    expect(rowsOf(seed, "product_category").map((r) => r.name)).toEqual(["Раздел 1", "Раздел 2", "Раздел 3"]);
    expect(rowsOf(seed, "service_category")[0]?.name).toBe("Раздел 1");
    expect(rowsOf(seed, "article")[0]?.title).toBe("Статья 1");
    for (const e of entities)
      for (const r of rowsOf(seed, e.name))
        for (const v of Object.values(r)) expect(String(v)).not.toMatch(TEMPLATE_ADJ);
  });

  test("no invented text: optional descriptions, excerpts, bodies and SEO fields stay empty", () => {
    for (const r of rowsOf(seed, "service")) expect(r.description).toBeUndefined();
    for (const r of rowsOf(seed, "product")) expect(r.description).toBeUndefined();
    for (const r of rowsOf(seed, "article")) {
      expect(r.excerpt).toBeUndefined();
      expect(r.body).toBeUndefined();
      expect(r.seo_title).toBeUndefined();
      expect(r.seo_description).toBeUndefined();
    }
  });

  test("prices: an optional one empty («по запросу»), a required one round by the niche", () => {
    for (const r of rowsOf(seed, "service")) expect(r.price).toBeUndefined();
    for (const r of rowsOf(seed, "product")) expect([5000, 12000, 25000, 40000, 80000]).toContain(r.price);
    const cafe = generateSeed(specOf("Кофейня у дома"), "key-1", { now: NOW });
    for (const r of rowsOf(cafe, "product")) expect([300, 400, 500, 700, 900]).toContain(r.price);
    const other = generateSeed(specOf("Магазин"), "key-1", { now: NOW });
    for (const r of rowsOf(other, "product")) {
      expect(r.price).not.toBe(4900);
      expect(r.price).not.toBe(14900);
      expect(Number(r.price) % 100).toBe(0);
    }
  });

  test("durations on the booking grid, plausible grams and stock, an article code", () => {
    for (let k = 0; k < 20; k++)
      for (const r of rowsOf(generateSeed(spec, `d${k}`, { now: NOW }), "service"))
        expect([30, 60, 90, 120]).toContain(r.duration_min);
    for (const r of rowsOf(seed, "product")) {
      expect([250, 500, 1000, 1500]).toContain(r.weight_g);
      expect(r.sku).toMatch(/^A-\d{4}$/);
      expect(Number(r.stock)).toBeLessThanOrEqual(100);
    }
  });

  test("slugs: Latin from the title, unique, no spaces or Cyrillic (links /blog/statya-1)", () => {
    const slugs = rowsOf(seed, "article").map((r) => r.slug as string);
    for (const [i, s] of slugs.entries()) {
      expect(s).toMatch(SLUG);
      expect(s).toBe(slugify(String(rowsOf(seed, "article")[i]?.title)));
    }
    expect(slugs[0]).toBe("statya-1");
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  test("order lines: the product's name and price, 1–3 pieces, sum = price × qty", () => {
    const products = new Map(rowsOf(seed, "product").map((p) => [p.id, p]));
    for (const l of rowsOf(seed, "shop_order_line")) {
      const p = products.get(l.product);
      expect(l.name).toBe(p?.name);
      expect(l.price).toBe(p?.price);
      expect([1, 2, 3]).toContain(l.qty);
      expect(l.sum).toBe(Number(l.price) * Number(l.qty));
    }
  });

  test("pickup points: a demo address of the synthetic dictionary and opening hours, no «Адрес 178»", () => {
    for (const r of rowsOf(seed, "pickup_point")) {
      expect(r.name).toMatch(/^Пункт самовывоза \d+$/);
      expect(r.address).toMatch(/^ул\. Тестовая, д\. \d+$/);
      expect(r.hours).toMatch(/^(Пн–Пт|Ежедневно|Пн–Сб) \d\d:\d\d–\d\d:\d\d$/);
    }
  });

  test("no «<label> N» placeholder anywhere; deterministic; DLP-clean for many keys", () => {
    // An order line's «Товар» is its product's name («Товар 1»): checked above.
    for (const e of entities.filter((x) => x.name !== "shop_order_line"))
      for (const f of e.fields)
        for (const r of rowsOf(seed, e.name))
          if (typeof r[f.name] === "string") expect(r[f.name]).not.toMatch(new RegExp(`^${f.label} \\d+$`));
    expect(generateSeed(spec, "key-1", { now: NOW })).toEqual(seed);
    for (let k = 0; k < 50; k++) expect(seedDlp(spec, generateSeed(spec, `p${k}`, { now: NOW }))).toEqual([]);
  });
});

describe("hints of the brief in the seed (V3-18)", () => {
  const hints: SeedHint[] = [
    { entity: "service", field: "name", values: ["Дизайн квартиры", "Авторский надзор"] },
    { entity: "article", field: "title", values: ["Как выбрать плитку", "Как выбрать плитку"] },
  ];
  const seed = generateSeed(spec, "key-1", { now: NOW, hints });

  test("names come from the hints; rows past them keep the neutral name", () => {
    expect(rowsOf(seed, "service").map((r) => r.name)).toEqual([
      "Дизайн квартиры",
      "Авторский надзор",
      "Услуга 3",
    ]);
  });

  test("a slug follows the hinted title and stays unique", () => {
    expect(rowsOf(seed, "article").map((r) => r.slug)).toEqual([
      "kak-vybrat-plitku",
      "kak-vybrat-plitku-2",
      "statya-3",
    ]);
    expect(seedDlp(spec, seed)).toEqual([]);
  });

  test("a hinted name drops the vocabulary's description of its row (it described another cake)", () => {
    const { spec: bakery } = loadBakery();
    const plain = generateSeed(bakery, "key-1", { now: NOW });
    const hinted = generateSeed(bakery, "key-1", {
      now: NOW,
      hints: [{ entity: "product", field: "name", values: ["Медовик"] }],
    });
    expect(rowsOf(plain, "product")[0]?.description).toEqual(expect.any(String));
    expect(rowsOf(hinted, "product")[0]).toMatchObject({ name: "Медовик" });
    expect(rowsOf(hinted, "product")[0]?.description).toBeUndefined();
    expect(rowsOf(hinted, "product")[1]?.description).toBe(rowsOf(plain, "product")[1]?.description);
  });
});
