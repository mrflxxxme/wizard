// Catalog «list with images»: items as rows between thin rules — a square photo, the name with a short description and
// the duration, the price and the action on the right (under the name on phones); the section filter above and
// «Показать ещё» under the list. The data is the module's: useCatalog (C4) gives the visible items in the owner's order,
// the section filter and the paging; prices and photos only from the data. Composition after HyperUI «Product
// Collections» (MIT, © Mark Mead), rewritten on the design system tokens.
import { type CatalogModel, useCatalog, useContent } from "@wizard/ui-kit/v3/headless";
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

export type CatalogListProps = {
  /** Entity of the showcase (publicFront.actions[].entity of useCatalog; default service). */
  entity?: string;
  /** Entity of the sections for the filter (default none: no filter). */
  categoryEntity?: string;
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
  const h = Math.floor(v / 60);
  const m = v % 60;
  return h && m ? `${h} ч ${m} мин` : h ? `${h} ч` : `${m} мин`;
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

/** The address of an item's action: the page and ?service=<id>, which the booking patterns read to preselect it. */
function actionHref(path: string, id: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}service=${encodeURIComponent(id)}`;
}

/** The section filter: «Все» and the sections in the owner's order, one pressed. */
function Sections({
  entity,
  value,
  onChange,
}: {
  entity: string;
  value: string | null;
  onChange(id: string | null): void;
}) {
  const list = useContent(entity, { sort: { field: "sort_order", dir: "asc" }, pageSize: 24 });
  if (!list.isLoading && list.items.length === 0) return null;
  const chip = (id: string | null, label: string) => (
    <button
      key={id ?? "all"}
      type="button"
      aria-pressed={value === id}
      onClick={() => onChange(id)}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border px-4 text-body transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        value === id
          ? "border-primary bg-primary font-bold text-primary-foreground"
          : "border-border bg-background text-foreground hover:border-muted-foreground"
      }`}
    >
      {label}
    </button>
  );
  return (
    <fieldset aria-busy={list.isLoading ? true : undefined} className="flex flex-wrap gap-2">
      <legend className="sr-only">Разделы каталога</legend>
      {chip(null, "Все")}
      {list.items.map((c) => chip(c.id, String(c.name ?? c.title ?? "")))}
    </fieldset>
  );
}

export default function CatalogList(props: CatalogListProps) {
  const { entity = "service", categoryEntity, title, text, empty, pageSize = 8, itemAction, action } = props;
  const f = { ...FIELDS, ...props.fields };
  const m = useCatalog(entity, { pageSize, categoryField: f.category });
  const { items, growing } = useShown(m);
  const uid = useId();
  let body: ReactNode;
  if (m.error && items.length === 0) body = <Failed m={m} />;
  else if (m.isLoading && items.length === 0) body = <Loading />;
  else if (items.length === 0) body = <Empty text={empty} />;
  else
    body = (
      <>
        <ul className="divide-y divide-border border-y border-border">
          {items.map((item) => {
            const it = itemOf(item, f, 480);
            return (
              <li key={item.id} className="flex gap-4 py-6 sm:gap-6">
                {it.photo ? (
                  <img
                    src={it.photo}
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                    className="size-20 shrink-0 rounded-md bg-muted object-cover sm:size-28"
                  />
                ) : null}
                <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
                  <div className="min-w-0">
                    <h3 className="font-display text-h3 font-bold text-balance wrap-break-word">{it.name}</h3>
                    {it.description ? (
                      <p className="mt-1 line-clamp-2 max-w-text text-body text-muted-foreground">
                        {it.description}
                      </p>
                    ) : null}
                    {it.duration ? (
                      <p className="mt-2 text-small text-muted-foreground">{it.duration}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-4 sm:flex-col sm:items-end sm:gap-3">
                    {it.price ? (
                      <p className="text-lead font-bold whitespace-nowrap tabular-nums">{it.price}</p>
                    ) : null}
                    {itemAction ? (
                      <a
                        href={actionHref(itemAction.path, item.id)}
                        aria-label={`${itemAction.label}: ${it.name}`}
                        className={buttonClass}
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
        <More m={m} shown={items.length} growing={growing} className="mt-8" />
      </>
    );
  return (
    <section aria-labelledby={`${uid}-title`} className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="min-w-0 lg:col-span-4">
            <h2 id={`${uid}-title`} className="font-display text-h2 font-bold text-balance wrap-break-word">
              {title}
            </h2>
            {text ? <p className="mt-3 text-body text-muted-foreground">{text}</p> : null}
            {action ? (
              <a href={action.href} className={`mt-6 ${buttonClass}`}>
                {action.label}
              </a>
            ) : null}
          </div>
          <div className="min-w-0 lg:col-span-8">
            {categoryEntity ? (
              <div className="mb-6">
                <Sections entity={categoryEntity} value={m.category} onChange={m.setCategory} />
              </div>
            ) : null}
            <div aria-busy={m.isLoading ? true : undefined}>{body}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
