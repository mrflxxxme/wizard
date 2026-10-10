// Shop «list»: the goods as rows between thin rules — a square photo, the name with a short description and the stock,
// the price and «В корзину» on the right (under the name on phones). On wide screens the heading, the section filter
// and the cart stay in a column beside the list while it scrolls; on phones the cart is a bar at the bottom of the
// screen. The data and the cart are the module's: useShopCatalog (C4) gives the goods the visitor may see in the
// owner's order, the stock and the cart of this browser; prices, photos and stock come only from the data. Own
// composition.
import {
  type CatalogModel,
  rub,
  type ShopCatalogModel,
  srcSetOf,
  useContent,
  useShopCatalog,
} from "@wizard/ui-kit/v3/headless";
import { type ReactNode, useId, useRef } from "react";

type Link = { label: string; href: string };
type Row = CatalogModel["items"][number];
type Fields = {
  name?: string;
  price?: string;
  description?: string;
  photo?: string;
  category?: string;
  stock?: string | null;
};

export type ShopListProps = {
  /** Entity of the goods (publicFront.actions[].entity of useShop; default product). */
  entity?: string;
  /** Entity of the sections for the filter (default none: no filter). */
  categoryEntity?: string;
  /** Field names of a product (default: the shop module contract; stock null — the shop keeps no stock). */
  fields?: Fields;
  title: string;
  text?: string;
  /** Level of the heading: 1 when the section is the heading of its page (/shop), else 2. */
  level?: 1 | 2;
  /** What an empty shop says. */
  empty?: string;
  /** Goods per «Показать ещё». */
  pageSize?: number;
  /** The cart page: the bar under the goods leads there. */
  cart: Link;
  /** The product pages (V3-18): a product's name leads to `path` + its id. */
  product?: { path: string };
  /** V3-18: a preview on another page (home): nothing while the shop is empty, no filter, no «Показать ещё». */
  preview?: boolean;
  /** The way to all the goods (a preview's link to /shop). */
  all?: Link;
  /** Place of the section in the page source: the build injects it (ui-kit.yaml#wz_id), never the composer. */
  wzId?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-5 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";
const buttonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";
const cartClass =
  "flex min-h-12 w-full items-center justify-between gap-4 rounded-control bg-primary px-5 py-2 text-body font-bold text-primary-foreground shadow-lg transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto sm:min-w-80";

/** Rows on screen: the loaded ones stay while «Показать ещё» asks for the longer list (a new query). */
function useShown(m: CatalogModel) {
  const last = useRef<Row[]>([]);
  if (m.items.length > 0 || !m.isLoading) last.current = m.items;
  const growing = m.isLoading && m.items.length === 0 && last.current.length > 0;
  return { items: growing ? last.current : m.items, growing };
}

/** Loading: the outline of the rows, announced once. */
function Loading() {
  return (
    <div role="status">
      <span className="sr-only">Загружаем товары…</span>
      <div aria-hidden="true" className="divide-y divide-border border-y border-border">
        {["a", "b", "c", "d"].map((k) => (
          <div key={k} className="flex items-center gap-5 py-5">
            <div className="size-20 shrink-0 rounded-md bg-muted" />
            <div className="flex-1 space-y-3">
              <div className="h-5 w-1/2 rounded-sm bg-muted" />
              <div className="h-4 w-1/3 rounded-sm bg-muted" />
            </div>
            <div className="hidden h-11 w-32 rounded-control bg-muted sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A load error: what happened and what to do; a retry when the role may read the goods. */
function Failed({ m }: { m: CatalogModel }) {
  return (
    <div role="alert" className="rounded-lg border border-border p-6 sm:p-8">
      <p className="text-body font-bold">
        {m.canRead ? "Не получилось загрузить товары." : "Магазин сейчас недоступен."}
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
      <legend className="sr-only">Разделы магазина</legend>
      {chip(null, "Все")}
      {list.items.map((c) => chip(c.id, String(c.name ?? c.title ?? "")))}
    </fieldset>
  );
}

/** «Показать ещё» and the count for the screen reader; the button waits while the longer list loads. */
function More({ m, shown, growing }: { m: CatalogModel; shown: number; growing: boolean }) {
  return (
    <>
      <p aria-live="polite" className="sr-only">
        {`Показано ${shown} из ${m.total || shown}`}
      </p>
      {m.hasMore || growing ? (
        <div className="mt-10 flex justify-center">
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

/** One product as a row: its photo, name, stock, price and «В корзину» (the stock and the cart decide whether it adds). */
function Item({ m, row, level, path }: { m: ShopCatalogModel; row: Row; level: 1 | 2; path?: string }) {
  const it = m.item(row);
  const href = path ? `${path}${encodeURIComponent(it.id)}` : null;
  const Name = level === 1 ? "h2" : "h3";
  const out = it.stock !== null && it.stock <= 0;
  const all = !out && !it.canAdd;
  return (
    <li
      data-testid="wz-product"
      data-wz-product={it.id}
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-4 py-6 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
    >
      {it.photo ? (
        <img
          src={it.photo}
          srcSet={srcSetOf(it.photo)}
          sizes="(min-width: 640px) 33vw, 100vw"
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="size-20 rounded-md bg-muted object-cover sm:size-24"
        />
      ) : (
        <span aria-hidden="true" className="size-20 rounded-md bg-muted sm:size-24" />
      )}
      <div className="min-w-0">
        <Name className="font-display text-h3 font-bold text-balance wrap-break-word">
          {href ? (
            <a
              href={href}
              data-testid="wz-product-link"
              className="inline-flex min-h-11 items-center text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {it.name}
            </a>
          ) : (
            it.name
          )}
        </Name>
        {it.description ? (
          <p className="mt-1 line-clamp-2 text-body text-muted-foreground">{it.description}</p>
        ) : null}
        {it.stock !== null ? (
          <p data-testid="wz-product-stock" className="mt-1 text-small text-muted-foreground">
            {out ? "Нет в наличии" : `В наличии: ${it.stock} шт.`}
          </p>
        ) : null}
      </div>
      <div className="col-span-2 flex flex-wrap items-center justify-between gap-x-5 gap-y-2 sm:col-span-1 sm:flex-col sm:items-end">
        {it.price !== null ? <p className="text-lead font-bold tabular-nums">{rub(it.price)}</p> : null}
        <button
          type="button"
          data-testid="wz-cart-add"
          disabled={!it.canAdd}
          aria-label={out ? `${it.name}: нет в наличии` : `В корзину: ${it.name}`}
          onClick={() => m.add(row)}
          className={primaryClass}
        >
          {out
            ? "Нет в наличии"
            : all
              ? "Весь остаток в корзине"
              : it.inCart > 0
                ? `В корзине: ${it.inCart} — ещё`
                : "В корзину"}
        </button>
        <p role="status" className="min-h-5 text-small text-muted-foreground sm:text-right">
          {m.added === it.id ? "Добавлено в корзину" : ""}
        </p>
      </div>
    </li>
  );
}

export default function ShopList(props: ShopListProps) {
  const {
    entity = "product",
    categoryEntity,
    title,
    text,
    level = 2,
    empty,
    pageSize = 12,
    cart,
    product,
    preview,
    all,
  } = props;
  const m = useShopCatalog(entity, { pageSize, ...(props.fields ? { fields: props.fields } : {}) });
  const { items, growing } = useShown(m);
  const uid = useId();
  const Title = level === 1 ? "h1" : "h2";
  if (preview && !m.isLoading && items.length === 0) return null;
  let body: ReactNode;
  if (m.error && items.length === 0) body = <Failed m={m} />;
  else if (m.isLoading && items.length === 0) body = <Loading />;
  else if (items.length === 0)
    body = (
      <p data-testid="wz-empty" className="text-body text-muted-foreground">
        {empty ?? "Товары скоро появятся."}
      </p>
    );
  else
    body = (
      <>
        <ul className="divide-y divide-border border-y border-border">
          {items.map((row) => (
            <Item key={row.id} m={m} row={row} level={level} {...(product ? { path: product.path } : {})} />
          ))}
        </ul>
        {preview ? null : <More m={m} shown={items.length} growing={growing} />}
      </>
    );
  return (
    <section
      data-wz-component="ShopProducts"
      data-wz-id={props.wzId}
      aria-labelledby={`${uid}-title`}
      className="bg-background py-section font-sans text-foreground"
    >
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-16">
        <div className="min-w-0">
          <div className="lg:sticky lg:top-8">
            <Title
              id={`${uid}-title`}
              className={`font-display font-bold text-balance wrap-break-word ${level === 1 ? "text-h1" : "text-h2"}`}
            >
              {title}
            </Title>
            {text ? <p className="mt-3 text-body text-muted-foreground">{text}</p> : null}
            {all ? (
              <a href={all.href} className={`mt-5 ${buttonClass}`}>
                {all.label}
              </a>
            ) : null}
            {categoryEntity && !preview ? (
              <div className="mt-8">
                <Sections entity={categoryEntity} value={m.category} onChange={m.setCategory} />
              </div>
            ) : null}
            {m.cart.count > 0 ? (
              <div className="mt-8 hidden lg:block">
                <a href={cart.href} data-testid="wz-cart-link" className={cartClass}>
                  <span>{cart.label}</span>
                  <span className="tabular-nums">{`${m.cart.count} шт. · ${rub(m.cart.total)}`}</span>
                </a>
              </div>
            ) : null}
          </div>
        </div>
        <div className="min-w-0">
          <div aria-busy={m.isLoading ? true : undefined}>{body}</div>
          {m.cart.count > 0 ? (
            <div className="sticky bottom-4 z-10 mt-10 flex justify-end lg:hidden">
              <a href={cart.href} data-testid="wz-cart-link" className={cartClass}>
                <span>{cart.label}</span>
                <span className="tabular-nums">{`${m.cart.count} шт. · ${rub(m.cart.total)}`}</span>
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
