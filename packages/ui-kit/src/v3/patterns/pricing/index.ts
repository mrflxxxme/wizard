// Pricing patterns (V3-08): ten compositions over one slot schema. Prices only from the brief: roubles as numbers
// (the pattern sets them with thin spaces and tabular figures), «от» only for a real range, the unit when it is not
// obvious; «Рекомендуем» only when the owner names the plan (catalog D1 PriceList and Pricing, R04, T17, L19, D49).
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Band from "./band.js";
import type Cards from "./cards.js";
import type Comparison from "./comparison.js";
import type Featured from "./featured.js";
import type Menu from "./menu.js";
import type Rows from "./rows.js";
import type Single from "./single.js";
import type SplitPhoto from "./split-photo.js";
import type Table from "./table.js";
import type Tabs from "./tabs.js";

/** A price as the client sets it, in roubles; `from` only when the price really varies (catalog R04). */
export const priceSlot = z.object({
  amount: z.number().nonnegative().max(100_000_000),
  from: z.boolean().optional(),
  /** «за занятие», «в месяц», «за пару». */
  unit: line(30).optional(),
});

/** A line of a price list. */
export const priceItemSlot = z.object({
  name: line(80),
  /** What is included or who it is for, one sentence. */
  text: para(200).optional(),
  /** Duration or volume: «2 часа», «4 занятия». */
  detail: line(40).optional(),
  price: priceSlot,
});

/** A plan or an offer: a price line with what is included and its own action. */
export const planSlot = priceItemSlot.extend({
  features: z.array(line(90)).min(1).max(8),
  /** Only when the owner names the plan to recommend (D49); one per section. */
  recommended: z.boolean().optional(),
  action: linkSlot,
});

const plansSlot = z
  .array(planSlot)
  .min(2)
  .max(4)
  .refine((ps) => ps.filter((p) => p.recommended).length <= 1, "рекомендуемый тариф — не больше одного");

const groupSlot = z.object({ title: line(60), items: z.array(priceItemSlot).min(1).max(12) });

/** A row of the comparison: a feature and its value per plan (true/false — included or not, or a short text). */
const compareRowSlot = z.object({
  label: line(60),
  values: z
    .array(z.union([z.boolean(), line(30)]))
    .min(2)
    .max(4),
});

/** Everything a pricing section may show; each variant picks what it renders. */
export const pricingSlots = z.object({
  title: line(80),
  lead: para(260).optional(),
  items: z.array(priceItemSlot).min(2).max(24).optional(),
  groups: z.array(groupSlot).min(2).max(6).optional(),
  plans: plansSlot.optional(),
  compare: z.array(compareRowSlot).min(2).max(16).optional(),
  offer: planSlot.optional(),
  /** Column names of the price table: «Услуга», «Длительность», «Цена» by default. */
  columns: z.object({ name: line(30), detail: line(30).optional(), price: line(30) }).optional(),
  action: linkSlot.optional(),
  /** When the prices apply and how to pay: «Цены действуют с 1 сентября 2026 года». */
  note: line(160).optional(),
  image: imageSlot.optional(),
});

const ITEMS = [
  {
    name: "Пробное занятие",
    detail: "2 часа",
    text: "Знакомство с кругом и одна чашка на обжиг",
    price: { amount: 2500 },
  },
  {
    name: "Разовое занятие",
    detail: "2 часа",
    text: "Для тех, кто уже работал на круге",
    price: { amount: 3000 },
  },
  {
    name: "Индивидуальное занятие",
    detail: "1,5 часа",
    text: "Мастер работает только с вами",
    price: { amount: 4500 },
  },
  { name: "Свидание на гончарном круге", detail: "2 часа", price: { amount: 6000, unit: "за пару" } },
  {
    name: "Роспись готового изделия",
    detail: "1 час",
    text: "Цена зависит от размера изделия",
    price: { amount: 900, from: true, unit: "за изделие" },
  },
  { name: "Детский мастер-класс", detail: "1 час", text: "Для детей от семи лет", price: { amount: 1800 } },
];

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const PRICING_EXAMPLE = {
  title: "Цены на занятия",
  lead: "Глина, глазурь и обжиг входят в стоимость. Готовые работы забираете через две недели.",
  items: ITEMS,
  groups: [
    { title: "Занятия", items: ITEMS.slice(0, 3) },
    {
      title: "Для двоих и компаний",
      items: [
        ITEMS[3] as (typeof ITEMS)[number],
        {
          name: "Компания до шести человек",
          detail: "2,5 часа",
          text: "Зал только для вас, чай и сладости",
          price: { amount: 15000, unit: "за группу" },
        },
      ],
    },
    {
      title: "Дети",
      items: [
        ITEMS[5] as (typeof ITEMS)[number],
        {
          name: "День рождения в мастерской",
          detail: "2 часа",
          text: "До восьми детей, цена зависит от числа гостей",
          price: { amount: 12000, from: true, unit: "за группу" },
        },
      ],
    },
  ],
  plans: [
    {
      name: "Разовое занятие",
      detail: "1 занятие",
      price: { amount: 3000 },
      features: ["Два часа на круге", "Глина, глазурь и обжиг", "Фартук и инструменты"],
      action: { label: "Записаться на занятие", href: "#form" },
    },
    {
      name: "Четыре занятия",
      detail: "Действует два месяца",
      price: { amount: 10400 },
      recommended: true,
      features: [
        "Четыре занятия по два часа",
        "Глина, глазурь и обжиг",
        "Перенос занятия за сутки",
        "Своя полка для работ",
      ],
      action: { label: "Купить четыре занятия", href: "#form" },
    },
    {
      name: "Восемь занятий",
      detail: "Действует три месяца",
      price: { amount: 19200 },
      features: [
        "Восемь занятий по два часа",
        "Глина, глазурь и обжиг",
        "Перенос занятия за сутки",
        "Заморозка на две недели",
      ],
      action: { label: "Купить восемь занятий", href: "#form" },
    },
  ],
  compare: [
    { label: "Занятий", values: ["1", "4", "8"] },
    { label: "Срок действия", values: ["в день записи", "2 месяца", "3 месяца"] },
    { label: "Глина, глазурь и обжиг", values: [true, true, true] },
    { label: "Перенос занятия за сутки", values: [false, true, true] },
    { label: "Своя полка для работ", values: [false, true, true] },
    { label: "Заморозка на две недели", values: [false, false, true] },
  ],
  offer: {
    name: "Курс «Первая посуда»",
    detail: "8 занятий по 2 часа, раз в неделю",
    text: "За два месяца сделаете чашку, тарелку и миску и научитесь центровать глину без помощи мастера.",
    price: { amount: 19200 },
    features: [
      "Группа до шести человек",
      "Глина, глазурь и обжиг включены",
      "Работы забираете через две недели после обжига",
      "Перенос занятия, если предупредить за сутки",
    ],
    action: { label: "Записаться на курс", href: "#form" },
  },
  action: { label: "Записаться на занятие", href: "#form" },
  note: "Цены действуют с 1 сентября 2026 года. Оплата картой, по СБП или наличными.",
  image: {
    src: "/_wizard/photos/example-table.webp",
    alt: "Стол мастерской с глиной, стеками и мисками перед обжигом",
  },
} satisfies z.input<typeof pricingSlots>;

const at = import.meta.url;
const head = pricingSlots.pick({ title: true, lead: true, note: true });

export const PRICING_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Rows>()(at, "pricing", {
    variant: "rows",
    layout: "list",
    title: "Прайс-лист с точечными отточиями: название и цена в строку, длительность и пояснение под ними",
    archetypes: ["*"],
    slots: head.extend({ items: z.array(priceItemSlot).min(2).max(24), action: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: PRICING_EXAMPLE,
  }),
  definePattern<typeof Tabs>()(at, "pricing", {
    variant: "tabs",
    layout: "stacked",
    title: "Длинный прайс по категориям во вкладках: строки в две колонки, переключение стрелками",
    archetypes: ["*"],
    slots: head.extend({ groups: z.array(groupSlot).min(2).max(6) }),
    needs: null,
    license: "own",
    origin: "own",
    example: PRICING_EXAMPLE,
  }),
  definePattern<typeof Cards>()(at, "pricing", {
    variant: "cards",
    layout: "card",
    title: "Тарифы карточками 2–4 в ряд: цены, списки и кнопки на одних линиях, рекомендуемый — цветом",
    archetypes: ["*"],
    slots: head.extend({ plans: plansSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: PRICING_EXAMPLE,
  }),
  definePattern<typeof Table>()(at, "pricing", {
    variant: "table",
    layout: "columns",
    title: "Таблица «услуга — длительность — цена»; на телефоне строки складываются в карточки без прокрутки",
    archetypes: ["*"],
    slots: head.extend({
      items: z.array(priceItemSlot).min(2).max(24),
      columns: pricingSlots.shape.columns,
      action: linkSlot.optional(),
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: PRICING_EXAMPLE,
  }),
  definePattern<typeof Comparison>()(at, "pricing", {
    variant: "comparison",
    layout: "grid",
    title: "Сравнение тарифов: таблица «что входит» на компьютере, тарифы списками на телефоне",
    archetypes: ["*"],
    slots: head
      .extend({ plans: plansSlot, compare: z.array(compareRowSlot).min(2).max(16) })
      .refine(
        (s) => s.compare.every((r) => r.values.length === s.plans.length),
        "в каждой строке сравнения по значению на тариф",
      ),
    needs: null,
    license: "own",
    origin: "own",
    example: PRICING_EXAMPLE,
  }),
  definePattern<typeof Single>()(at, "pricing", {
    variant: "single",
    layout: "panel",
    title: "Одно предложение: панель с составом слева и крупной ценой с кнопкой справа",
    archetypes: ["*"],
    slots: head.extend({ offer: planSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: PRICING_EXAMPLE,
  }),
  definePattern<typeof SplitPhoto>()(at, "pricing", {
    variant: "split-photo",
    layout: "split",
    title: "Фото на половину, рядом короткий прайс между линейками и кнопка записи",
    archetypes: ["*"],
    slots: head.extend({
      items: z.array(priceItemSlot).min(2).max(8),
      image: imageSlot,
      action: linkSlot.optional(),
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: { ...PRICING_EXAMPLE, items: ITEMS.slice(0, 5) },
  }),
  definePattern<typeof Menu>()(at, "pricing", {
    variant: "menu",
    layout: "typographic",
    title: "Меню по центру: разделы между линейками, название крупно, пояснение и цена под ним",
    archetypes: ["*"],
    slots: head.extend({ groups: z.array(groupSlot).min(2).max(6) }),
    needs: null,
    license: "own",
    origin: "own",
    example: PRICING_EXAMPLE,
  }),
  definePattern<typeof Featured>()(at, "pricing", {
    variant: "featured",
    layout: "asymmetric",
    title: "Главное предложение на фирменной плашке слева, остальные цены списком справа",
    archetypes: ["*"],
    slots: head.extend({ offer: planSlot, items: z.array(priceItemSlot).min(2).max(8) }),
    needs: null,
    license: "own",
    origin: "own",
    example: { ...PRICING_EXAMPLE, items: ITEMS.slice(0, 4) },
  }),
  definePattern<typeof Band>()(at, "pricing", {
    variant: "band",
    layout: "band",
    title: "Тарифы строками на тонированной полосе: название, состав, цена и кнопка в одну линию",
    archetypes: ["*"],
    slots: head.extend({ plans: plansSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: PRICING_EXAMPLE,
  }),
];
