// Rubric «list»: the posts of the rubric named by the address (or every post) as rows between thin rules — the date in
// its own column on wide screens, the title as the link of the whole row and the announcement — under the heading of
// the rubric and the row of rubric links. The data is the module's: useRubric (C4) gives what the role may read, newest
// first, by pages; dates in Russian. Own composition.
import { type PagedList, type RubricModel, useEntryTitle, useRubric } from "@wizard/ui-kit/v3/headless";
import { type ReactNode, useId, useRef } from "react";

type Post = PagedList["items"][number];
type Fields = {
  title?: string;
  date?: string;
  excerpt?: string;
  cover?: string;
  slug?: string;
  rubric?: string;
};
type Rubrics = { entity?: string; name?: string; slug?: string; description?: string; path: string };

export type RubricListProps = {
  /** Entity of the posts (publicFront.actions[].entity of useContent; default article). */
  entity?: string;
  /** Field names of a post (default: title, published_at, excerpt, cover, slug, rubric). */
  fields?: Fields;
  /** Page of a post: the path gets the slug (or the id) of the post; without it the posts are not links. */
  path?: string;
  /** Rubrics: their entity, fields and the address prefix of the rubric pages (the slug is the next segment). */
  rubrics: Rubrics;
  /** Heading of the list of every post; on a rubric page the rubric's name is the heading. */
  title: string;
  text?: string;
  /** 1 — the section is the heading of the page (a rubric page), 2 — it follows the first screen. */
  level?: 1 | 2;
  /** The list of every post and the label of its link among the rubrics. */
  all?: { label: string; href: string };
  /** What an empty list says, calmly and without invented posts. */
  empty?: string;
  /** Posts per «Показать ещё». */
  pageSize?: number;
};

const FIELDS: Required<Fields> = {
  title: "title",
  date: "published_at",
  excerpt: "excerpt",
  cover: "cover",
  slug: "slug",
  rubric: "rubric",
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
/** A rubric among the others: the current one is filled. */
const chipClass =
  "inline-flex min-h-11 items-center rounded-control border border-border px-4 text-small font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground";
/** The box of a post whose title link covers it: hover underlines the title, keyboard focus rings the box. */
const boxClass =
  "group relative has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-4 has-[a:focus-visible]:outline-ring";

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

const under = (path: string, key: string) =>
  `${path.endsWith("/") ? path : `${path}/`}${encodeURIComponent(key)}`;

/** What a post shows, read through the field names of the props; href — its page under `path`. */
function postOf(post: Post, f: Required<Fields>, path: string | undefined, width: 480 | 960 | 1600 = 960) {
  const key = textOf(post[f.slug]) ?? post.id;
  return {
    title: textOf(post[f.title]) ?? "",
    date: dateOf(post[f.date]),
    excerpt: textOf(post[f.excerpt]),
    cover: photoOf(post[f.cover], width),
    href: path ? under(path, key) : null,
  };
}

/**
 * The title of a post: the link of its whole box (the box carries boxClass), plain text without a post page; one level
 * under the heading of the section (h2 under the h1 of a rubric page, else h3).
 */
function PostTitle({
  title,
  href,
  className,
  level,
}: {
  title: string;
  href: string | null;
  className: string;
  level: 1 | 2;
}) {
  const Tag = level === 1 ? "h2" : "h3";
  return (
    <Tag className={`text-balance wrap-break-word ${className}`}>
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
    </Tag>
  );
}

/** Rows on screen: the loaded ones stay while «Показать ещё» asks for the longer list (a new query). */
function useShown(m: PagedList) {
  const last = useRef<Post[]>([]);
  if (m.items.length > 0 || !m.isLoading) last.current = m.items;
  const growing = m.isLoading && m.items.length === 0 && last.current.length > 0;
  return { items: growing ? last.current : m.items, growing };
}

/** Loading: the outline of the list, announced once. */
function Loading() {
  return (
    <div role="status">
      <span className="sr-only">Загружаем записи…</span>
      <div aria-hidden="true" className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {["a", "b", "c"].map((k) => (
          <div key={k} className="space-y-4">
            <div className="aspect-3/2 rounded-md bg-muted" />
            <div className="h-4 w-1/3 rounded-sm bg-muted" />
            <div className="h-6 w-3/4 rounded-sm bg-muted" />
          </div>
        ))}
      </div>
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

/** «Показать ещё» and the count for the screen reader; the button waits while the longer list loads. */
function More({ m, shown, growing }: { m: PagedList; shown: number; growing: boolean }) {
  return (
    <>
      <p aria-live="polite" className="sr-only">
        {`Показано ${shown} из ${m.total || shown}`}
      </p>
      {m.hasMore || growing ? (
        <div className="mt-12 flex justify-center">
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

/** The heading of the section: the rubric of the address (its name and description) or the list of every post. */
function heading(r: RubricModel, props: RubricListProps, rubrics: Required<Rubrics>) {
  if (r.all) return { title: props.title, text: props.text ?? null, missing: false };
  const name = textOf(r.rubric.entry?.[rubrics.name]);
  if (name) return { title: name, text: textOf(r.rubric.entry?.[rubrics.description]), missing: false };
  if (r.rubric.isLoading) return { title: props.title, text: null, missing: false };
  return {
    title: "Рубрика не найдена",
    text: "Возможно, её убрали или адрес набран с ошибкой.",
    missing: true,
  };
}

/** The rubrics as links: every post first, the current rubric marked for the screen reader too. */
function RubricNav({
  r,
  rubrics,
  all,
  vertical = false,
}: {
  r: RubricModel;
  rubrics: Required<Rubrics>;
  all: RubricListProps["all"];
  vertical?: boolean;
}) {
  const links = r.rubrics.items.flatMap((row) => {
    const name = textOf(row[rubrics.name]);
    const slug = textOf(row[rubrics.slug]);
    return name && slug ? [{ id: row.id, name, href: under(rubrics.path, slug), slug }] : [];
  });
  if (links.length === 0) return null;
  return (
    <nav aria-label="Рубрики">
      <ul className={vertical ? "flex flex-wrap gap-2 lg:flex-col lg:items-start" : "flex flex-wrap gap-2"}>
        {all ? (
          <li>
            <a href={all.href} aria-current={r.all ? "page" : undefined} className={chipClass}>
              {all.label}
            </a>
          </li>
        ) : null}
        {links.map((l) => (
          <li key={l.id}>
            <a
              href={l.href}
              aria-current={!r.all && r.rubric.slug === l.slug ? "page" : undefined}
              className={chipClass}
            >
              {l.name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The heading of the section at the level of the props (the page's h1 on a rubric page). */
function Heading({ level, id, children }: { level: 1 | 2; id: string; children: ReactNode }) {
  const Tag = level === 1 ? "h1" : "h2";
  return (
    <Tag
      id={id}
      className={`font-display font-bold text-balance wrap-break-word ${level === 1 ? "text-h1" : "text-h2"}`}
    >
      {children}
    </Tag>
  );
}

/** Everything a variant draws: the model, the heading, the posts on screen and the body state. */
function useRubricSection(props: RubricListProps) {
  const f = { ...FIELDS, ...props.fields };
  const rubrics: Required<Rubrics> = {
    entity: "rubric",
    name: "name",
    slug: "slug",
    description: "description",
    ...props.rubrics,
  };
  const r = useRubric({
    path: rubrics.path,
    entity: props.entity ?? "article",
    field: f.rubric,
    rubricEntity: rubrics.entity,
    slugField: rubrics.slug,
    sort: { field: f.date, dir: "desc" },
    pageSize: props.pageSize ?? 6,
  });
  const head = heading(r, props, rubrics);
  useEntryTitle(r.all || head.missing ? null : head.title, head.text);
  const { items, growing } = useShown(r.posts);
  const uid = useId();
  let state: ReactNode = null;
  if (r.posts.error && items.length === 0) state = <Failed m={r.posts} />;
  else if (r.isLoading && items.length === 0) state = <Loading />;
  else if (items.length === 0 && !head.missing)
    state = (
      <p className="text-body text-muted-foreground">
        {props.empty ?? "Записей пока нет — загляните позже."}
      </p>
    );
  return { f, r, rubrics, head, items, growing, uid, state, level: props.level ?? 2 };
}

export default function RubricList(props: RubricListProps) {
  const { f, r, rubrics, head, items, growing, uid, state, level } = useRubricSection(props);
  return (
    <section aria-labelledby={`${uid}-title`} className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="max-w-text min-w-0">
          <Heading level={level} id={`${uid}-title`}>
            {head.title}
          </Heading>
          {head.text ? <p className="mt-3 text-body text-muted-foreground">{head.text}</p> : null}
          {head.missing && props.all ? (
            <a href={props.all.href} className={`mt-6 ${buttonClass}`}>
              {props.all.label}
            </a>
          ) : null}
        </div>
        <div className="mt-8">
          <RubricNav r={r} rubrics={rubrics} all={props.all} />
        </div>
        <div aria-busy={r.isLoading ? true : undefined} className="mt-10">
          {state ??
            (items.length ? (
              <>
                <ul className="divide-y divide-border border-y border-border">
                  {items.map((post) => {
                    const p = postOf(post, f, props.path, 480);
                    return (
                      <li
                        key={post.id}
                        className={`${boxClass} grid gap-x-8 gap-y-2 py-8 sm:grid-cols-[10rem_minmax(0,1fr)]`}
                      >
                        <div className="text-small text-muted-foreground sm:pt-1.5">
                          {p.date ? <time dateTime={p.date.iso}>{p.date.label}</time> : null}
                        </div>
                        <div className="min-w-0">
                          <PostTitle
                            title={p.title}
                            href={p.href}
                            level={level}
                            className="font-display text-h3 font-bold"
                          />
                          {p.excerpt ? (
                            <p className="mt-2 max-w-text text-body text-muted-foreground">{p.excerpt}</p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
                <More m={r.posts} shown={items.length} growing={growing} />
              </>
            ) : null)}
        </div>
      </div>
    </section>
  );
}
