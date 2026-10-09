// Catalog «table»: a real table of the items — the name with a short description, the duration and the price in
// columns with tabular figures, the section filter above and «Показать ещё» under it; on phones the duration moves
// under the name and the table keeps two columns. The data is the module's: useCatalog (C4) gives the visible items in
// the owner's order, the section filter and the paging; prices only from the data. Composition after shadcn/ui «Table»
// (MIT, © shadcn), rewritten on the design system tokens.
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

export type CatalogTableProps = {
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

export default function CatalogTable(props: CatalogTableProps) {
  const { entity = "service", categoryEntity, title, text, empty, pageSize = 10, action, preview } = props;
  const f = { ...FIELDS, ...props.fields };
  const m = useCatalog(entity, { pageSize, categoryField: f.category });
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
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="border-b-2 border-foreground">
              <th scope="col" className="py-3 pr-4 text-small font-bold">
                Название
              </th>
              <th
                scope="col"
                className="hidden py-3 pr-4 text-small font-bold whitespace-nowrap sm:table-cell"
              >
                Длительность
              </th>
              <th scope="col" className="py-3 text-right text-small font-bold">
                Цена
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item) => {
              const it = itemOf(item, f);
              return (
                <tr key={item.id} data-testid="wz-itemcard" className="align-top">
                  <th scope="row" className="py-4 pr-4 font-normal">
                    <span className="block text-lead font-bold wrap-break-word">{it.name}</span>
                    {it.description ? (
                      <span className="mt-1 block max-w-text text-small text-muted-foreground">
                        {it.description}
                      </span>
                    ) : null}
                    {it.duration ? (
                      <span className="mt-1 block text-small text-muted-foreground sm:hidden">
                        {it.duration}
                      </span>
                    ) : null}
                  </th>
                  <td className="hidden py-4 pr-4 text-body whitespace-nowrap text-muted-foreground sm:table-cell">
                    {it.duration ?? "—"}
                  </td>
                  <td className="py-4 text-right text-lead font-bold whitespace-nowrap tabular-nums">
                    {it.price ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {preview ? null : <More m={m} shown={items.length} growing={growing} className="mt-8" />}
      </>
    );
  return (
    <section aria-labelledby={`${uid}-title`} className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-4xl px-gutter">
        <h2 id={`${uid}-title`} className="font-display text-h2 font-bold text-balance wrap-break-word">
          {title}
        </h2>
        {text ? <p className="mt-3 max-w-text text-body text-muted-foreground">{text}</p> : null}
        {categoryEntity ? (
          <div className="mt-8">
            <Sections entity={categoryEntity} value={m.category} onChange={m.setCategory} />
          </div>
        ) : null}
        <div aria-busy={m.isLoading ? true : undefined} className="mt-8">
          {body}
        </div>
        {action ? (
          <a href={action.href} className={`mt-8 ${buttonClass}`}>
            {action.label}
          </a>
        ) : null}
      </div>
    </section>
  );
}
