// FAQ patterns (V3-08): nine compositions of questions and answers over one slot schema — a centred accordion, a
// sticky side heading, two columns, category tabs, groups, an open grid, a contrasting band, cards and large type.
// Disclosures are native details/summary or buttons with aria-expanded and aria-controls, keyboard operable; questions
// are the real objections of the interview (catalog D1 FAQ), answers come from the brief.
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Accordion from "./accordion.js";
import type Cards from "./cards.js";
import type Grouped from "./grouped.js";
import type InverseBand from "./inverse-band.js";
import type OpenGrid from "./open-grid.js";
import type StickySide from "./sticky-side.js";
import type Tabs from "./tabs.js";
import type TwoColumn from "./two-column.js";
import type Typographic from "./typographic.js";

/** A question in the customer's words and the answer of the brief. */
export const qaSlot = z.object({ q: line(160), a: para(800) });
const groupSlot = z.object({ title: line(40), items: z.array(qaSlot).min(1).max(8) });

/** Everything an FAQ section may show; each variant picks what it renders. */
export const faqSlots = z.object({
  title: line(80),
  intro: para(240).optional(),
  items: z.array(qaSlot).min(2).max(16),
  /** The same questions by topic, for the variants with categories. */
  groups: z.array(groupSlot).min(2).max(5).optional(),
  /** What to do when the answer is not here. */
  contactText: line(120).optional(),
  /** A direct channel for that: messenger, phone or the form. */
  contact: linkSlot.optional(),
});

const QA = {
  experience: {
    q: "Нужен ли опыт, чтобы прийти на пробное занятие?",
    a: "Нет. Пробное рассчитано на тех, кто садится за круг впервые: мастер покажет центровку и будет рядом всё занятие.",
  },
  bring: {
    q: "Что взять с собой?",
    a: "Удобную одежду, которую не жалко испачкать, и резинку для волос. Фартуки, глину и инструменты выдаём на месте.",
  },
  kids: {
    q: "Можно ли прийти с ребёнком?",
    a: "Принимаем детей с двенадцати лет вместе со взрослым. Отдельных детских групп пока нет.",
  },
  reschedule: {
    q: "Можно ли перенести занятие?",
    a: "Да, если написать нам не позже чем за сутки. Перенести запись можно один раз, новое время выберете в расписании.",
  },
  pay: {
    q: "Как оплатить?",
    a: "Картой на сайте при записи или на месте перед занятием. Для компаний выставляем счёт.",
  },
  ready: {
    q: "Когда можно забрать изделие?",
    a: "Через две недели: изделие сохнет, проходит первый обжиг, глазурь и второй обжиг. Напишем в Telegram, когда всё будет готово.",
  },
  dishwasher: {
    q: "Можно ли мыть посуду в посудомоечной машине?",
    a: "Да, глазури у нас пищевые и выдерживают посудомоечную машину. В микроволновке можно греть всё, кроме изделий с золотой люстрой.",
  },
};

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const FAQ_EXAMPLE = {
  title: "Вопросы перед первым занятием",
  intro: "Собрали то, о чём спрашивают чаще всего, когда записываются впервые.",
  items: [QA.experience, QA.bring, QA.ready, QA.reschedule, QA.pay, QA.kids],
  groups: [
    { title: "Занятия", items: [QA.experience, QA.bring, QA.kids] },
    { title: "Запись и оплата", items: [QA.reschedule, QA.pay] },
    { title: "Готовые изделия", items: [QA.ready, QA.dishwasher] },
  ],
  contactText: "Не нашли ответ? Напишите нам, ответим в течение дня.",
  contact: { label: "Написать в Telegram", href: "https://t.me/example" },
} satisfies z.input<typeof faqSlots>;

const at = import.meta.url;
const base = faqSlots.pick({ title: true, intro: true, contactText: true, contact: true });

export const FAQ_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Accordion>()(at, "faq", {
    variant: "accordion",
    layout: "centered",
    title: "Аккордеон по центру: заголовок по оси, вопросы узкой колонкой, открыт один ответ за раз",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(qaSlot).min(2).max(12) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
  definePattern<typeof StickySide>()(at, "faq", {
    variant: "sticky-side",
    layout: "split",
    title: "Заголовок и карточка «не нашли ответ» закреплены слева, справа аккордеон",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(qaSlot).min(3).max(16) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
  definePattern<typeof TwoColumn>()(at, "faq", {
    variant: "two-column",
    layout: "columns",
    title: "Две колонки вопросов-раскрывашек под заголовком, на телефоне одна",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(qaSlot).min(4).max(16) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
  definePattern<typeof Tabs>()(at, "faq", {
    variant: "tabs",
    layout: "panel",
    title: "Категории вкладками-переключателем, под ними вопросы выбранной категории",
    archetypes: ["*"],
    slots: base.extend({ groups: z.array(groupSlot).min(2).max(5) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
  definePattern<typeof Grouped>()(at, "faq", {
    variant: "grouped",
    layout: "list",
    title: "По темам: название темы слева, её вопросы справа, темы разделены толстой линейкой",
    archetypes: ["*"],
    slots: base.extend({ groups: z.array(groupSlot).min(2).max(5) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
  definePattern<typeof OpenGrid>()(at, "faq", {
    variant: "open-grid",
    layout: "grid",
    title: "Все ответы открыты: сетка в две колонки из вопросов-подзаголовков и коротких ответов",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(qaSlot).min(2).max(8) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
  definePattern<typeof InverseBand>()(at, "faq", {
    variant: "inverse-band",
    layout: "band",
    title: "Контрастная полоса: заголовок и связь слева, аккордеон справа",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(qaSlot).min(2).max(12) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
  definePattern<typeof Cards>()(at, "faq", {
    variant: "cards",
    layout: "card",
    title: "Каждый вопрос — отдельная карточка-раскрывашка в две колонки, ответ появляется мягко",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(qaSlot).min(2).max(12) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
  definePattern<typeof Typographic>()(at, "faq", {
    variant: "typographic",
    layout: "typographic",
    title: "Крупный набор: вопросы начертанием заголовков между толстыми линейками, ответы под ними",
    archetypes: ["*"],
    slots: base.extend({ items: z.array(qaSlot).min(2).max(8) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FAQ_EXAMPLE,
  }),
];
