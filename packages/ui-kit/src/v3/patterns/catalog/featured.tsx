// Catalog «featured and the rest»: the first item of the owner's order large on the left — a big photo (or its price
// in large type when there is no photo), the full description, the price and the action; the rest as a compact list
// with small photos on the right, «Показать ещё» under it. The data is the module's: useCatalog (C4) gives the visible
// items in the owner's order and the paging; prices and photos only from the data. Own composition.
import { type CatalogModel, useCatalog } from "@wizard/ui-kit/v3/headless";
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

export type CatalogFeaturedProps = {
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

export default function CatalogFeatured(props: CatalogFeaturedProps) {
  const { entity = "service", title, text, empty, pageSize = 6, itemAction, action } = props;
  const f = { ...FIELDS, ...props.fields };
  const m = useCatalog(entity, { pageSize, categoryField: f.category });
  const { items, growing } = useShown(m);
  const uid = useId();
  const [first, ...rest] = items;
  const href = (item: Item) => (itemAction ? actionHref(itemAction.path, item.id) : "");
  let body: ReactNode;
  if (m.error && items.length === 0) body = <Failed m={m} />;
  else if (m.isLoading && items.length === 0) body = <Loading cards />;
  else if (!first) body = <Empty text={empty} />;
  else {
    const lead = itemOf(first, f, 1600);
    body = (
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
        <article
          data-testid="wz-itemcard"
          className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground lg:col-span-7"
        >
          {lead.photo ? (
            <img
              src={lead.photo}
              alt=""
              aria-hidden="true"
              loading="lazy"
              className="aspect-4/3 w-full bg-muted object-cover sm:aspect-16/10"
            />
          ) : null}
          <div className="flex flex-1 flex-col p-6 sm:p-10">
            <h3 className="font-display text-h2 font-bold text-balance wrap-break-word">{lead.name}</h3>
            {lead.description ? (
              <p className="mt-3 max-w-text text-lead text-muted-foreground">{lead.description}</p>
            ) : null}
            <div className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-4 pt-8">
              {lead.price ? (
                <p className="font-display text-h2 font-bold tabular-nums">{lead.price}</p>
              ) : null}
              {lead.duration ? <p className="text-body text-muted-foreground">{lead.duration}</p> : null}
              {itemAction ? (
                <a
                  href={href(first)}
                  data-testid="wz-itemcard-cta"
                  aria-label={`${itemAction.label}: ${lead.name}`}
                  className="inline-flex min-h-12 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:ml-auto"
                >
                  {itemAction.label}
                </a>
              ) : null}
            </div>
          </div>
        </article>
        <div className="min-w-0 lg:col-span-5">
          {rest.length ? (
            <ul className="divide-y divide-border border-y border-border">
              {rest.map((item) => {
                const it = itemOf(item, f, 480);
                return (
                  <li
                    key={item.id}
                    data-testid="wz-itemcard"
                    className="relative flex items-center gap-4 py-4"
                  >
                    {it.photo ? (
                      <img
                        src={it.photo}
                        alt=""
                        aria-hidden="true"
                        loading="lazy"
                        className="size-16 shrink-0 rounded-md bg-muted object-cover"
                      />
                    ) : null}
                    <div className="min-w-0 flex-1">
                      <h3 className="text-body font-bold wrap-break-word">
                        {itemAction ? (
                          <a
                            href={href(item)}
                            data-testid="wz-itemcard-cta"
                            className="block min-h-11 py-2.5 text-foreground underline-offset-4 outline-none hover:underline after:absolute after:inset-0 focus-visible:underline"
                          >
                            {it.name}
                          </a>
                        ) : (
                          it.name
                        )}
                      </h3>
                      {it.duration ? <p className="text-small text-muted-foreground">{it.duration}</p> : null}
                    </div>
                    {it.price ? (
                      <p className="shrink-0 text-body font-bold whitespace-nowrap tabular-nums">
                        {it.price}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          <More m={m} shown={items.length} growing={growing} className="mt-6" />
        </div>
      </div>
    );
  }
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
