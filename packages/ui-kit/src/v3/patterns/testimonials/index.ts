// Testimonials patterns (V3-08): nine compositions over one slot schema. Only real reviews the client provides
// (D49, 38-ФЗ): every review names its author, the source and date are shown when given, a rating only when the
// source has one; no invented counts, no stock faces (catalog D1 Proof, K02, K03, I02).
import { z } from "zod";
import { definePattern } from "../define.js";
import { HREF_RE, imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Carousel from "./carousel.js";
import type Editorial from "./editorial.js";
import type LargeQuote from "./large-quote.js";
import type Ledger from "./ledger.js";
import type PhotoQuote from "./photo-quote.js";
import type RatingSource from "./rating-source.js";
import type Strip from "./strip.js";
import type TwoColumn from "./two-column.js";
import type Wall from "./wall.js";

/** Stand-ins instead of a person (catalog K03, K04): «Довольный клиент», «Гость», «Иван Иванов». */
const STAND_IN_RE =
  /^(?:довольн[а-яё]*\s+)?(?:клиент|клиентка|покупатель|покупательница|гость|гостья|аноним|пользователь|посетитель|заказчик|заказчица)$|иван\s+иванов/i;

/** The author as the client gives it: a name or a name and the first letter of the surname («Мария С.»). */
export const reviewAuthor = line(60)
  .regex(/\p{L}{2}/u, "автор: имя человека")
  .refine((s) => !STAND_IN_RE.test(s.trim()), "автор: имя человека, а не «Довольный клиент»");

/** One real review: the words as written, who wrote it, where and when (catalog D1 Proof: name and source). */
export const reviewSlot = z.object({
  text: para(600),
  author: reviewAuthor,
  /** Context from the source or the client: «ходит на занятия с весны», «заказ на свадьбу». */
  detail: line(80).optional(),
  /** Where it was published: «Яндекс Карты», «2ГИС», «Telegram» — with a link to the original when there is one. */
  source: z
    .object({ label: line(40), href: z.string().regex(HREF_RE, "ссылка на отзыв: https://").optional() })
    .optional(),
  /** As given: «сентябрь 2026». */
  date: line(30).optional(),
  /** The rating the author gave on the source, only when it has one. */
  rating: z
    .object({ value: z.number().min(0).max(10), max: z.number().int().min(3).max(10) })
    .refine((r) => r.value <= r.max, "оценка не больше шкалы")
    .optional(),
});

/** The platform's own summary, copied with its date and a link (catalog D1 Proof «rating-link»). */
export const reviewSummarySlot = z.object({
  /** «4,9» exactly as the platform shows it. */
  value: line(8),
  /** «средняя оценка на Яндекс Картах». */
  label: line(80),
  /** «по 128 оценкам» — as the platform shows it. */
  count: line(40).optional(),
  /** When it was copied: «на 1 октября 2026». */
  date: line(40),
  source: linkSlot,
});

/** Everything a testimonials section may show; each variant picks what it renders. */
export const testimonialsSlots = z.object({
  title: line(80),
  lead: para(240).optional(),
  reviews: z.array(reviewSlot).min(1).max(12),
  /** One review set large (large quote, photo quote, editorial). */
  quote: reviewSlot.optional(),
  /** All reviews on the platform: a real page. */
  more: linkSlot.optional(),
  summary: reviewSummarySlot.optional(),
  /** The place or the work the reviews are about, the client's own photo; never a face standing in for an author. */
  image: imageSlot.optional(),
});

/**
 * Preview content (tests, previews): an example business with reviews invented for the preview only. It never
 * reaches a system: a site shows only the reviews its owner provides (D49).
 */
export const TESTIMONIALS_EXAMPLE = {
  title: "Что пишут ученики",
  lead: "Отзывы с Яндекс Карт и из нашего канала в Telegram. Публикуем с согласия авторов, без правок.",
  reviews: [
    {
      text: "Пришла на пробное занятие без всякого опыта. Через два часа у меня была кривоватая, но своя чашка, а через две недели я забрала её после обжига. Теперь хожу по субботам.",
      author: "Мария С.",
      detail: "ходит на занятия с весны",
      source: { label: "Яндекс Карты", href: "https://yandex.ru/maps/org/example/reviews/" },
      date: "сентябрь 2026",
      rating: { value: 5, max: 5 },
    },
    {
      text: "Подарила мужу сертификат на двоих. Мастер спокойно объясняет и не торопит, глины хватило на несколько попыток.",
      author: "Ольга",
      source: { label: "Telegram", href: "https://t.me/example" },
      date: "август 2026",
    },
    {
      text: "Удобно, что глазурь и обжиг уже в цене. Один минус: в субботу днём в зале шумно, если хочется тишины, приходите вечером в будни.",
      author: "Дмитрий К.",
      source: { label: "Яндекс Карты", href: "https://yandex.ru/maps/org/example/reviews/" },
      date: "июль 2026",
      rating: { value: 4, max: 5 },
    },
    {
      text: "Ходили с дочерью. Ей двенадцать, ей дали отдельный круг и объясняли всё как взрослой. Обе слепили по миске.",
      author: "Елена В.",
      detail: "занятие с ребёнком",
      source: { label: "Яндекс Карты", href: "https://yandex.ru/maps/org/example/reviews/" },
      date: "июнь 2026",
      rating: { value: 5, max: 5 },
    },
    {
      text: "Абонемента на восемь занятий хватило, чтобы перестать бояться круга. Тарелки пока выходят толстыми, но мастер показывает, как это исправить.",
      author: "Артём",
      source: { label: "Telegram", href: "https://t.me/example" },
      date: "май 2026",
    },
  ],
  quote: {
    text: "Я думала, что гончарный круг — это про талант. Оказалось, про терпение и хорошего мастера. За месяц я сделала сервиз на четверых, кривой ровно настолько, чтобы было видно, что он ручной.",
    author: "Анна Л.",
    detail: "абонемент на восемь занятий",
    source: { label: "Яндекс Карты", href: "https://yandex.ru/maps/org/example/reviews/" },
    date: "сентябрь 2026",
  },
  more: { label: "Все отзывы на Яндекс Картах", href: "https://yandex.ru/maps/org/example/reviews/" },
  summary: {
    value: "4,9",
    label: "средняя оценка на Яндекс Картах",
    count: "по 128 оценкам",
    date: "на 1 октября 2026",
    source: { label: "Открыть отзывы", href: "https://yandex.ru/maps/org/example/reviews/" },
  },
  image: {
    src: "/_wizard/photos/example-shelf.webp",
    alt: "Полка с чашками и мисками учеников после обжига",
  },
} satisfies z.input<typeof testimonialsSlots>;

const at = import.meta.url;
/** The example with the three first reviews, for the variants that set a few reviews beside a large element. */
const FEW = { ...TESTIMONIALS_EXAMPLE, reviews: TESTIMONIALS_EXAMPLE.reviews.slice(0, 3) };
const head = testimonialsSlots.pick({ title: true, lead: true });

export const TESTIMONIALS_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Wall>()(at, "testimonials", {
    variant: "wall",
    layout: "grid",
    title: "Стена отзывов разной длины в 1–3 колонках без рваной сетки, ссылка на все отзывы внизу",
    archetypes: ["*"],
    slots: head.extend({ reviews: z.array(reviewSlot).min(3).max(9), more: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: TESTIMONIALS_EXAMPLE,
  }),
  definePattern<typeof LargeQuote>()(at, "testimonials", {
    variant: "large-quote",
    layout: "typographic",
    title: "Один отзыв крупным кеглем с кавычкой-ёлочкой, имя и источник под линейкой",
    archetypes: ["*"],
    slots: testimonialsSlots.pick({ title: true }).extend({ quote: reviewSlot, more: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: TESTIMONIALS_EXAMPLE,
  }),
  definePattern<typeof Carousel>()(at, "testimonials", {
    variant: "carousel",
    layout: "centered",
    title: "Отзывы по одному по центру, листаются кнопками «назад» и «вперёд» без автопрокрутки",
    archetypes: ["*"],
    slots: head.extend({ reviews: z.array(reviewSlot).min(2).max(12), more: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: TESTIMONIALS_EXAMPLE,
  }),
  definePattern<typeof TwoColumn>()(at, "testimonials", {
    variant: "two-column",
    layout: "split",
    title: "Слева заголовок и площадки, где собраны отзывы, справа отзывы между линейками",
    archetypes: ["*"],
    slots: head.extend({ reviews: z.array(reviewSlot).min(2).max(6), more: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: TESTIMONIALS_EXAMPLE,
  }),
  definePattern<typeof RatingSource>()(at, "testimonials", {
    variant: "rating-source",
    layout: "asymmetric",
    title: "Оценка площадки крупно с датой и ссылкой, рядом 1–3 отзыва оттуда же",
    archetypes: ["*"],
    slots: head.extend({ summary: reviewSummarySlot, reviews: z.array(reviewSlot).min(1).max(3) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FEW,
  }),
  definePattern<typeof Editorial>()(at, "testimonials", {
    variant: "editorial",
    layout: "editorial",
    title: "Журнальная полоса: главный отзыв крупно слева, ещё два узкой колонкой справа",
    archetypes: ["*"],
    slots: head.extend({ quote: reviewSlot, reviews: z.array(reviewSlot).min(1).max(3) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FEW,
  }),
  definePattern<typeof PhotoQuote>()(at, "testimonials", {
    variant: "photo-quote",
    layout: "full-bleed",
    title: "Фото работ или места на всю ширину, отзыв на затемнённой плашке поверх",
    archetypes: ["*"],
    slots: testimonialsSlots.pick({ title: true }).extend({ quote: reviewSlot, image: imageSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: TESTIMONIALS_EXAMPLE,
  }),
  definePattern<typeof Ledger>()(at, "testimonials", {
    variant: "ledger",
    layout: "list",
    title: "Реестр: слева автор, дата и площадка, справа текст отзыва, строки между линейками",
    archetypes: ["*"],
    slots: head.extend({ reviews: z.array(reviewSlot).min(2).max(8), more: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: TESTIMONIALS_EXAMPLE,
  }),
  definePattern<typeof Strip>()(at, "testimonials", {
    variant: "strip",
    layout: "band",
    title: "Тонированная полоса с лентой карточек-отзывов: листается пальцем, клавишами и кнопками",
    archetypes: ["*"],
    slots: head.extend({ reviews: z.array(reviewSlot).min(3).max(12), more: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: TESTIMONIALS_EXAMPLE,
  }),
];
