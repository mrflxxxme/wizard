// About patterns (V3-08): ten compositions of the story of the business over one slot schema — a letter from the
// owner, a magazine spread, facts, a timeline, the owner's quote, a collage, principles, a full-bleed photo, a
// centred manifesto and a contrasting panel. Facts, dates, people and numbers come only from the brief (D49).
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Centered from "./centered.js";
import type Collage from "./collage.js";
import type Editorial from "./editorial.js";
import type Facts from "./facts.js";
import type FullBleed from "./full-bleed.js";
import type InversePanel from "./inverse-panel.js";
import type Quote from "./quote.js";
import type SplitLetter from "./split-letter.js";
import type Timeline from "./timeline.js";
import type Values from "./values.js";

/** A fact of the brief: the value large and what it means («6» — «гончарных кругов в зале»). */
const factSlot = z.object({ value: line(24), label: line(80) });

/** Everything an about section may show; each variant picks what it renders. */
export const aboutSlots = z.object({
  title: line(90),
  /** The first thing to know, one or two sentences. */
  lead: para(320).optional(),
  /** The story in the owner's words, 1–4 paragraphs. */
  paragraphs: z.array(para(600)).min(1).max(4),
  image: imageSlot.optional(),
  images: z.array(imageSlot).min(2).max(3).optional(),
  caption: line(120).optional(),
  /** Only facts the owner confirmed (D49): no years of experience or client counts made up for the layout. */
  facts: z.array(factSlot).min(2).max(4).optional(),
  /** The owner's own words with their real name. */
  quote: z
    .object({ text: para(300), author: line(80), role: line(80).optional(), photo: imageSlot.optional() })
    .optional(),
  /** How the work is done, 2–4 principles. */
  values: z
    .array(z.object({ title: line(60), text: para(220) }))
    .min(2)
    .max(4)
    .optional(),
  /** Dates of the brief: opening, moves, new formats. */
  milestones: z
    .array(z.object({ when: line(24), text: line(160) }))
    .min(2)
    .max(6)
    .optional(),
  /** Who signs the story. */
  signature: z.object({ name: line(80), role: line(80).optional() }).optional(),
  action: linkSlot.optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const ABOUT_EXAMPLE = {
  title: "Мастерская на Гончарной, 12",
  lead: "«Обжиг» занимает второй этаж бывшей типографии: высокие потолки, окна во всю стену и отдельная комната для печи.",
  paragraphs: [
    "Занятия ведут два мастера. Мы показываем всё с самого начала и остаёмся рядом, пока у вас не получится первая вещь, которую не стыдно поставить на стол.",
    "Изделия сушим и обжигаем у себя, поэтому знаем, что происходит с каждой чашкой. Готовую посуду можно забрать через две недели или заказать доставку курьером по Москве.",
  ],
  image: {
    src: "/_wizard/photos/example-studio.webp",
    alt: "Светлый зал мастерской с гончарными кругами у окна",
  },
  images: [
    { src: "/_wizard/photos/example-studio.webp", alt: "Светлый зал мастерской с гончарными кругами у окна" },
    { src: "/_wizard/photos/example-kiln.webp", alt: "Открытая печь для обжига с полками из шамота" },
    { src: "/_wizard/photos/example-shelf.webp", alt: "Полка с высыхающими чашками и тарелками" },
  ],
  caption: "Зал на втором этаже: шесть кругов и большой стол для лепки",
  facts: [
    { value: "6", label: "гончарных кругов в зале" },
    { value: "до 6", label: "человек в группе, чтобы мастер успевал к каждому" },
    { value: "2 недели", label: "от занятия до готовой посуды после обжига" },
  ],
  quote: {
    text: "Хочется, чтобы человек ушёл с чашкой, из которой правда будет пить по утрам.",
    author: "Анна Соколова",
    role: "основательница мастерской",
    photo: { src: "/_wizard/photos/example-anna.webp", alt: "Анна Соколова за гончарным кругом" },
  },
  values: [
    {
      title: "Без спешки",
      text: "Мастер не торопит: на пробном занятии хватает времени, чтобы довести одну вещь до конца.",
    },
    {
      title: "Своя печь",
      text: "Обжигаем на месте и сами следим за каждой загрузкой, поэтому изделия не теряются.",
    },
    {
      title: "Маленькие группы",
      text: "До шести человек за кругами, чтобы мастер успел подойти к каждому и поправить руки.",
    },
  ],
  milestones: [
    { when: "2019", text: "Открыли мастерскую с двумя кругами в подвале на Таганке" },
    { when: "2021", text: "Переехали на Гончарную и поставили свою печь для обжига" },
    { when: "2023", text: "Запустили вечерний курс «Круг с нуля» из восьми занятий" },
    { when: "2025", text: "Добавили занятия по ручной лепке и глазурованию" },
  ],
  signature: { name: "Анна Соколова", role: "основательница мастерской" },
  action: { label: "Записаться на пробное", href: "#form" },
} satisfies z.input<typeof aboutSlots>;

const at = import.meta.url;
const base = aboutSlots.pick({ title: true, lead: true, paragraphs: true, action: true });

export const ABOUT_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof SplitLetter>()(at, "about", {
    variant: "split-letter",
    layout: "split",
    title: "Письмо владельца: фото с подписью слева, справа заголовок, история и подпись с именем",
    archetypes: ["*"],
    slots: base.extend({
      image: imageSlot,
      caption: line(120).optional(),
      signature: aboutSlots.shape.signature,
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof Editorial>()(at, "about", {
    variant: "editorial",
    layout: "editorial",
    title: "Журнальный разворот: крупный заголовок, под линейкой широкое фото с подписью и текст с буквицей",
    archetypes: ["*"],
    slots: base.extend({ image: imageSlot, caption: line(120).optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof Facts>()(at, "about", {
    variant: "facts",
    layout: "band",
    title:
      "Тонированная полоса: заголовок и лид, строка из 2–4 фактов брифа крупными цифрами, текст в две колонки",
    archetypes: ["*"],
    slots: base.extend({ facts: z.array(factSlot).min(2).max(4) }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof Timeline>()(at, "about", {
    variant: "timeline",
    layout: "list",
    title:
      "История по датам: заголовок и текст закреплены слева, справа вертикальная линия с вехами из брифа",
    archetypes: ["*"],
    slots: base.extend({ milestones: aboutSlots.shape.milestones.unwrap() }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof Quote>()(at, "about", {
    variant: "quote",
    layout: "typographic",
    title: "Слова владельца крупным набором с именем и фото, под линейкой история в две колонки",
    archetypes: ["*"],
    slots: base.extend({ quote: aboutSlots.shape.quote.unwrap() }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof Collage>()(at, "about", {
    variant: "collage",
    layout: "collage",
    title: "Текст слева, справа коллаж из 2–3 фото места разного формата со сдвигом",
    archetypes: ["*"],
    slots: base.extend({ images: z.array(imageSlot).min(2).max(3) }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof Values>()(at, "about", {
    variant: "values",
    layout: "columns",
    title: "Принципы работы: заголовок и лид, 2–4 колонки с вертикальными линейками",
    archetypes: ["*"],
    slots: base.omit({ paragraphs: true }).extend({ values: aboutSlots.shape.values.unwrap() }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof FullBleed>()(at, "about", {
    variant: "full-bleed",
    layout: "full-bleed",
    title: "Фото во всю ширину с заголовком на затемнённой плашке, под ним история и факты",
    archetypes: ["*"],
    slots: base.extend({ image: imageSlot, facts: z.array(factSlot).min(2).max(4).optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof Centered>()(at, "about", {
    variant: "centered",
    layout: "centered",
    title: "Манифест по центру: заголовок, лид, короткий текст и подпись, широкое фото ниже по желанию",
    archetypes: ["*"],
    slots: base.extend({ signature: aboutSlots.shape.signature, image: imageSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
  definePattern<typeof InversePanel>()(at, "about", {
    variant: "inverse-panel",
    layout: "panel",
    title: "Контрастная панель: история слева, справа столбец фактов между линейками",
    archetypes: ["*"],
    slots: base.extend({ facts: z.array(factSlot).min(2).max(4) }),
    needs: null,
    license: "own",
    origin: "own",
    example: ABOUT_EXAMPLE,
  }),
];
