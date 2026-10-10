// Blog «editorial»: a typographic page with no pictures — each post a band between heavy rules with the date over a
// large title on the left and the announcement on the right; few posts, read like headlines of a printed page.
// «Показать ещё» adds posts. The data is the module's: useContent (C4) gives what the role may read, newest first, by
// pages; dates in Russian. Own composition.
import { type PagedList, useContent } from "@wizard/ui-kit/v3/headless";
import { type ReactNode, useId, useRef } from "react";

type Link = { label: string; href: string };
type Post = PagedList["items"][number];
type Fields = { title?: string; date?: string; excerpt?: string; cover?: string; slug?: string };

export type BlogEditorialProps = {
  /** Entity of the posts (publicFront.actions[].entity of useContent; default post). */
  entity?: string;
  /** Field names of a post (default: title, published_at, excerpt, cover, slug). */
  fields?: Fields;
  /** Page of a post: the path gets the slug (or the id) of the post; without it the posts are not links. */
  path?: string;
  title: string;
  text?: string;
  /** What an empty list says. */
  empty?: string;
  /** Posts per «Показать ещё». */
  pageSize?: number;
  action?: Link;
  /** A preview on another page (home): nothing while the list is empty, no «Показать ещё». */
  preview?: boolean;
  /** false — the entries go without dates (the pages of the site, not posts). */
  dates?: boolean;
};

const FIELDS: Required<Fields> = {
  title: "title",
  date: "published_at",
  excerpt: "excerpt",
  cover: "cover",
  slug: "slug",
};
const DAY = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const MOMENT = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
const buttonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";
/** The box of a post whose title link covers it: hover underlines the title, keyboard focus rings the box. */
const boxClass =
  "group relative has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-4 has-[a:focus-visible]:outline-ring";

/** A date field in Russian: a calendar date as is, a moment in the visitor's time zone. */
function dateOf(v: unknown): { iso: string; label: string } | null {
  if (typeof v !== "string" || !v) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(v);
  const d = new Date(day ? `${v}T00:00:00Z` : v);
  return Number.isNaN(d.getTime()) ? null : { iso: v, label: (day ? DAY : MOMENT).format(d) };
}

const textOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Address of an image field: a file of the system's storage at the given width (runtime files.image). */
function photoOf(v: unknown, width: 480 | 960 | 1600): string | null {
  if (typeof v !== "string" || !v) return null;
  return v.startsWith("/") ? v : `/api/files/${encodeURIComponent(v)}/img/${width}`;
}

/** What a post shows, read through the field names of the props; href — its page under `path`. */
function postOf(post: Post, f: Required<Fields>, path: string | undefined, width: 480 | 960 | 1600 = 960) {
  const key = textOf(post[f.slug]) ?? post.id;
  return {
    title: textOf(post[f.title]) ?? "",
    date: dateOf(post[f.date]),
    excerpt: textOf(post[f.excerpt]),
    cover: photoOf(post[f.cover], width),
    href: path ? `${path.endsWith("/") ? path : `${path}/`}${encodeURIComponent(key)}` : null,
  };
}

/** The title of a post: the link of its whole box (the box carries boxClass), plain text without a post page. */
function PostTitle({ title, href, className }: { title: string; href: string | null; className: string }) {
  return (
    <h3 className={`text-balance wrap-break-word ${className}`}>
      {href ? (
        <a
          href={href}
          className="-my-2.5 block py-2.5 text-inherit underline-offset-4 outline-none group-hover:underline after:absolute after:inset-0"
        >
          {title}
        </a>
      ) : (
        title
      )}
    </h3>
  );
}

/** Rows on screen: the loaded ones stay while «Показать ещё» asks for the longer list (a new query). */
function useShown(m: PagedList) {
  const last = useRef<Post[]>([]);
  if (m.items.length > 0 || !m.isLoading) last.current = m.items;
  const growing = m.isLoading && m.items.length === 0 && last.current.length > 0;
  return { items: growing ? last.current : m.items, growing };
}

/** Loading (catalog A04): the outline of cards or of rows, announced once. */
function Loading({ cards = false }: { cards?: boolean }) {
  return (
    <div role="status">
      <span className="sr-only">Загружаем записи…</span>
      {cards ? (
        <div aria-hidden="true" className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {["a", "b", "c"].map((k) => (
            <div key={k} className="space-y-4">
              <div className="aspect-3/2 rounded-md bg-muted" />
              <div className="h-4 w-1/3 rounded-sm bg-muted" />
              <div className="h-6 w-3/4 rounded-sm bg-muted" />
            </div>
          ))}
        </div>
      ) : (
        <div aria-hidden="true" className="divide-y divide-border border-y border-border">
          {["a", "b", "c"].map((k) => (
            <div key={k} className="space-y-3 py-8">
              <div className="h-4 w-32 rounded-sm bg-muted" />
              <div className="h-6 w-3/4 rounded-sm bg-muted" />
              <div className="h-4 w-full rounded-sm bg-muted" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A load error: what happened and what to do; a retry when the role may read the list. */
function Failed({ m }: { m: PagedList }) {
  return (
    <div role="alert" className="rounded-lg border border-border p-6 sm:p-8">
      <p className="text-body font-bold">
        {m.canRead ? "Не получилось загрузить записи." : "Записи сейчас недоступны."}
      </p>
      {m.canRead ? (
        <>
          <p className="mt-1 text-body text-muted-foreground">
            Проверьте подключение к интернету и попробуйте ещё раз.
          </p>
          <button type="button" onClick={m.list.refetch} className={`mt-5 ${buttonClass}`}>
            Повторить
          </button>
        </>
      ) : null}
    </div>
  );
}

/** No posts yet: one calm line, nothing invented. */
function Empty({ text }: { text?: string }) {
  return <p className="text-body text-muted-foreground">{text ?? "Записей пока нет — загляните позже."}</p>;
}

/** «Показать ещё» and the count for the screen reader; the button waits while the longer list loads. */
function More({
  m,
  shown,
  growing,
  className = "",
}: {
  m: PagedList;
  shown: number;
  growing: boolean;
  className?: string;
}) {
  return (
    <>
      <p aria-live="polite" className="sr-only">
        {`Показано ${shown} из ${m.total || shown}`}
      </p>
      {m.hasMore || growing ? (
        <div className={className}>
          <button
            type="button"
            onClick={m.more}
            aria-disabled={growing ? true : undefined}
            className={buttonClass}
          >
            {growing ? "Загружаем…" : "Показать ещё"}
          </button>
        </div>
      ) : null}
    </>
  );
}

export default function BlogEditorial(props: BlogEditorialProps) {
  const { entity = "post", path, title, text, empty, pageSize = 3, action, preview, dates = true } = props;
  const f = { ...FIELDS, ...props.fields };
  // Without dates the date field of a post reads nothing (the list stays sorted by it).
  const shown = dates ? f : { ...f, date: "" };
  const m = useContent(entity, { sort: { field: f.date, dir: "desc" }, pageSize });
  const { items, growing } = useShown(m);
  const uid = useId();
  if (preview && !m.isLoading && items.length === 0) return null;
  let body: ReactNode;
  if (m.error && items.length === 0) body = <Failed m={m} />;
  else if (m.isLoading && items.length === 0) body = <Loading />;
  else if (items.length === 0) body = <Empty text={empty} />;
  else
    body = (
      <>
        <ul className="border-b-2 border-foreground">
          {items.map((post) => {
            const p = postOf(post, shown, path);
            return (
              <li
                key={post.id}
                className={`${boxClass} grid gap-4 border-t-2 border-foreground py-8 lg:grid-cols-12 lg:gap-12 lg:py-10`}
              >
                <div className="min-w-0 lg:col-span-7">
                  {p.date ? (
                    <time dateTime={p.date.iso} className="text-small font-bold text-muted-foreground">
                      {p.date.label}
                    </time>
                  ) : null}
                  <PostTitle
                    title={p.title}
                    href={p.href}
                    className="mt-3 font-display text-h1 font-bold hyphens-auto"
                  />
                </div>
                {p.excerpt ? (
                  <p className="max-w-text text-lead text-muted-foreground lg:col-span-5 lg:pt-9">
                    {p.excerpt}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {preview ? null : <More m={m} shown={items.length} growing={growing} className="mt-10" />}
      </>
    );
  return (
    <section aria-labelledby={`${uid}-title`} className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="mb-10 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3">
          <h2 id={`${uid}-title`} className="font-display text-h2 font-bold text-balance wrap-break-word">
            {title}
          </h2>
          {action ? (
            <a
              href={action.href}
              className="inline-flex min-h-11 items-center font-bold text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {action.label}
            </a>
          ) : null}
          {text ? <p className="w-full max-w-text text-body text-muted-foreground">{text}</p> : null}
        </div>
        <div aria-busy={m.isLoading ? true : undefined}>{body}</div>
      </div>
    </section>
  );
}
