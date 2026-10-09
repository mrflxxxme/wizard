// compile.ts of «Контент и блог» (manifest.hook): the entities by the parameters — articles always, rubrics and pages
// of the site when they are on — with fields in the order of the cabinet's form and table. Canonical names (the v3
// front, the composer's pages, the runtime's sitemap and per-route head rely on them): CONTENT_NAMES, CONTENT_ROUTES.
import type { Entity, Field, ModuleFragments } from "@wizard/appspec";
import type { ModuleContext } from "../types.js";

/** Entities and fields of the module contract. */
export const CONTENT_NAMES = {
  article: "article",
  rubric: "rubric",
  page: "site_page",
  title: "title",
  name: "name",
  slug: "slug",
  status: "status",
  date: "published_at",
  rubricRef: "rubric",
  excerpt: "excerpt",
  body: "body",
  cover: "cover",
  description: "description",
  sortOrder: "sort_order",
  seoTitle: "seo_title",
  seoDescription: "seo_description",
  /** System field the list of pages is ordered by (a page has no publication date). */
  updated: "updated_at",
} as const;

/** Status values: a draft is the owner's, a published entry is the visitor's (rowFilter of the public role). */
export const CONTENT_STATUSES = [
  { value: "draft", label: "Черновик" },
  { value: "published", label: "Опубликовано" },
] as const;
export const PUBLISHED = "published";

/** Routes of the public screens: the list of articles, an article, a rubric, the list of pages and a page. */
export const CONTENT_ROUTES = {
  blog: "/blog",
  article: "/blog/:slug",
  rubric: "/blog/rubric/:slug",
  pages: "/pages",
  page: "/pages/:slug",
} as const;

/**
 * What each public screen shows (the v3 composer binds its sections by it): a list of entries, one entry by the slug
 * of the address, or the entries of a rubric; `entry` — the screen of one entry of a list, `list` — the list of an entry.
 */
export interface ContentScreen {
  kind: "list" | "entry" | "rubric";
  entity: string;
  /** Field the list is ordered by, newest first. */
  dateField: string;
  /** Screen id of one entry (lists) or of the list (entries, rubrics). */
  entry?: string;
  list?: string;
}

export const CONTENT_SCREENS: Readonly<Record<string, ContentScreen>> = {
  blog: { kind: "list", entity: "article", dateField: "published_at", entry: "article" },
  article: { kind: "entry", entity: "article", dateField: "published_at", list: "blog" },
  rubric: { kind: "rubric", entity: "article", dateField: "published_at", entry: "article", list: "blog" },
  pages: { kind: "list", entity: "site_page", dateField: "updated_at", entry: "site_page" },
  site_page: { kind: "entry", entity: "site_page", dateField: "updated_at", list: "pages" },
};

/** Body text limit (characters of the markdown subset). */
export const CONTENT_BODY_MAX = 20000;

export interface ContentOptions {
  blogTitle: string;
  withRubrics: boolean;
  withPages: boolean;
}

export function contentOptions(params: Readonly<Record<string, unknown>>): ContentOptions {
  return {
    blogTitle: String(params.blog_title ?? "Блог"),
    withRubrics: params.with_rubrics !== false,
    withPages: params.with_pages !== false,
  };
}

const N = CONTENT_NAMES;

const slugField = (what: string): Field => ({
  name: N.slug,
  label: `Адрес ${what}: латиница, цифры и дефис`,
  type: "string",
  required: true,
  unique: true,
  maxLength: 80,
});

const statusField: Field = {
  name: N.status,
  label: "Статус",
  type: "enum",
  required: true,
  default: "draft",
  enum: CONTENT_STATUSES.map((s) => ({ ...s })),
};

const seoFields: Field[] = [
  { name: N.seoTitle, label: "Заголовок для поисковиков", type: "string", maxLength: 70 },
  { name: N.seoDescription, label: "Описание для поисковиков", type: "string", maxLength: 160 },
];

/** Fields of an article in the order of the cabinet (the first columns of its table: title, status, date). */
export function articleFields(o: ContentOptions): Field[] {
  return [
    { name: N.title, label: "Заголовок", type: "string", required: true, maxLength: 140 },
    statusField,
    { name: N.date, label: "Дата публикации", type: "date", required: true },
    ...(o.withRubrics
      ? [
          {
            name: N.rubricRef,
            label: "Рубрика",
            type: "ref",
            ref: { entity: N.rubric, onDelete: "set_null" },
          } satisfies Field,
        ]
      : []),
    slugField("статьи"),
    { name: N.excerpt, label: "Анонс", type: "text", maxLength: 300 },
    {
      name: N.body,
      label: "Текст: абзацы через пустую строку, ## подзаголовок, - список",
      type: "text",
      maxLength: CONTENT_BODY_MAX,
    },
    { name: N.cover, label: "Обложка", type: "image" },
    ...seoFields,
  ];
}

export function compileContent(ctx: ModuleContext): ModuleFragments {
  const o = contentOptions(ctx.params);
  const entities: Entity[] = [];
  if (o.withRubrics)
    entities.push({
      name: N.rubric,
      label: "Рубрика",
      fields: [
        { name: N.name, label: "Название", type: "string", required: true, maxLength: 80 },
        slugField("рубрики"),
        { name: N.description, label: "Описание", type: "text", maxLength: 300 },
        { name: N.sortOrder, label: "Порядок в списке", type: "int", min: 0, max: 9999 },
      ],
    });
  entities.push({
    name: N.article,
    label: "Статья",
    fields: articleFields(o),
    indexes: [{ fields: [N.status, N.date] }, ...(o.withRubrics ? [{ fields: [N.rubricRef] }] : [])],
  });
  if (o.withPages)
    entities.push({
      name: N.page,
      label: "Страница сайта",
      fields: [
        { name: N.title, label: "Заголовок", type: "string", required: true, maxLength: 140 },
        statusField,
        slugField("страницы"),
        { name: N.excerpt, label: "Кратко о странице", type: "text", maxLength: 300 },
        {
          name: N.body,
          label: "Текст: абзацы через пустую строку, ## подзаголовок, - список",
          type: "text",
          maxLength: CONTENT_BODY_MAX,
        },
        { name: N.cover, label: "Обложка", type: "image" },
        ...seoFields,
      ],
      indexes: [{ fields: [N.status] }],
    });
  const published = { [N.status]: PUBLISHED };
  const read = (entity: string, role: string, filtered: boolean) => ({
    value: { role, entity, ops: ["read"], ...(filtered ? { rowFilter: published } : {}) },
  });
  const write = (entity: string) => [
    { value: { role: "$owner", entity, ops: ["read", "create", "update", "delete"] } },
    { value: { role: "$staff", entity, ops: ["read", "create", "update"] } },
  ];
  const permissions: NonNullable<ModuleFragments["permissions"]> = [];
  for (const e of entities) {
    const filtered = e.name !== N.rubric;
    permissions.push(read(e.name, "$public", filtered), ...write(e.name));
    if (ctx.present.has("visitor_cabinet")) permissions.push(read(e.name, "$visitor", filtered));
  }
  return {
    entities: entities.map((value) => ({ value })),
    permissions: permissions as ModuleFragments["permissions"],
  };
}
