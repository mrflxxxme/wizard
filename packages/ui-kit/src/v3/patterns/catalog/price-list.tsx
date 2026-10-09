// Catalog «price list»: a typographic menu with no photos — the sections in two columns on wide screens, in each the
// items as lines «name … price» with a dotted leader, the duration and a short description under the name. Long lists
// stay readable and compact (catalog D1 PriceList «grouped»). The data is the module's: useCatalog and useContent (C4)
// give the visible items and the sections in the owner's order; prices only from the data. Own composition.
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

export type CatalogPriceListProps = {
  /** Entity of the showcase (publicFront.actions[].entity of useCatalog; default service). */
  entity?: string;
  /** Entity of the sections: the groups of the menu (default none: one group). */
  categoryEntity?: string;
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

/** Section names in the owner's order (read only when the props name a section entity). */
function SectionNames({
  entity,
  children,
}: {
  entity: string;
  children(names: Item[], loading: boolean): ReactNode;
}) {
  const list = useContent(entity, { sort: { field: "sort_order", dir: "asc" }, pageSize: 48 });
  return <>{children(list.items, list.isLoading)}</>;
}

export default function CatalogPriceList(props: CatalogPriceListProps) {
  const { entity = "service", categoryEntity, title, text, empty, action } = props;
  const f = { ...FIELDS, ...props.fields };
  // The whole price list at once (≤ 96 rows, the data API limit).
  const m = useCatalog(entity, { pageSize: 96, categoryField: f.category });
  const { items, growing } = useShown(m);
  const uid = useId();
  const line = (item: Item) => {
    const it = itemOf(item, f);
    return (
      <li key={item.id} data-testid="wz-itemcard" className="py-3">
        <p className="flex items-baseline gap-3">
          <span className="min-w-0 text-lead font-bold wrap-break-word">{it.name}</span>
          <span
            aria-hidden="true"
            className="min-w-6 flex-1 -translate-y-1 border-b-2 border-dotted border-border"
          />
          {it.price ? (
            <span className="shrink-0 text-lead font-bold whitespace-nowrap tabular-nums">{it.price}</span>
          ) : null}
        </p>
        {it.duration || it.description ? (
          <p className="mt-1 max-w-text text-small text-muted-foreground">
            {[it.duration, it.description].filter(Boolean).join(" · ")}
          </p>
        ) : null}
      </li>
    );
  };
  const menu = (sections: Item[]) => {
    const groups = sections
      .map((c) => ({
        id: c.id,
        name: String(c.name ?? c.title ?? ""),
        items: items.filter((i) => i[f.category] === c.id),
      }))
      .filter((g) => g.items.length > 0);
    const known = new Set(groups.map((g) => g.id));
    const rest = items.filter((i) => !known.has(String(i[f.category] ?? "")));
    return (
      <div className="gap-x-16 lg:columns-2">
        {groups.map((g) => (
          <div key={g.id} className="mb-10 break-inside-avoid">
            <h3 className="border-b border-foreground pb-3 font-display text-h3 font-bold">{g.name}</h3>
            <ul className="mt-2">{g.items.map(line)}</ul>
          </div>
        ))}
        {rest.length ? <ul className="mb-10">{rest.map(line)}</ul> : null}
      </div>
    );
  };
  const body = (sections: Item[], sectionsLoading: boolean): ReactNode => {
    if (m.error && items.length === 0) return <Failed m={m} />;
    if ((m.isLoading || sectionsLoading) && items.length === 0) return <Loading />;
    if (items.length === 0) return <Empty text={empty} />;
    return (
      <>
        {menu(sections)}
        <More m={m} shown={items.length} growing={growing} />
      </>
    );
  };
  const frame = (sections: Item[], sectionsLoading: boolean) => (
    <div aria-busy={m.isLoading || sectionsLoading ? true : undefined} className="mt-12">
      {body(sections, sectionsLoading)}
    </div>
  );
  return (
    <section aria-labelledby={`${uid}-title`} className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="mx-auto max-w-text text-center">
          <h2 id={`${uid}-title`} className="font-display text-h1 font-bold text-balance wrap-break-word">
            {title}
          </h2>
          {text ? <p className="mt-4 text-body text-muted-foreground">{text}</p> : null}
          {action ? (
            <a href={action.href} className={`mt-6 ${buttonClass}`}>
              {action.label}
            </a>
          ) : null}
        </div>
        {categoryEntity ? <SectionNames entity={categoryEntity}>{frame}</SectionNames> : frame([], false)}
      </div>
    </section>
  );
}
