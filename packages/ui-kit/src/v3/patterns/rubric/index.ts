// Rubric patterns (V3-24 «Контент и блог», needs content): the posts of the rubric named by the address (a rubric page)
// or every post (the list of the blog) with the row of rubric links, over useRubric (@wizard/ui-kit/v3/headless, C4):
// what the role may read, newest first, «Показать ещё». The heading is the rubric's name and description from the data;
// level 1 makes the section the heading of its page.
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, para, SAME_ORIGIN_PATH_RE } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Cards from "./cards.js";
import type List from "./list.js";
import type Split from "./split.js";

/** Entity and field names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности или поля латиницей");
const pathSlot = z.string().regex(SAME_ORIGIN_PATH_RE, "путь страницы системы");

export const rubricSlots = z.object({
  /** Entity of the posts (default article). */
  entity: ident.optional(),
  /** Field names of a post (default: title, published_at, excerpt, cover, slug, rubric). */
  fields: z
    .object({
      title: ident.optional(),
      date: ident.optional(),
      excerpt: ident.optional(),
      cover: ident.optional(),
      slug: ident.optional(),
      rubric: ident.optional(),
    })
    .optional(),
  /** Page of a post: the path gets the slug (or the id) of the post. */
  path: pathSlot.optional(),
  /** Rubrics: their entity, fields and the address prefix of the rubric pages. */
  rubrics: z.object({
    entity: ident.optional(),
    name: ident.optional(),
    slug: ident.optional(),
    description: ident.optional(),
    path: pathSlot,
  }),
  /** Heading of the list of every post (a rubric page shows the rubric's name). */
  title: line(80),
  text: para(260).optional(),
  /** 1 — the heading of the page (a rubric page), 2 — under the first screen (default). */
  level: z.union([z.literal(1), z.literal(2)]).optional(),
  /** The list of every post among the rubric links. */
  all: linkSlot.optional(),
  /** What an empty list says, calmly and without invented posts. */
  empty: line(120).optional(),
  /** Posts per «Показать ещё». */
  pageSize: z.number().int().min(3).max(24).optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const RUBRIC_EXAMPLE = {
  entity: "article",
  path: "/blog/",
  rubrics: { path: "/blog/rubric/" },
  title: "Заметки мастерской",
  text: "Рассказываем о глине, глазурях и о том, что происходит в мастерской.",
  level: 2,
  all: { label: "Все заметки", href: "/blog" },
  empty: "Первые заметки скоро появятся",
  pageSize: 6,
} satisfies z.input<typeof rubricSlots>;

const at = import.meta.url;

export const RUBRIC_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Cards>()(at, "rubric", {
    variant: "cards",
    layout: "grid",
    title:
      "Рубрика и ссылки на другие рубрики, ниже записи карточками сеткой: обложка, дата, заголовок, анонс",
    archetypes: ["*"],
    slots: rubricSlots,
    needs: "content",
    license: "MIT",
    origin: "hyperui",
    example: RUBRIC_EXAMPLE,
  }),
  definePattern<typeof List>()(at, "rubric", {
    variant: "list",
    layout: "list",
    title: "Рубрика и ссылки на рубрики, ниже записи строками между линейками: дата слева, заголовок и анонс",
    archetypes: ["*"],
    slots: rubricSlots,
    needs: "content",
    license: "own",
    origin: "own",
    example: RUBRIC_EXAMPLE,
  }),
  definePattern<typeof Split>()(at, "rubric", {
    variant: "split",
    layout: "split",
    title:
      "Заголовок рубрики и список рубрик в колонке слева (остаются на виду), справа записи карточками-строками",
    archetypes: ["*"],
    slots: rubricSlots,
    needs: "content",
    license: "own",
    origin: "own",
    example: RUBRIC_EXAMPLE,
  }),
];
