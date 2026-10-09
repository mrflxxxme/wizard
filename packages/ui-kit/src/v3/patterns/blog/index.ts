// Blog patterns (V3-08, needs content): lists of posts, news or materials over useContent (@wizard/ui-kit/v3/headless,
// C4) — what the role may read, newest first, «Показать ещё». Titles, dates, announcements and covers come only from the
// data (a post entity added by an extension op); dates are formatted in Russian.
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, para, SAME_ORIGIN_PATH_RE } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Archive from "./archive.js";
import type Band from "./band.js";
import type Cards from "./cards.js";
import type Editorial from "./editorial.js";
import type Featured from "./featured.js";
import type List from "./list.js";
import type Magazine from "./magazine.js";
import type Split from "./split.js";

/** Entity and field names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности или поля латиницей");

/** Everything a list of posts may show; each variant picks what it renders. */
export const blogSlots = z.object({
  /** Entity of the posts (publicFront.actions[].entity of useContent; default post). */
  entity: ident.optional(),
  /** Field names of a post (default: title, published_at, excerpt, cover, slug). */
  fields: z
    .object({
      title: ident.optional(),
      date: ident.optional(),
      excerpt: ident.optional(),
      cover: ident.optional(),
      slug: ident.optional(),
    })
    .optional(),
  /** Page of a post: the path gets the slug (or the id) of the post; without it the posts are not links. */
  path: z.string().regex(SAME_ORIGIN_PATH_RE, "путь страницы системы").optional(),
  title: line(80),
  text: para(260).optional(),
  /** What an empty list says, calmly and without invented posts. */
  empty: line(120).optional(),
  /** Posts per «Показать ещё». */
  pageSize: z.number().int().min(3).max(24).optional(),
  /** One action of the section, e.g. all posts (catalog K09). */
  action: linkSlot.optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const BLOG_EXAMPLE = {
  entity: "post",
  path: "/blog/",
  title: "Заметки мастерской",
  text: "Рассказываем о глине, глазурях и о том, что происходит в мастерской.",
  empty: "Первые заметки скоро появятся",
  pageSize: 4,
  action: { label: "Все заметки", href: "/blog" },
} satisfies z.input<typeof blogSlots>;

const at = import.meta.url;
const base = blogSlots.pick({
  entity: true,
  fields: true,
  path: true,
  title: true,
  text: true,
  empty: true,
  pageSize: true,
  action: true,
});

export const BLOG_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof List>()(at, "blog", {
    variant: "list",
    layout: "list",
    title: "Список между линейками: дата в своей колонке, заголовок-ссылка и анонс; «Показать ещё»",
    archetypes: ["*"],
    slots: base,
    needs: "content",
    license: "own",
    origin: "own",
    example: BLOG_EXAMPLE,
  }),
  definePattern<typeof Cards>()(at, "blog", {
    variant: "cards",
    layout: "grid",
    title:
      "Открытые карточки сеткой: обложка, дата, заголовок и анонс; без обложки — дата крупно на её месте",
    archetypes: ["*"],
    slots: base,
    needs: "content",
    license: "MIT",
    origin: "hyperui",
    example: { ...BLOG_EXAMPLE, pageSize: 6 },
  }),
  definePattern<typeof Featured>()(at, "blog", {
    variant: "featured",
    layout: "asymmetric",
    title: "Свежая запись крупно с широкой обложкой слева, следующие списком с маленькими обложками справа",
    archetypes: ["*"],
    slots: base,
    needs: "content",
    license: "own",
    origin: "own",
    example: { ...BLOG_EXAMPLE, pageSize: 5 },
  }),
  definePattern<typeof Magazine>()(at, "blog", {
    variant: "magazine",
    layout: "collage",
    title: "Журнальный коллаж: свежая запись большой плиткой с заголовком на подложке, остальные малыми",
    archetypes: ["*"],
    slots: base,
    needs: "content",
    license: "own",
    origin: "own",
    example: { ...BLOG_EXAMPLE, pageSize: 5 },
  }),
  definePattern<typeof Archive>()(at, "blog", {
    variant: "archive",
    layout: "columns",
    title: "Компактный указатель без картинок: записи по месяцам в колонках, строки «день — заголовок»",
    archetypes: ["*"],
    slots: base,
    needs: "content",
    license: "own",
    origin: "own",
    example: { ...BLOG_EXAMPLE, pageSize: 9 },
  }),
  definePattern<typeof Editorial>()(at, "blog", {
    variant: "editorial",
    layout: "editorial",
    title: "Типографская полоса: записи между жирными линейками, крупный заголовок слева и анонс справа",
    archetypes: ["*"],
    slots: base,
    needs: "content",
    license: "own",
    origin: "own",
    example: { ...BLOG_EXAMPLE, pageSize: 3 },
  }),
  definePattern<typeof Split>()(at, "blog", {
    variant: "split",
    layout: "split",
    title: "Заголовок и действие слева (остаются на виду), справа записи карточками-строками с обложкой",
    archetypes: ["*"],
    slots: base,
    needs: "content",
    license: "own",
    origin: "own",
    example: BLOG_EXAMPLE,
  }),
  definePattern<typeof Band>()(at, "blog", {
    variant: "band",
    layout: "band",
    title:
      "Тонированная полоса с лентой карточек записей, листается пальцем или стрелками, без автопрокрутки",
    archetypes: ["*"],
    slots: base,
    needs: "content",
    license: "own",
    origin: "own",
    example: { ...BLOG_EXAMPLE, pageSize: 6 },
  }),
];
