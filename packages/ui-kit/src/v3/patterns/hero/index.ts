// First screen patterns (V3-08): eight compositions over one slot schema; ≤ 4 text elements and one main action
// in each (catalog D1 Hero, L13).
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Centered from "./centered.js";
import type Collage from "./collage.js";
import type Editorial from "./editorial.js";
import type EventPoster from "./event-poster.js";
import type FullBleed from "./full-bleed.js";
import type OfferCard from "./offer-card.js";
import type Split from "./split.js";
import type Typographic from "./typographic.js";

/** Everything a first screen may show; each variant picks what it renders. */
export const heroSlots = z.object({
  /** The offer with a fact (price, term or result), ≤ 90 characters (catalog T04, T05). */
  title: line(90),
  lead: para(260).optional(),
  action: linkSlot,
  secondary: linkSlot.optional(),
  /** One practical line from the brief (duration, group size, «от» with a real range). */
  note: line(120).optional(),
  image: imageSlot.optional(),
  images: z.array(imageSlot).min(2).max(3).optional(),
  /** Caption of the photo (editorial). */
  caption: line(120).optional(),
  /** The concrete offer: name, price and what is included — only facts of the brief (D49). */
  offer: z
    .object({ title: line(60), price: line(30).optional(), points: z.array(line(80)).max(4).optional() })
    .optional(),
  /** Date and time of an event. */
  when: line(60).optional(),
  /** Place of an event. */
  where: line(90).optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const HERO_EXAMPLE = {
  title: "Гончарные занятия для взрослых в центре Москвы",
  lead: "Учим работать на круге с нуля: от первого цилиндра до чашки, которую не стыдно подарить. Глина, глазурь и обжиг входят в стоимость.",
  action: { label: "Записаться на пробное", href: "#form" },
  secondary: { label: "Посмотреть расписание", href: "#schedule" },
  note: "Пробное занятие идёт 2 часа, в группе до шести человек",
  image: { src: "/_wizard/photos/example-hero.webp", alt: "Руки ученицы формуют чашку на гончарном круге" },
  images: [
    { src: "/_wizard/photos/example-wheel.webp", alt: "Гончарный круг с заготовкой из красной глины" },
    { src: "/_wizard/photos/example-cups.webp", alt: "Чашки после обжига на деревянной полке" },
    { src: "/_wizard/photos/example-glaze.webp", alt: "Кисть наносит голубую глазурь на тарелку" },
  ],
  caption: "Зал на Гончарной: шесть кругов и большой стол для лепки",
  offer: {
    title: "Пробное занятие",
    price: "2 500 ₽",
    points: [
      "Два часа на круге с мастером",
      "Глина, глазурь и обжиг включены",
      "Чашку можно забрать через две недели",
    ],
  },
  when: "Суббота, 12:00",
  where: "Москва, Гончарная, 12, второй этаж",
} satisfies z.input<typeof heroSlots>;

const at = import.meta.url;
const base = heroSlots.pick({ title: true, lead: true, action: true, secondary: true, note: true });

export const HERO_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Split>()(at, "hero", {
    variant: "split",
    layout: "split",
    title: "Сплит: оффер слева, фото справа; на телефоне текст, затем фото",
    archetypes: ["*"],
    slots: base.extend({ image: imageSlot }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: HERO_EXAMPLE,
  }),
  definePattern<typeof Centered>()(at, "hero", {
    variant: "centered",
    layout: "centered",
    title: "По центру: заголовок, подзаголовок и кнопки по оси, широкое фото ниже по желанию",
    archetypes: ["*"],
    slots: base.extend({ image: imageSlot.optional() }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: HERO_EXAMPLE,
  }),
  definePattern<typeof FullBleed>()(at, "hero", {
    variant: "full-bleed",
    layout: "full-bleed",
    title: "Фото во весь экран, оффер внизу слева на затемнённой плашке",
    archetypes: ["*"],
    slots: base.extend({ image: imageSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: HERO_EXAMPLE,
  }),
  definePattern<typeof Typographic>()(at, "hero", {
    variant: "typographic",
    layout: "typographic",
    title: "Типографский плакат без фото: крупный заголовок, линейка, текст слева и кнопки справа",
    archetypes: ["*"],
    slots: base,
    needs: null,
    license: "own",
    origin: "own",
    example: HERO_EXAMPLE,
  }),
  definePattern<typeof OfferCard>()(at, "hero", {
    variant: "offer-card",
    layout: "card",
    title: "Заголовок слева, справа карточка предложения с ценой, составом и кнопкой",
    archetypes: ["*"],
    slots: base.extend({ offer: heroSlots.shape.offer.unwrap() }),
    needs: null,
    license: "own",
    origin: "own",
    example: HERO_EXAMPLE,
  }),
  definePattern<typeof Collage>()(at, "hero", {
    variant: "collage",
    layout: "collage",
    title: "Оффер слева, справа коллаж из 2–3 фото со сдвигом; на телефоне одно фото",
    archetypes: ["*"],
    slots: base.omit({ note: true }).extend({ images: z.array(imageSlot).min(2).max(3) }),
    needs: null,
    license: "own",
    origin: "own",
    example: HERO_EXAMPLE,
  }),
  definePattern<typeof Editorial>()(at, "hero", {
    variant: "editorial",
    layout: "editorial",
    title: "Журнальный разворот: высокое фото с подписью слева, крупный заголовок и две колонки под линейкой",
    archetypes: ["*"],
    slots: base.extend({ image: imageSlot, caption: line(120).optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: HERO_EXAMPLE,
  }),
  definePattern<typeof EventPoster>()(at, "hero", {
    variant: "event-poster",
    layout: "typographic",
    title: "Афиша события: заголовок-плакат, крупно дата и место между линейками, кнопка рядом",
    archetypes: ["*"],
    slots: base.omit({ note: true }).extend({ when: line(60), where: line(90) }),
    needs: null,
    license: "own",
    origin: "own",
    example: HERO_EXAMPLE,
  }),
];
