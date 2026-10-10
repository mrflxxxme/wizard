// Blog «archive»: a compact index with no pictures — the posts grouped by month in columns, each a short line
// «day — title» (the title is the link); many posts fit one screen, an archive reads at a glance. «Показать ещё» adds older posts. The data is
// the module's: useContent (C4) gives what the role may read, newest first, by pages; dates and months in Russian.
// Own composition.
import { type PagedList, useContent } from "@wizard/ui-kit/v3/headless";
import { type ReactNode, useId, useRef } from "react";

type Link = { label: string; href: string };
type Post = PagedList["items"][number];
type Fields = { title?: string; date?: string; excerpt?: string; cover?: string; slug?: string };

export type BlogArchiveProps = {
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

const MONTH = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY_OF_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });

/** The month of a post («Сентябрь 2026 г.») and its day («30 сент.»); posts without a date go under «Без даты». */
function monthOf(iso: string | undefined): { key: string; month: string; day: string } {
  if (!iso) return { key: "", month: "Без даты", day: "" };
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  const month = MONTH.format(d);
  return {
    key: iso.slice(0, 7),
    month: month.charAt(0).toUpperCase() + month.slice(1),
    day: DAY_OF_MONTH.format(d),
  };
}

export default function BlogArchive(props: BlogArchiveProps) {
  const { entity = "post", path, title, text, empty, pageSize = 12, action, preview } = props;
  const f = { ...FIELDS, ...props.fields };
  const m = useContent(entity, { sort: { field: f.date, dir: "desc" }, pageSize });
  const { items, growing } = useShown(m);
  const uid = useId();
  const months: { key: string; month: string; posts: { post: Post; day: string }[] }[] = [];
  for (const post of items) {
    const at = monthOf(postOf(post, f, path).date?.iso);
    const last = months[months.length - 1];
    if (last && last.key === at.key) last.posts.push({ post, day: at.day });
    else months.push({ key: at.key, month: at.month, posts: [{ post, day: at.day }] });
  }
  if (preview && !m.isLoading && items.length === 0) return null;
  let body: ReactNode;
  if (m.error && items.length === 0) body = <Failed m={m} />;
  else if (m.isLoading && items.length === 0) body = <Loading />;
  else if (items.length === 0) body = <Empty text={empty} />;
  else
    body = (
      <>
        <div className="grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {months.map((g) => (
            <section key={g.key || "none"} aria-labelledby={`${uid}-${g.key || "none"}`} className="min-w-0">
              <h3
                id={`${uid}-${g.key || "none"}`}
                className="border-b border-foreground pb-2 font-display text-h3 font-bold"
              >
                {g.month}
              </h3>
              <ul className="mt-2">
                {g.posts.map(({ post, day }) => {
                  const p = postOf(post, f, path);
                  return (
                    <li
                      key={post.id}
                      className={`${boxClass} grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 py-2.5`}
                    >
                      <span className="pt-0.5 text-small text-muted-foreground tabular-nums">{day}</span>
                      <PostTitle title={p.title} href={p.href} className="text-body font-bold" />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
        {preview ? null : <More m={m} shown={items.length} growing={growing} className="mt-10" />}
      </>
    );
  return (
    <section aria-labelledby={`${uid}-title`} className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-text min-w-0">
            <h2 id={`${uid}-title`} className="font-display text-h2 font-bold text-balance wrap-break-word">
              {title}
            </h2>
            {text ? <p className="mt-3 text-body text-muted-foreground">{text}</p> : null}
          </div>
          {action ? (
            <a href={action.href} className={`${buttonClass} self-start lg:self-auto`}>
              {action.label}
            </a>
          ) : null}
        </div>
        <div aria-busy={m.isLoading ? true : undefined} className="mt-10">
          {body}
        </div>
      </div>
    </section>
  );
}
