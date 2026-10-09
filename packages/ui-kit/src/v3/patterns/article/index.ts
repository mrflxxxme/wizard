// Article patterns (V3-24 «Контент и блог», needs content): the page of one entry of the module — an article of the blog
// or a page of the site — by the slug of the address, over useEntry (@wizard/ui-kit/v3/headless, C4): what the role may
// read (a visitor — published entries only), the title as the h1 of the page, the date and the rubric, the cover and
// the body (a markdown subset drawn by code, never as HTML). Titles, dates and texts come only from the data.
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, SAME_ORIGIN_PATH_RE } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Aside from "./aside.js";
import type Column from "./column.js";
import type Cover from "./cover.js";
import type Editorial from "./editorial.js";

/** Entity and field names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности или поля латиницей");
const pathSlot = z.string().regex(SAME_ORIGIN_PATH_RE, "путь страницы системы");

/** Everything an entry page may show; each variant draws all of it in its own composition. */
export const articleSlots = z.object({
  /** Entity of the entries (publicFront.actions[].entity of useContent; default article). */
  entity: ident.optional(),
  /** Address prefix of the entry pages: the slug is the next segment («/blog/»). */
  path: pathSlot,
  /** Field names of an entry (default: title, slug, published_at, excerpt, cover, body, rubric, seo_title, seo_description). */
  fields: z
    .object({
      title: ident.optional(),
      slug: ident.optional(),
      date: ident.optional(),
      excerpt: ident.optional(),
      cover: ident.optional(),
      body: ident.optional(),
      rubric: ident.optional(),
      seoTitle: ident.optional(),
      seoDescription: ident.optional(),
    })
    .optional(),
  /** Rubrics: the rubric of an entry links to its page under `path`. */
  rubric: z
    .object({
      entity: ident.optional(),
      name: ident.optional(),
      slug: ident.optional(),
      path: pathSlot,
    })
    .optional(),
  /** Back to the list of entries. */
  back: linkSlot.optional(),
  /** What a missing entry says (unpublished, removed or a wrong address). */
  missing: line(160).optional(),
  /** A fixed entry instead of the slug of the address (a page bound to one entry, previews). */
  slug: z
    .string()
    .regex(/^[^\s/]{1,200}$/)
    .optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const ARTICLE_EXAMPLE = {
  entity: "article",
  path: "/blog/",
  rubric: { path: "/blog/rubric/" },
  back: { label: "Все заметки", href: "/blog" },
  slug: "kak-podgotovitsya",
} satisfies z.input<typeof articleSlots>;

const at = import.meta.url;

export const ARTICLE_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Column>()(at, "article", {
    variant: "column",
    layout: "stacked",
    title: "Одна колонка для чтения: дата и рубрика, заголовок, анонс, обложка и текст статьи",
    archetypes: ["*"],
    slots: articleSlots,
    needs: "content",
    license: "own",
    origin: "own",
    example: ARTICLE_EXAMPLE,
  }),
  definePattern<typeof Cover>()(at, "article", {
    variant: "cover",
    layout: "full-bleed",
    title: "Обложка во всю ширину, заголовок и анонс на подложке поверх неё, ниже — текст колонкой",
    archetypes: ["*"],
    slots: articleSlots,
    needs: "content",
    license: "own",
    origin: "own",
    example: ARTICLE_EXAMPLE,
  }),
  definePattern<typeof Aside>()(at, "article", {
    variant: "aside",
    layout: "split",
    title: "Текст в основной колонке, сбоку остаются на виду дата, рубрика и возврат к списку",
    archetypes: ["*"],
    slots: articleSlots,
    needs: "content",
    license: "own",
    origin: "own",
    example: ARTICLE_EXAMPLE,
  }),
  definePattern<typeof Editorial>()(at, "article", {
    variant: "editorial",
    layout: "editorial",
    title:
      "Журнальное начало под жирной линейкой: крупный заголовок слева, дата и анонс справа, обложка во всю ширину",
    archetypes: ["*"],
    slots: articleSlots,
    needs: "content",
    license: "own",
    origin: "own",
    example: ARTICLE_EXAMPLE,
  }),
];
