// Article «column»: the entry of the address in one reading column — a back link, the date and the rubric, the title
// (the h1 of the page), the announcement as a lead, the cover and the body. The data is the module's: useEntry (C4)
// reads the entry the role may see by the slug of the address (a visitor — published ones only); the body is a
// markdown subset parsed by richText and drawn here with React elements, never as HTML. Own composition.
import {
  type RichBlock,
  type RichInline,
  richText,
  srcSetOf,
  useContent,
  useEntry,
  useEntryTitle,
} from "@wizard/ui-kit/v3/headless";
import { Fragment, type ReactNode } from "react";

type Link = { label: string; href: string };
/** Where a link sits: the page background, a photo scrim or the inverse band. */
type Tone = "base" | "scrim" | "inverse";
type Fields = {
  title?: string;
  slug?: string;
  date?: string;
  excerpt?: string;
  cover?: string;
  body?: string;
  rubric?: string;
  seoTitle?: string;
  seoDescription?: string;
};

export type ArticleColumnProps = {
  /** Entity of the entries (publicFront.actions[].entity of useContent; default article). */
  entity?: string;
  /** Address prefix of the entry pages: the slug is the next segment («/blog/»). */
  path: string;
  /** Field names of an entry (default: title, slug, published_at, excerpt, cover, body, rubric, seo_*). */
  fields?: Fields;
  /** Rubrics: their entity, name field and page prefix — the rubric of the entry links there. */
  rubric?: { entity?: string; name?: string; slug?: string; path: string };
  /** Back to the list of entries. */
  back?: Link;
  /** What a missing entry says (unpublished, removed or a wrong address). */
  missing?: string;
  /** A fixed entry instead of the slug of the address (a page bound to one entry, previews). */
  slug?: string;
};

const FIELDS: Required<Fields> = {
  title: "title",
  slug: "slug",
  date: "published_at",
  excerpt: "excerpt",
  cover: "cover",
  body: "body",
  rubric: "rubric",
  seoTitle: "seo_title",
  seoDescription: "seo_description",
};
const DAY = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const MOMENT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const buttonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const backClass =
  "inline-flex min-h-11 items-center gap-2 text-small font-bold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const metaLinkClass =
  "inline-flex min-h-11 items-center text-foreground underline decoration-primary decoration-2 underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
/** Links over a photo scrim or the inverse band: the colour of the text there. */
const scrimLinkClass =
  "inline-flex min-h-11 items-center gap-2 text-scrim-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scrim-foreground";
const inverseLinkClass =
  "inline-flex min-h-11 items-center gap-2 text-inverse-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground";
const bodyLinkClass =
  "text-foreground underline decoration-primary decoration-2 underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const textOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** A date field in Russian: a calendar date as is, a moment in the visitor's time zone. */
function dateOf(v: unknown): { iso: string; label: string } | null {
  if (typeof v !== "string" || !v) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(day ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : { iso: v, label: (day ? DAY : MOMENT).format(d) };
}

/** Address of an image field: a file of the system's storage at the given width (runtime files.image). */
function photoOf(v: unknown, width: 480 | 960 | 1600): string | null {
  if (typeof v !== "string" || !v) return null;
  return v.startsWith("/") ? v : `/api/files/${encodeURIComponent(v)}/img/${width}`;
}

/** Items with stable keys made from their position (the body is static between renders). */
function keyed<T>(items: readonly T[], prefix: string): { key: string; item: T }[] {
  const out: { key: string; item: T }[] = [];
  let n = 0;
  for (const item of items) out.push({ key: `${prefix}${n++}`, item });
  return out;
}

/** Inline content of the body: text, bold, italic, code and links (external ones open in a new tab). */
function Inline({ nodes }: { nodes: readonly RichInline[] }) {
  return (
    <>
      {keyed(nodes, "i").map(({ key, item: n }) => {
        if (n.type === "text") return <Fragment key={key}>{n.text}</Fragment>;
        if (n.type === "br") return <br key={key} />;
        if (n.type === "code")
          return (
            <code key={key} className="rounded-sm bg-muted px-1.5 py-0.5">
              {n.text}
            </code>
          );
        if (n.type === "strong")
          return (
            <strong key={key} className="font-bold">
              <Inline nodes={n.children} />
            </strong>
          );
        if (n.type === "em")
          return (
            <em key={key}>
              <Inline nodes={n.children} />
            </em>
          );
        return n.external ? (
          <a key={key} href={n.href} target="_blank" rel="noopener noreferrer" className={bodyLinkClass}>
            <Inline nodes={n.children} />
            <span className="sr-only"> (откроется в новой вкладке)</span>
          </a>
        ) : (
          <a key={key} href={n.href} className={bodyLinkClass}>
            <Inline nodes={n.children} />
          </a>
        );
      })}
    </>
  );
}

/** One block of the body in the reading measure. */
function Block({ block }: { block: RichBlock }) {
  switch (block.type) {
    case "heading":
      return block.level === 2 ? (
        <h2 className="mt-12 font-display text-h2 font-bold text-balance wrap-break-word">
          <Inline nodes={block.children} />
        </h2>
      ) : (
        <h3 className="mt-10 font-display text-h3 font-bold text-balance wrap-break-word">
          <Inline nodes={block.children} />
        </h3>
      );
    case "paragraph":
      return (
        <p className="mt-5 text-body wrap-break-word">
          <Inline nodes={block.children} />
        </p>
      );
    case "list": {
      const items = keyed(block.items, "li").map(({ key, item }) => (
        <li key={key} className="pl-1">
          <Inline nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="mt-5 list-decimal space-y-2 pl-6 text-body marker:text-muted-foreground">{items}</ol>
      ) : (
        <ul className="mt-5 list-disc space-y-2 pl-6 text-body marker:text-muted-foreground">{items}</ul>
      );
    }
    case "quote":
      return (
        <blockquote className="mt-8 border-l-4 border-primary pl-5 text-lead wrap-break-word">
          <Inline nodes={block.children} />
        </blockquote>
      );
    case "image":
      return block.alt ? (
        <img
          src={block.src}
          srcSet={srcSetOf(block.src)}
          sizes="(min-width: 768px) 768px, 100vw"
          alt={block.alt}
          loading="lazy"
          className="mt-8 w-full rounded-md bg-muted"
        />
      ) : (
        <img
          src={block.src}
          srcSet={srcSetOf(block.src)}
          sizes="(min-width: 768px) 768px, 100vw"
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="mt-8 w-full rounded-md bg-muted"
        />
      );
    default:
      return <hr className="mt-10 border-border" />;
  }
}

/** The body of an entry: the blocks of its markdown subset. */
function Body({ source }: { source: unknown }) {
  const blocks = richText(source);
  if (blocks.length === 0) return null;
  return (
    <div className="mt-6">
      {keyed(blocks, "b").map(({ key, item }) => (
        <Block key={key} block={item} />
      ))}
    </div>
  );
}

/** The rubric of an entry as a link to its page: the name comes from the rubric list the role may read. */
function RubricLink({
  id,
  rubric,
  tone = "base",
}: {
  id: string;
  rubric: NonNullable<ArticleColumnProps["rubric"]>;
  tone?: Tone;
}) {
  const m = useContent(rubric.entity ?? "rubric", { pageSize: 24 });
  const row = m.items.find((r) => r.id === id);
  const name = textOf(row?.[rubric.name ?? "name"]);
  const slug = textOf(row?.[rubric.slug ?? "slug"]);
  if (!name || !slug) return null;
  const base = rubric.path.endsWith("/") ? rubric.path : `${rubric.path}/`;
  const scrim = tone === "scrim";
  const inverse = tone === "inverse";
  return (
    <a
      href={`${base}${encodeURIComponent(slug)}`}
      className={scrim ? scrimLinkClass : inverse ? inverseLinkClass : metaLinkClass}
    >
      {name}
    </a>
  );
}

/** Sizes of the page title: the article's, a smaller one for a load error, the large editorial one. */
const TITLE = {
  h1: "font-display text-h1 font-bold text-balance wrap-break-word hyphens-auto",
  h2: "font-display text-h2 font-bold text-balance wrap-break-word",
  hero: "font-display text-hero font-bold text-balance wrap-break-word hyphens-auto",
} as const;

/** The one h1 of the page: the entry's title, or what happened to it. */
function Title({
  size = "h1",
  className = "",
  children,
}: {
  size?: keyof typeof TITLE;
  className?: string;
  children: ReactNode;
}) {
  return <h1 className={className ? `${TITLE[size]} ${className}` : TITLE[size]}>{children}</h1>;
}

/** Loading, a load error or a missing entry (its own h1, so the page keeps one); null — the entry is there. */
function pending(
  m: ReturnType<typeof useEntry>,
  title: string | null,
  back: Link | undefined,
  missing: string | undefined,
): ReactNode | null {
  if (m.isLoading)
    return (
      <div role="status">
        <span className="sr-only">Загружаем…</span>
        <div aria-hidden="true" className="space-y-4">
          <div className="h-4 w-32 rounded-sm bg-muted" />
          <div className="h-10 w-3/4 rounded-sm bg-muted" />
          <div className="h-4 w-full rounded-sm bg-muted" />
          <div className="h-4 w-5/6 rounded-sm bg-muted" />
        </div>
      </div>
    );
  if (m.error && !m.entry)
    return (
      <div role="alert" className="rounded-lg border border-border p-6 sm:p-8">
        <Title size="h2">Не получилось загрузить страницу</Title>
        <p className="mt-2 text-body text-muted-foreground">
          Проверьте подключение к интернету и попробуйте ещё раз.
        </p>
        <button type="button" onClick={m.refetch} className={`mt-5 ${buttonClass}`}>
          Повторить
        </button>
      </div>
    );
  if (!m.entry || !title)
    return (
      <div>
        <Title>Страница не найдена</Title>
        <p className="mt-4 text-body text-muted-foreground">
          {missing ?? "Такой страницы пока нет: возможно, её убрали или адрес набран с ошибкой."}
        </p>
        {back ? (
          <a href={back.href} className={`mt-6 ${buttonClass}`}>
            {back.label}
          </a>
        ) : null}
      </div>
    );
  return null;
}

/** The back link to the list of entries. */
function BackLink({ back, tone = "base" }: { back: Link; tone?: Tone }) {
  const scrim = tone === "scrim";
  const inverse = tone === "inverse";
  return (
    <a href={back.href} className={scrim ? scrimLinkClass : inverse ? inverseLinkClass : backClass}>
      <span aria-hidden="true">←</span>
      {back.label}
    </a>
  );
}

export default function ArticleColumn(props: ArticleColumnProps) {
  const { entity = "article", path, rubric, back, missing, slug } = props;
  const f = { ...FIELDS, ...props.fields };
  const m = useEntry(entity, { path, slugField: f.slug, ...(slug ? { slug } : {}) });
  const e = m.entry;
  const title = textOf(e?.[f.title]);
  useEntryTitle(textOf(e?.[f.seoTitle]) ?? title, textOf(e?.[f.seoDescription]) ?? textOf(e?.[f.excerpt]));
  let body = pending(m, title, back, missing);
  if (!body && e) {
    const date = dateOf(e[f.date]);
    const excerpt = textOf(e[f.excerpt]);
    const cover = photoOf(e[f.cover], 1600);
    const rubricId = textOf(e[f.rubric]);
    body = (
      <article className="flex flex-col">
        <Title>{title}</Title>
        {date || (rubric && rubricId) ? (
          <p className="order-first mb-4 flex flex-wrap items-center gap-x-4 text-small text-muted-foreground">
            {date ? <time dateTime={date.iso}>{date.label}</time> : null}
            {rubric && rubricId ? <RubricLink id={rubricId} rubric={rubric} /> : null}
          </p>
        ) : null}
        {excerpt ? <p className="mt-5 text-lead text-muted-foreground">{excerpt}</p> : null}
        {cover ? (
          <img
            src={cover}
            srcSet={srcSetOf(cover)}
            sizes="100vw"
            alt=""
            aria-hidden="true"
            fetchPriority="high"
            className="mt-8 aspect-3/2 w-full rounded-lg bg-muted object-cover"
          />
        ) : null}
        <Body source={e[f.body]} />
      </article>
    );
  }
  return (
    <section
      aria-busy={m.isLoading ? true : undefined}
      className="bg-background py-section font-sans text-foreground"
    >
      <div className="mx-auto w-full max-w-text px-gutter">
        {back ? (
          <div className="mb-8">
            <BackLink back={back} />
          </div>
        ) : null}
        {body}
      </div>
    </section>
  );
}
