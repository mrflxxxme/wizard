// Catalog «sections with sticky navigation»: the whole catalog grouped by its sections, each under its own heading;
// on wide screens the list of sections stays in view on the left as links to them, on phones it is a row of links
// above. Items are rows: the name with the description, the duration and the price. The data is the module's:
// useCatalog and useContent (C4) give the visible items and the sections in the owner's order. Own composition.
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

export type CatalogSectionsProps = {
  /** Entity of the showcase (publicFront.actions[].entity of useCatalog; default service). */
  entity?: string;
  /** Entity of the sections (catalog contract service_category): the variant is about them. */
  categoryEntity: string;
  /** Field names of the item (default: the catalog module contract). */
  fields?: Fields;
  title: string;
  text?: string;
  /** What an empty catalog says. */
  empty?: string;
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

export default function CatalogSections(props: CatalogSectionsProps) {
  const { entity = "service", categoryEntity, title, text, empty, action } = props;
  const f = { ...FIELDS, ...props.fields };
  // The whole catalog at once (≤ 96 rows, the data API limit): the sections are read by eye, not paged.
  const m = useCatalog(entity, { pageSize: 96, categoryField: f.category });
  const sections = useContent(categoryEntity, { sort: { field: "sort_order", dir: "asc" }, pageSize: 48 });
  const { items, growing } = useShown(m);
  const uid = useId();
  const loading = m.isLoading || sections.isLoading;
  const groups = sections.items
    .map((c) => ({
      id: c.id,
      name: String(c.name ?? c.title ?? ""),
      items: items.filter((i) => i[f.category] === c.id),
    }))
    .filter((g) => g.items.length > 0);
  const known = new Set(groups.map((g) => g.id));
  const rest = items.filter((i) => !known.has(String(i[f.category] ?? "")));
  const anchor = (id: string) => `${uid}-section-${id}`;
  // Item names are headings under the section headings, or right under the title when nothing is grouped.
  const Name = groups.length ? "h4" : "h3";
  const row = (item: Item) => {
    const it = itemOf(item, f);
    return (
      <li key={item.id} className="grid gap-x-8 gap-y-1 py-5 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <Name className="text-lead font-bold wrap-break-word">{it.name}</Name>
          {it.description ? (
            <p className="mt-1 max-w-text text-body text-muted-foreground">{it.description}</p>
          ) : null}
        </div>
        <p className="flex items-baseline gap-3 sm:flex-col sm:items-end sm:gap-1">
          {it.price ? (
            <span className="text-lead font-bold whitespace-nowrap tabular-nums">{it.price}</span>
          ) : null}
          {it.duration ? (
            <span className="text-small whitespace-nowrap text-muted-foreground">{it.duration}</span>
          ) : null}
        </p>
      </li>
    );
  };
  let body: ReactNode;
  if (m.error && items.length === 0) body = <Failed m={m} />;
  else if (loading && items.length === 0) body = <Loading />;
  else if (items.length === 0) body = <Empty text={empty} />;
  else
    body = (
      <div className="grid gap-8 lg:grid-cols-12 lg:gap-12">
        {groups.length > 1 ? (
          <nav aria-label="Разделы каталога" className="min-w-0 lg:col-span-3">
            <ul className="-mb-2 flex gap-2 overflow-x-auto pb-2 lg:sticky lg:top-6 lg:mb-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
              {groups.map((g) => (
                <li key={g.id} className="shrink-0">
                  <a
                    href={`#${anchor(g.id)}`}
                    className="inline-flex min-h-11 items-center rounded-control border border-border px-4 text-body whitespace-nowrap text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:w-full lg:border-0 lg:px-3"
                  >
                    {g.name}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
        <div className={`min-w-0 space-y-12 ${groups.length > 1 ? "lg:col-span-9" : "lg:col-span-12"}`}>
          {groups.map((g) => (
            <section
              key={g.id}
              id={anchor(g.id)}
              aria-labelledby={`${anchor(g.id)}-title`}
              className="scroll-mt-6"
            >
              <h3 id={`${anchor(g.id)}-title`} className="font-display text-h3 font-bold">
                {g.name}
              </h3>
              <ul className="mt-3 divide-y divide-border border-y border-border">{g.items.map(row)}</ul>
            </section>
          ))}
          {rest.length ? (
            <ul className="divide-y divide-border border-y border-border">{rest.map(row)}</ul>
          ) : null}
          <More m={m} shown={items.length} growing={growing} />
        </div>
      </div>
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
        <div aria-busy={loading ? true : undefined} className="mt-10">
          {body}
        </div>
      </div>
    </section>
  );
}
