// Services patterns (V3-08): ten compositions of what the business offers over one slot schema — price list, split
// with a photo, a numbered programme, bento, tabs, editorial rows, a dominant offer, a typographic index, staggered
// photo cards and a menu over a photo. Prices, durations and every claim come from the brief through slots (D49, R04).
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Bento from "./bento.js";
import type Dominant from "./dominant.js";
import type Editorial from "./editorial.js";
import type Numbered from "./numbered.js";
import type PhotoMenu from "./photo-menu.js";
import type Poster from "./poster.js";
import type PriceList from "./price-list.js";
import type SplitMedia from "./split-media.js";
import type Staggered from "./staggered.js";
import type Tabs from "./tabs.js";

/** One service: name, short description and the facts of the brief (price «от» only with a real range, R04). */
export const serviceSlot = z.object({
  title: line(60),
  text: para(220).optional(),
  /** As the brief gives it: «2 500 ₽», «от 2 200 ₽». */
  price: line(30).optional(),
  /** Duration or volume: «2 часа», «8 занятий». */
  duration: line(30).optional(),
  /** What is included, ≤ 4 short lines. */
  points: z.array(line(90)).max(4).optional(),
  image: imageSlot.optional(),
  /** The service page or booking for this service. */
  link: linkSlot.optional(),
});

/** Everything a services section may show; each variant picks what it renders. */
export const servicesSlots = z.object({
  title: line(80),
  intro: para(260).optional(),
  items: z.array(serviceSlot).min(2).max(8),
  /** A photo of the place or the work for the whole section. */
  image: imageSlot.optional(),
  action: linkSlot.optional(),
  /** One practical line for every service: what the price includes, how to pay. */
  note: line(140).optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const SERVICES_EXAMPLE = {
  title: "Чем можно заняться в мастерской",
  intro:
    "Занятия идут в группах до шести человек. Глина, глазурь и обжиг входят в стоимость каждого формата.",
  items: [
    {
      title: "Пробное занятие",
      text: "Два часа на круге с мастером: центровка, первый цилиндр и простая чашка.",
      price: "2 500 ₽",
      duration: "2 часа",
      points: ["Глина и фартук на месте", "Чашку можно забрать через две недели"],
      image: {
        src: "/_wizard/photos/example-wheel.webp",
        alt: "Гончарный круг с заготовкой из красной глины",
      },
      link: { label: "Записаться на пробное", href: "#form" },
    },
    {
      title: "Курс «Круг с нуля»",
      text: "Восемь занятий по вечерам: от центровки до сервиза из четырёх чашек.",
      price: "18 000 ₽",
      duration: "8 занятий",
      points: ["Один вечер в неделю", "Свой круг на всё занятие", "Обжиг всех работ курса"],
      image: { src: "/_wizard/photos/example-cups.webp", alt: "Чашки после обжига на деревянной полке" },
      link: { label: "Смотреть программу курса", href: "/courses/wheel" },
    },
    {
      title: "Ручная лепка",
      text: "Тарелки, вазы и подсвечники без круга: пласт, жгут и щипковая техника.",
      price: "2 200 ₽",
      duration: "2,5 часа",
      image: {
        src: "/_wizard/photos/example-handbuilding.webp",
        alt: "Ладони раскатывают пласт глины скалкой",
      },
    },
    {
      title: "Глазурование",
      text: "Покрываем готовые изделия глазурью и отправляем во второй обжиг.",
      price: "1 200 ₽",
      duration: "1,5 часа",
      image: { src: "/_wizard/photos/example-glaze.webp", alt: "Кисть наносит голубую глазурь на тарелку" },
    },
    {
      title: "Свидание за кругом",
      text: "Занятие для двоих: один круг, мастер рядом, чай и две чашки на память.",
      price: "6 000 ₽",
      duration: "2 часа",
      image: { src: "/_wizard/photos/example-date.webp", alt: "Двое работают за одним гончарным кругом" },
    },
  ],
  image: {
    src: "/_wizard/photos/example-studio.webp",
    alt: "Светлый зал мастерской с гончарными кругами у окна",
  },
  action: { label: "Выбрать занятие", href: "#form" },
  note: "Оплатить можно картой на сайте или на месте",
} satisfies z.input<typeof servicesSlots>;

/** Preview content of the numbered variant: a real order — the modules of one course (catalog L05). */
export const SERVICES_PROGRAM_EXAMPLE = {
  title: "Программа курса «Круг с нуля»",
  intro:
    "Восемь вечерних занятий по два часа. Каждый модуль опирается на предыдущий, поэтому идём по порядку.",
  items: [
    {
      title: "Центровка и цилиндр",
      text: "Учимся садиться за круг, центровать глину и поднимать стенки.",
      duration: "2 занятия",
    },
    {
      title: "Чашка с ручкой",
      text: "Формуем чашку, подрезаем дно и лепим ручку.",
      duration: "2 занятия",
    },
    {
      title: "Тарелка и пиала",
      text: "Работаем с широкими формами и тонкими краями.",
      duration: "2 занятия",
    },
    {
      title: "Глазурь и обжиг",
      text: "Выбираем глазури, покрываем сервиз и отправляем во второй обжиг.",
      duration: "2 занятия",
    },
  ],
  action: { label: "Записаться на курс", href: "#form" },
  note: "Курс стоит 18 000 ₽, глина и обжиг включены",
} satisfies z.input<typeof servicesSlots>;

const at = import.meta.url;
const base = servicesSlots.pick({ title: true, intro: true, action: true, note: true });

export const SERVICES_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof PriceList>()(at, "services", {
    variant: "price-list",
    layout: "list",
    title: "Прайс-лист между линейками: название с описанием, длительность и цена цифрами одной ширины",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(2).max(8) }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
  definePattern<typeof SplitMedia>()(at, "services", {
    variant: "split-media",
    layout: "split",
    title: "Сплит: заголовок и фото места закреплены слева, справа услуги с составом и ценой",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(2).max(6), image: imageSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
  definePattern<typeof Numbered>()(at, "services", {
    variant: "numbered",
    layout: "columns",
    title:
      "Программа по порядку: модули или этапы колонками с крупными номерами — только при реальном порядке",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(3).max(6) }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_PROGRAM_EXAMPLE,
  }),
  definePattern<typeof Bento>()(at, "services", {
    variant: "bento",
    layout: "grid",
    title:
      "Бенто: главная услуга с фото в большой ячейке, остальные в ячейках разного размера и тона без дыр",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(3).max(6) }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
  definePattern<typeof Tabs>()(at, "services", {
    variant: "tabs",
    layout: "panel",
    title:
      "Вкладки: список услуг слева (на телефоне лентой), справа панель выбранной с фото, составом и ценой",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(2).max(6) }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
  definePattern<typeof Editorial>()(at, "services", {
    variant: "editorial",
    layout: "editorial",
    title: "Журнальные строки: названия услуг крупным начертанием, справа описание, цена и ссылка",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(2).max(6) }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
  definePattern<typeof Dominant>()(at, "services", {
    variant: "dominant",
    layout: "asymmetric",
    title: "Доминанта: главная услуга крупно с фото и составом, остальные коротким списком сбоку",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(3).max(7) }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
  definePattern<typeof Poster>()(at, "services", {
    variant: "poster",
    layout: "typographic",
    title: "Типографский указатель: названия услуг крупным набором в строку, цены мелко у названий",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(3).max(8) }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
  definePattern<typeof Staggered>()(at, "services", {
    variant: "staggered",
    layout: "card",
    title: "Карточки с фото в две колонки со сдвигом правой колонки вниз, название и цена под фото",
    archetypes: ["*"],
    slots: base.extend({
      items: z
        .array(serviceSlot.extend({ image: imageSlot }))
        .min(2)
        .max(6),
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
  definePattern<typeof PhotoMenu>()(at, "services", {
    variant: "photo-menu",
    layout: "full-bleed",
    title: "Меню поверх фото: фото во всю секцию, сбоку плотная карточка-прайс с отточиями до цены",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(serviceSlot).min(3).max(8), image: imageSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: SERVICES_EXAMPLE,
  }),
];
