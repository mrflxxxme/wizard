// Headless helpers of the module «Контент и блог» (V3-24, builder-v3.md §3 C4): one entry of a content entity by the
// slug in the address (an article, a page of the site), the posts of a rubric, the body text of an entry parsed into
// blocks (a markdown subset the patterns render with React elements — no HTML of the owner ever reaches the page) and
// the tab title of an entry. No markup here: the patterns of ui/patterns (article-*, rubric-*) draw it.
import { useEffect } from "react";
import type { ListQuery, Rec, WzError } from "../../data/types.js";
import { useContent } from "./catalog.js";
import type { PagedList } from "./list.js";

/** A slug no row has: the list asked before the rubric is known returns nothing. */
const NO_ROW = "00000000-0000-0000-0000-000000000000";

/** The slug after `prefix` in `pathname` («/blog/», «/blog/dom» → «dom»); null — none or a deeper path. */
export function slugFromPath(pathname: string, prefix: string): string | null {
  const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
  if (!pathname.startsWith(base)) return null;
  const rest = pathname.slice(base.length).replace(/\/$/, "");
  if (!rest || rest.includes("/")) return null;
  try {
    const slug = decodeURIComponent(rest);
    return slug.length <= 200 ? slug : null;
  } catch {
    return null;
  }
}

/** The current address of the page (empty outside a browser). */
const currentPath = () => (typeof window === "undefined" ? "" : window.location.pathname);

export interface EntryModel<T = Rec> {
  /** Slug of the address; null — the address names none. */
  slug: string | null;
  /** The entry the role may read (published only for a visitor: rowFilter of the module); null — none yet or none. */
  entry: T | null;
  isLoading: boolean;
  error?: WzError;
  /** Loaded and there is no such entry for this role (unpublished, deleted or a wrong address). */
  notFound: boolean;
  canRead: boolean;
  refetch(): void;
}

export interface UseEntryOptions {
  /** Address prefix of the entry pages («/blog/»): the slug is the next segment. */
  path: string;
  /** Field with the slug (default slug). */
  slugField?: string;
  /** A fixed entry instead of the address (a page bound to one entry, previews). */
  slug?: string;
}

/** One entry of `entity` by the slug of the current address (or the fixed `slug`). */
export function useEntry<T = Rec>(entity: string, o: UseEntryOptions): EntryModel<T> {
  const slug = o.slug ?? slugFromPath(currentPath(), o.path);
  const list = useContent<T>(entity, { filter: { [o.slugField ?? "slug"]: slug ?? NO_ROW }, pageSize: 1 });
  const entry = slug ? (list.items[0] ?? null) : null;
  const isLoading = slug !== null && list.isLoading && entry === null;
  return {
    slug,
    entry,
    isLoading,
    ...(list.error ? { error: list.error } : {}),
    notFound: !isLoading && !list.error && entry === null,
    canRead: list.canRead,
    refetch: list.list.refetch,
  };
}

export interface UseRubricOptions {
  /** Address prefix of the rubric pages («/blog/rubric/»); without a slug there — every post. */
  path: string;
  /** Entity of the posts (default article) and its reference to the rubric (default rubric). */
  entity?: string;
  field?: string;
  /** Entity of the rubrics (default rubric), its slug field and the owner's order. */
  rubricEntity?: string;
  slugField?: string;
  rubricSort?: ListQuery["sort"];
  /** Order of the posts (default: the date field, newest first). */
  sort?: ListQuery["sort"];
  pageSize?: number;
}

export interface RubricModel<T = Rec> {
  /** The rubric of the address (absent on the index of every post). */
  rubric: EntryModel;
  /** No rubric in the address: every post. */
  all: boolean;
  /** Every rubric the role may read, in the owner's order. */
  rubrics: PagedList;
  /** The posts of the rubric (or every post), with «Показать ещё». */
  posts: PagedList<T>;
  /** The rubric or the posts are still loading. */
  isLoading: boolean;
}

/** The posts of the rubric named by the address, the list of rubrics and the rubric itself. */
export function useRubric<T = Rec>(o: UseRubricOptions): RubricModel<T> {
  const rubricEntity = o.rubricEntity ?? "rubric";
  const rubric = useEntry(rubricEntity, { path: o.path, ...(o.slugField ? { slugField: o.slugField } : {}) });
  const all = rubric.slug === null;
  const rubrics = useContent(rubricEntity, {
    sort: o.rubricSort ?? { field: "sort_order", dir: "asc" },
    pageSize: 24,
  });
  const posts = useContent<T>(o.entity ?? "article", {
    ...(all ? {} : { filter: { [o.field ?? "rubric"]: rubric.entry?.id ?? NO_ROW } }),
    sort: o.sort ?? { field: "published_at", dir: "desc" },
    ...(o.pageSize ? { pageSize: o.pageSize } : {}),
  });
  return { rubric, all, rubrics, posts, isLoading: rubric.isLoading || posts.isLoading };
}

// ---------------------------------------------------------------- rich text

/** Inline content of a block: text, bold, italic, code and safe links. */
export type RichInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: RichInline[] }
  | { type: "em"; children: RichInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; external: boolean; children: RichInline[] }
  | { type: "br" };

/** A block of an entry's body. Headings are h2/h3: the h1 of the page is the entry's title. */
export type RichBlock =
  | { type: "heading"; level: 2 | 3; children: RichInline[] }
  | { type: "paragraph"; children: RichInline[] }
  | { type: "list"; ordered: boolean; items: RichInline[][] }
  | { type: "quote"; children: RichInline[] }
  | { type: "image"; src: string; alt: string }
  | { type: "rule" };

/** At most this many characters of a body are parsed (the field limit of the module is lower). */
export const RICH_TEXT_MAX = 60_000;

/**
 * A link the page may show: an https/http address (opens in a new tab), mailto:, tel:, a path of the site or an anchor.
 * Anything else (javascript:, data:, protocol-relative) is null: the text stays, the link goes.
 */
export function safeHref(href: string): { href: string; external: boolean } | null {
  const h = href.trim();
  if (/^https?:\/\/[^\s"'<>]+$/i.test(h)) return { href: h, external: true };
  if (/^mailto:[^\s"'<>]+$/i.test(h) || /^tel:\+?[\d\s()-]{3,20}$/i.test(h))
    return { href: h, external: false };
  if (/^\/(?!\/)[^\s"'<>]*$/.test(h) || /^#[\w-]+$/.test(h)) return { href: h, external: false };
  return null;
}

/** An image of the body: same-origin paths only (photos of the system's storage, no hotlinks). */
const SAME_ORIGIN_IMAGE_RE = /^\/(?!\/)[^\s"'<>()]*$/;

const INLINE_RE =
  /\*\*(?<strong>[^*\n]+?)\*\*|`(?<code>[^`\n]+)`|\[(?<label>[^\]\n]+)\]\((?<href>(?:[^()\s]|\([^()\s]*\))+)\)|(?<![\p{L}\p{N}*])\*(?<em1>[^*\s][^*\n]*?)\*(?![\p{L}\p{N}*])|(?<![\p{L}\p{N}_])_(?<em2>[^_\s][^_\n]*?)_(?![\p{L}\p{N}_])/gu;

/** Inline markup of one line: **bold**, *italic* or _italic_, `code`, [text](link). */
export function richInline(text: string): RichInline[] {
  const out: RichInline[] = [];
  let at = 0;
  const push = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text += s;
    else out.push({ type: "text", text: s });
  };
  for (const m of text.matchAll(INLINE_RE)) {
    const start = m.index ?? 0;
    push(text.slice(at, start));
    at = start + m[0].length;
    const g = m.groups ?? {};
    if (g.strong !== undefined) out.push({ type: "strong", children: richInline(g.strong) });
    else if (g.code !== undefined) out.push({ type: "code", text: g.code });
    else if (g.label !== undefined && g.href !== undefined) {
      const link = safeHref(g.href);
      const children = richInline(g.label);
      if (link) out.push({ type: "link", ...link, children });
      else for (const c of children) c.type === "text" ? push(c.text) : out.push(c);
    } else {
      const em = g.em1 ?? g.em2 ?? "";
      out.push({ type: "em", children: richInline(em) });
    }
  }
  push(text.slice(at));
  return out;
}

/** Lines joined by line breaks (a single newline inside a paragraph is kept, as the owner typed it). */
function joined(lines: readonly string[]): RichInline[] {
  const out: RichInline[] = [];
  lines.forEach((l, i) => {
    if (i > 0) out.push({ type: "br" });
    out.push(...richInline(l));
  });
  return out;
}

/**
 * The body of an entry as blocks: «## » and «### » headings («# » counts as «## »), paragraphs, «- » and «1. » lists,
 * «> » quotes, «---» rules and a line «![описание](/путь)» as an image of the site. Plain text is a paragraph per blank
 * line. Pure and total: any string gives blocks, nothing is ever interpreted as HTML.
 */
export function richText(source: unknown): RichBlock[] {
  if (typeof source !== "string" || !source.trim()) return [];
  const lines = source.slice(0, RICH_TEXT_MAX).replace(/\r\n?/g, "\n").split("\n");
  const blocks: RichBlock[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ type: "paragraph", children: joined(para) });
    if (quote.length) blocks.push({ type: "quote", children: joined(quote) });
    if (list)
      blocks.push({ type: "list", ordered: list.ordered, items: list.items.map((x) => richInline(x)) });
    para = [];
    quote = [];
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: "heading",
        level: (heading[1]?.length ?? 2) <= 2 ? 2 : 3,
        children: richInline(heading[2] ?? ""),
      });
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    const image = /^\s*!\[([^\]\n]*)\]\(([^)\s]+)\)$/.exec(line);
    if (image && SAME_ORIGIN_IMAGE_RE.test(image[2] ?? "")) {
      flush();
      blocks.push({ type: "image", src: image[2] ?? "", alt: (image[1] ?? "").trim() });
      continue;
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      if (para.length || list) flush();
      quote.push(q[1] ?? "");
      continue;
    }
    const bullet = /^\s{0,3}[-*+•]\s+(.+)$/.exec(line);
    const numbered = /^\s{0,3}\d{1,3}[.)]\s+(.+)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = !bullet;
      const current = list as { ordered: boolean; items: string[] } | null;
      if (para.length || quote.length || (current && current.ordered !== ordered)) flush();
      if (!list) list = { ordered, items: [] };
      (list as { ordered: boolean; items: string[] }).items.push(item[1] ?? "");
      continue;
    }
    if (list || quote.length) {
      // A line after a list item continues it; after a quote it starts a paragraph.
      if (list) {
        const items = (list as { items: string[] }).items;
        items[items.length - 1] = `${items[items.length - 1] ?? ""} ${line.trim()}`;
        continue;
      }
      flush();
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

/** Plain text of inline content (an announcement made from the body, a title attribute). */
export function richPlain(inline: readonly RichInline[]): string {
  return inline
    .map((x) =>
      x.type === "text" || x.type === "code" ? x.text : x.type === "br" ? " " : richPlain(x.children),
    )
    .join("");
}

/**
 * The browser tab of an entry page: «<title> — <site>» (the site name from og:site_name of the document) and the
 * description, once the entry is loaded. Set after the template's own per-route tags (a microtask after the effects).
 */
export function useEntryTitle(title: string | null | undefined, description?: string | null): void {
  useEffect(() => {
    if (!title || typeof document === "undefined") return;
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      const site = document.head
        .querySelector('meta[property="og:site_name"]')
        ?.getAttribute("content")
        ?.trim();
      document.title = site && site !== title ? `${title} — ${site}` : title;
      if (description) {
        let el = document.head.querySelector('meta[name="description"]');
        if (!el) {
          el = document.createElement("meta");
          el.setAttribute("name", "description");
          document.head.append(el);
        }
        el.setAttribute("content", description);
      }
    });
    return () => {
      live = false;
    };
  }, [title, description]);
}
