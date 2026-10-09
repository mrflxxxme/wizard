// Gallery patterns (V3-08): nine compositions over one slot schema. Photos only from the system's storage (the
// client's work or stock downloaded to it), every one with a meaningful alt; nothing scrolls by itself, the lightbox
// is a modal dialog with a named close button, Esc and focus return (catalog D1 Gallery, A08, I08, M06).
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Bento from "./bento.js";
import type Captioned from "./captioned.js";
import type Editorial from "./editorial.js";
import type Filmstrip from "./filmstrip.js";
import type FullBleed from "./full-bleed.js";
import type Grid from "./grid.js";
import type Lightbox from "./lightbox.js";
import type Masonry from "./masonry.js";
import type Split from "./split.js";

/** A photo of the gallery: alt is required (imageSlot), the caption says what, who or when when it matters. */
export const galleryImageSlot = imageSlot.extend({ caption: line(120).optional() });

/** Everything a gallery may show; each variant picks what it renders. */
export const gallerySlots = z.object({
  title: line(80),
  lead: para(240).optional(),
  images: z.array(galleryImageSlot).min(2).max(24),
  /** The next step: the full portfolio, the catalogue or a booking. */
  action: linkSlot.optional(),
});

const IMAGES = [
  {
    src: "/_wizard/photos/example-cups.webp",
    alt: "Шесть чашек с голубой глазурью на деревянной полке",
    caption: "Чашки группы выходного дня после второго обжига",
  },
  {
    src: "/_wizard/photos/example-wheel.webp",
    alt: "Руки мастера вытягивают стенки цилиндра на гончарном круге",
    caption: "Вытягивание стенок: третье занятие курса",
  },
  {
    src: "/_wizard/photos/example-bowls.webp",
    alt: "Стопка глубоких мисок с неровным краем",
    caption: "Миски, которые ученики делают на пробном занятии",
  },
  {
    src: "/_wizard/photos/example-studio.webp",
    alt: "Светлый зал мастерской с шестью гончарными кругами у окна",
    caption: "Зал на Гончарной, второй этаж",
  },
  {
    src: "/_wizard/photos/example-glaze.webp",
    alt: "Кисть наносит голубую глазурь на край тарелки",
    caption: "Глазуровка: оттенки подбираем вместе",
  },
  {
    src: "/_wizard/photos/example-kiln.webp",
    alt: "Открытая муфельная печь с изделиями на полках",
    caption: "Печь на сто литров, обжиг по средам",
  },
  {
    src: "/_wizard/photos/example-vase.webp",
    alt: "Высокая ваза с потёками зелёной глазури",
    caption: "Ваза ученицы после восьми занятий",
  },
  {
    src: "/_wizard/photos/example-plates.webp",
    alt: "Тарелки с отпечатками листьев сохнут на доске",
    caption: "Тарелки с оттиском листьев перед обжигом",
  },
];

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const GALLERY_EXAMPLE = {
  title: "Работы учеников и наш зал",
  lead: "Всё на фото слеплено на занятиях в мастерской. Снимали сами, без обработки.",
  images: IMAGES,
  action: { label: "Записаться на пробное занятие", href: "#form" },
} satisfies z.input<typeof gallerySlots>;

const at = import.meta.url;
const head = gallerySlots.pick({ title: true, lead: true, action: true });
const images = (min: number, max: number) => z.array(galleryImageSlot).min(min).max(max);
/** The example with the first `n` photos, for variants made for a few. */
const first = (n: number) => ({ ...GALLERY_EXAMPLE, images: IMAGES.slice(0, n) });

export const GALLERY_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Grid>()(at, "gallery", {
    variant: "grid",
    layout: "grid",
    title: "Ровная сетка 2–3 колонки с подписями под фото",
    archetypes: ["*"],
    slots: head.extend({ images: images(3, 24) }),
    needs: null,
    license: "own",
    origin: "own",
    example: first(6),
  }),
  definePattern<typeof Masonry>()(at, "gallery", {
    variant: "masonry",
    layout: "columns",
    title: "Кладка в 2–3 колонки: высокие и широкие кадры вперемешку, подписи под фото",
    archetypes: ["*"],
    slots: head.extend({ images: images(4, 24) }),
    needs: null,
    license: "own",
    origin: "own",
    example: GALLERY_EXAMPLE,
  }),
  definePattern<typeof Editorial>()(at, "gallery", {
    variant: "editorial",
    layout: "editorial",
    title: "Журнальная раскладка: большой кадр на семь колонок, два рядом, остальные рядом ниже без дыр",
    archetypes: ["*"],
    slots: head.extend({ images: images(3, 9) }),
    needs: null,
    license: "own",
    origin: "own",
    example: first(7),
  }),
  definePattern<typeof Filmstrip>()(at, "gallery", {
    variant: "filmstrip",
    layout: "band",
    title: "Лента фото во всю ширину: листается пальцем, клавишами и кнопками, без автопрокрутки",
    archetypes: ["*"],
    slots: head.extend({ images: images(3, 16) }),
    needs: null,
    license: "own",
    origin: "own",
    example: GALLERY_EXAMPLE,
  }),
  definePattern<typeof Lightbox>()(at, "gallery", {
    variant: "lightbox",
    layout: "collage",
    title: "Плотная сетка миниатюр, фото открывается крупно в окне с подписью и листанием",
    archetypes: ["*"],
    slots: head.extend({ images: images(4, 24) }),
    needs: null,
    license: "own",
    origin: "own",
    example: GALLERY_EXAMPLE,
  }),
  definePattern<typeof Split>()(at, "gallery", {
    variant: "split",
    layout: "split",
    title: "Текст и кнопка слева остаются на месте, справа фото в две колонки со сдвигом",
    archetypes: ["*"],
    slots: head.extend({ images: images(3, 8) }),
    needs: null,
    license: "own",
    origin: "own",
    example: first(6),
  }),
  definePattern<typeof FullBleed>()(at, "gallery", {
    variant: "full-bleed",
    layout: "full-bleed",
    title: "Кадры от края до края экрана: один широкий, под ним ряд из 1–3 без полей",
    archetypes: ["*"],
    slots: head.extend({ images: images(2, 4) }),
    needs: null,
    license: "own",
    origin: "own",
    example: first(4),
  }),
  definePattern<typeof Captioned>()(at, "gallery", {
    variant: "captioned",
    layout: "list",
    title: "Портфолио списком: крупное фото и подпись в узкой колонке, кадры между линейками",
    archetypes: ["*"],
    slots: head.extend({
      images: z
        .array(galleryImageSlot.extend({ caption: line(120) }))
        .min(2)
        .max(6),
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: first(4),
  }),
  definePattern<typeof Bento>()(at, "gallery", {
    variant: "bento",
    layout: "asymmetric",
    title: "Бенто из 3–6 кадров разного размера: ячеек ровно столько, сколько фото",
    archetypes: ["*"],
    slots: head.extend({ images: images(3, 6) }),
    needs: null,
    license: "own",
    origin: "own",
    example: first(5),
  }),
];
