// Catalog «manual carousel»: a tinted band with the heading and two arrow buttons, the items as a row of cards that
// scrolls sideways under the finger or by the arrows (scroll snap, never on its own — catalog M06); «Показать ещё» adds
// the next cards to the end of the row. The data is the module's: useCatalog (C4) gives the visible items in the
// owner's order and the paging; prices and photos only from the data. Own composition.
import { type CatalogModel, srcSetOf, useCatalog } from "@wizard/ui-kit/v3/headless";
import { type ReactNode, useId, useRef } from "react";

type Link = { label: string; href: string };
type Item = CatalogModel["items"][number];
type Fields = {
  title?: string;
  description?: string;
  price?: string;
  duration?: string;
  photo?: string;
  category?: string;
};

export type CatalogCarouselProps = {
  /** Entity of the showcase (publicFront.actions[].entity of useCatalog; default service). */
  entity?: string;
  /** Field names of the item (default: the catalog module contract). */
  fields?: Fields;
  title: string;
  text?: string;
  /** What an empty catalog says. */
  empty?: string;
  /** Items per «Показать ещё». */
  pageSize?: number;
  /** An action on each item: its path gets ?service=<id> (a booking link). */
  itemAction?: { label: string; path: string };
  action?: Link;
  /** A preview on another page (home): nothing while the list is empty, no «Показать ещё». */
  preview?: boolean;
};

const FIELDS: Required<Fields> = {
  title: "name",
  description: "description",
  price: "price",
  duration: "duration_min",
  photo: "photo",
  category: "category",
};
const MONEY = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const buttonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";

/** The price of the data (no «от» or «по запросу» of our own, catalog R04). */
function priceOf(v: unknown): string | null {
  return typeof v === "number" && Number.isFinite(v) ? MONEY.format(v) : null;
}

function durationOf(v: unknown): string | null {
  if (typeof v !== "number" || v <= 0) return null;
  // Minutes below two hours («60 мин», «90 мин») as the module's showcase says them, then hours.
  if (v < 120) return `${v} мин`;
  const h = Math.floor(v / 60);
  const m = v % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

/** Address of an image field: a file of the system's storage at the given width (runtime files.image). */
function photoOf(v: unknown, width: 480 | 960 | 1600): string | null {
  if (typeof v !== "string" || !v) return null;
  return v.startsWith("/") ? v : `/api/files/${encodeURIComponent(v)}/img/${width}`;
}

const textOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** What an item shows, read through the field names of the props. */
function itemOf(item: Item, f: Required<Fields>, width: 480 | 960 | 1600 = 960) {
  return {
    name: textOf(item[f.title]) ?? "",
    description: textOf(item[f.description]),
    price: priceOf(item[f.price]),
    duration: durationOf(item[f.duration]),
    photo: photoOf(item[f.photo], width),
  };
}

/** Rows on screen: the loaded ones stay while «Показать ещё» asks for the longer list (a new query). */
function useShown(m: CatalogModel) {
  const last = useRef<Item[]>([]);
  if (m.items.length > 0 || !m.isLoading) last.current = m.items;
  const growing = m.isLoading && m.items.length === 0 && last.current.length > 0;
  return { items: growing ? last.current : m.items, growing };
}

/** Loading (catalog A04): the outline of cards or of rows, announced once. */
function Loading({ cards = false }: { cards?: boolean }) {
  return (
    <div role="status">
      <span className="sr-only">Загружаем каталог…</span>
      {cards ? (
        <div aria-hidden="true" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {["a", "b", "c"].map((k) => (
            <div key={k} className="overflow-hidden rounded-lg border border-border">
              <div className="aspect-4/3 bg-muted" />
              <div className="space-y-3 p-6">
                <div className="h-6 w-2/3 rounded-sm bg-muted" />
                <div className="h-4 w-full rounded-sm bg-muted" />
                <div className="h-4 w-1/2 rounded-sm bg-muted" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div aria-hidden="true" className="divide-y divide-border border-y border-border">
          {["a", "b", "c", "d"].map((k) => (
            <div key={k} className="flex items-center justify-between gap-6 py-5">
              <div className="h-5 w-1/2 rounded-sm bg-muted" />
              <div className="h-5 w-20 rounded-sm bg-muted" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A load error: what happened and what to do; a retry when the role may read the catalog. */
function Failed({ m }: { m: CatalogModel }) {
  return (
    <div role="alert" className="rounded-lg border border-border p-6 sm:p-8">
      <p className="text-body font-bold">
        {m.canRead ? "Не получилось загрузить каталог." : "Каталог сейчас недоступен."}
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

/** Empty catalog: one calm line, no invented items. */
function Empty({ text }: { text?: string }) {
  return <p className="text-body text-muted-foreground">{text ?? "Позиции каталога скоро появятся."}</p>;
}

/** «Показать ещё» and the count for the screen reader; the button waits while the longer list loads. */
function More({
  m,
  shown,
  growing,
  className = "",
}: {
  m: CatalogModel;
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

/**
 * The address of an item's action: the page and ?service=<id> (the booking patterns read it to preselect the item),
 * before the anchor of a section the path may lead to («/#form» → «/?service=…#form»).
 */
function actionHref(path: string, id: string): string {
  const at = path.indexOf("#");
  const page = at < 0 ? path : path.slice(0, at);
  const anchor = at < 0 ? "" : path.slice(at);
  return `${page}${page.includes("?") ? "&" : "?"}service=${encodeURIComponent(id)}${anchor}`;
}

const arrowClass =
  "inline-flex size-12 items-center justify-center rounded-full border border-border bg-background text-foreground transition-colors duration-200 hover:border-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function CatalogCarousel(props: CatalogCarouselProps) {
  const { entity = "service", title, text, empty, pageSize = 8, itemAction, action, preview } = props;
  const f = { ...FIELDS, ...props.fields };
  const m = useCatalog(entity, { pageSize, categoryField: f.category });
  const { items, growing } = useShown(m);
  const uid = useId();
  const track = useRef<HTMLUListElement>(null);
  // One screen of cards per press; smooth only when the visitor does not ask for reduced motion.
  const scroll = (dir: 1 | -1) => {
    const el = track.current;
    if (!el) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: still ? "auto" : "smooth" });
  };
  if (preview && !m.isLoading && items.length === 0) return null;
  let body: ReactNode;
  if (m.error && items.length === 0) body = <Failed m={m} />;
  else if (m.isLoading && items.length === 0) body = <Loading cards />;
  else if (items.length === 0) body = <Empty text={empty} />;
  else
    body = (
      <>
        <ul
          ref={track}
          aria-label={title}
          className="-mx-gutter flex snap-x snap-mandatory scroll-px-gutter gap-4 overflow-x-auto px-gutter pb-4"
        >
          {items.map((item) => {
            const it = itemOf(item, f);
            return (
              <li
                key={item.id}
                data-testid="wz-itemcard"
                className="flex w-4/5 shrink-0 snap-start flex-col overflow-hidden rounded-lg bg-background text-foreground sm:w-80"
              >
                {it.photo ? (
                  <img
                    src={it.photo}
                    srcSet={srcSetOf(it.photo)}
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    className="aspect-4/3 w-full bg-muted object-cover"
                  />
                ) : (
                  <p className="flex aspect-4/3 flex-col justify-end bg-card p-5 text-card-foreground">
                    {it.price ? (
                      <span className="font-display text-h2 font-bold tabular-nums">{it.price}</span>
                    ) : null}
                    {it.duration ? (
                      <span className="text-body text-muted-foreground">{it.duration}</span>
                    ) : null}
                  </p>
                )}
                <div className="flex flex-1 flex-col p-5">
                  <h3 className="text-lead font-bold wrap-break-word">{it.name}</h3>
                  {it.description ? (
                    <p className="mt-1 line-clamp-2 text-small text-muted-foreground">{it.description}</p>
                  ) : null}
                  <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                    {it.photo && it.price ? (
                      <p className="text-body font-bold tabular-nums">{it.price}</p>
                    ) : (
                      <span />
                    )}
                    {itemAction ? (
                      <a
                        href={actionHref(itemAction.path, item.id)}
                        data-testid="wz-itemcard-cta"
                        aria-label={`${itemAction.label}: ${it.name}`}
                        className="inline-flex min-h-11 items-center font-bold text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {itemAction.label}
                      </a>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {preview ? null : <More m={m} shown={items.length} growing={growing} className="mt-4" />}
      </>
    );
  return (
    <section
      aria-labelledby={`${uid}-title`}
      className="overflow-hidden bg-muted py-section font-sans text-foreground"
    >
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="flex items-end justify-between gap-6">
          <div className="max-w-text min-w-0">
            <h2 id={`${uid}-title`} className="font-display text-h2 font-bold text-balance wrap-break-word">
              {title}
            </h2>
            {text ? <p className="mt-3 text-body text-muted-foreground">{text}</p> : null}
            {action ? (
              <a
                href={action.href}
                className="mt-4 inline-flex min-h-11 items-center font-bold text-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {action.label}
              </a>
            ) : null}
          </div>
          {items.length > 1 ? (
            <div className="hidden shrink-0 gap-2 sm:flex">
              <button
                type="button"
                aria-label="Прокрутить назад"
                onClick={() => scroll(-1)}
                className={arrowClass}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  className="size-5"
                >
                  <path d="M10 3.5L5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Прокрутить вперёд"
                onClick={() => scroll(1)}
                className={arrowClass}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  className="size-5"
                >
                  <path d="M6 3.5L10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          ) : null}
        </div>
        <div aria-busy={m.isLoading ? true : undefined} className="mt-8">
          {body}
        </div>
      </div>
    </section>
  );
}
