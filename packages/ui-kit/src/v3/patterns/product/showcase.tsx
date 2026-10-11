// Product «showcase»: the product of the address (/shop/<id>) as a showcase — the photo across the page width first
// (a wide frame on the computer, 4:3 on phones), under it the name (the h1 of the page), the price, the stock and
// «В корзину» on the left and the whole description on the right (one column on phones); the way back to the goods
// above, the bar to the cart once something is in it. The data and the cart are the module's: useProduct (C4) reads the
// product the role may see (a visitor: on sale only) and the cart of this browser; names, prices, photos and stock come
// only from the data. Own composition.
import { rub, useEntryTitle, useProduct } from "@wizard/ui-kit/v3/headless";
import type { ReactNode } from "react";

type Link = { label: string; href: string };
type Fields = { name?: string; price?: string; description?: string; photo?: string; stock?: string | null };

export type ProductShowcaseProps = {
  /** Entity of the goods (publicFront.actions[].entity of useShop; default product). */
  entity?: string;
  /** Address prefix of the product pages: the product's id is the next segment («/shop/»). */
  path: string;
  /** Field names of a product (default: the module contract; stock null — the shop keeps no stock). */
  fields?: Fields;
  /** The cart page. */
  cart: Link;
  /** Back to the goods. */
  back?: Link;
  /** What a missing product says (off sale, removed or a wrong address). */
  missing?: string;
  /** A fixed product instead of the id of the address (previews). */
  id?: string;
  /** Place of the section in the page source: the build injects it (ui-kit.yaml#wz_id), never the composer. */
  wzId?: string;
};

const primaryClass =
  "inline-flex min-h-12 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";
const buttonClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const backClass =
  "inline-flex min-h-11 items-center gap-2 text-small font-bold text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const cartClass =
  "flex min-h-12 w-full items-center justify-between gap-4 rounded-control bg-primary px-5 py-2 text-body font-bold text-primary-foreground shadow-lg transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto sm:min-w-80";

/** The page's one h1: the product's name, or that there is no such product. */
function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="font-display text-h1 font-bold text-balance wrap-break-word">{children}</h1>;
}

function Loading() {
  return (
    <div role="status">
      <span className="sr-only">Загружаем товар…</span>
      <div aria-hidden="true" className="space-y-8">
        <div className="aspect-4/3 w-full rounded-lg bg-muted lg:aspect-21/9" />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="space-y-4">
            <div className="h-10 w-2/3 rounded-sm bg-muted" />
            <div className="h-6 w-1/4 rounded-sm bg-muted" />
            <div className="h-12 w-full rounded-control bg-muted" />
          </div>
          <div className="h-24 w-full rounded-sm bg-muted" />
        </div>
      </div>
    </div>
  );
}

export default function ProductShowcase(props: ProductShowcaseProps) {
  const { entity = "product", path, cart, back, missing } = props;
  const m = useProduct(entity, {
    path,
    ...(props.id ? { id: props.id } : {}),
    ...(props.fields ? { fields: props.fields } : {}),
  });
  const it = m.item;
  useEntryTitle(it?.name, it?.description?.slice(0, 160) ?? null);
  const out = it !== null && it.stock !== null && it.stock <= 0;
  const all = it !== null && !out && !it.canAdd;
  let body: ReactNode;
  if (m.isLoading) body = <Loading />;
  else if (m.error)
    body = (
      <div role="alert" className="max-w-text">
        <PageTitle>Не получилось загрузить товар</PageTitle>
        <p className="mt-3 text-body text-muted-foreground">
          Проверьте подключение к интернету и попробуйте ещё раз.
        </p>
        <button type="button" onClick={m.refetch} className={`mt-5 ${buttonClass}`}>
          Повторить
        </button>
      </div>
    );
  else if (!it || m.notFound)
    body = (
      <div data-testid="wz-empty" className="max-w-text">
        <PageTitle>Товар не найден</PageTitle>
        <p className="mt-3 text-body text-muted-foreground">
          {missing ?? "Возможно, товар сняли с продажи или адрес набран с ошибкой."}
        </p>
      </div>
    );
  else
    body = (
      <article data-testid="wz-product" data-wz-product={it.id} className="flex flex-col gap-8 lg:gap-12">
        {it.photo ? (
          <img
            src={it.photo}
            alt={it.name}
            className="aspect-4/3 w-full rounded-lg bg-muted object-cover lg:aspect-21/9"
          />
        ) : null}
        <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start lg:gap-14">
          <div className="min-w-0">
            <PageTitle>{it.name}</PageTitle>
            <p className="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
              {it.price !== null ? (
                <span className="text-h3 font-bold tabular-nums">{rub(it.price)}</span>
              ) : null}
              {it.stock !== null ? (
                <span data-testid="wz-product-stock" className="text-body text-muted-foreground">
                  {out ? "Нет в наличии" : `В наличии: ${it.stock} шт.`}
                </span>
              ) : null}
            </p>
            <button
              type="button"
              data-testid="wz-cart-add"
              disabled={!it.canAdd}
              aria-label={out ? `${it.name}: нет в наличии` : `В корзину: ${it.name}`}
              onClick={() => m.add()}
              className={`mt-6 w-full ${primaryClass}`}
            >
              {out
                ? "Нет в наличии"
                : all
                  ? "Весь остаток в корзине"
                  : it.inCart > 0
                    ? `В корзине: ${it.inCart} — добавить ещё`
                    : "В корзину"}
            </button>
            <p role="status" className="mt-2 min-h-5 text-small text-muted-foreground">
              {m.added ? "Добавлено в корзину" : ""}
            </p>
          </div>
          {it.description ? (
            <p className="max-w-text whitespace-pre-line text-lead text-foreground lg:border-l lg:border-border lg:pl-10">
              {it.description}
            </p>
          ) : null}
        </div>
      </article>
    );
  return (
    <section
      data-wz-component="ShopProduct"
      data-wz-id={props.wzId}
      aria-busy={m.isLoading ? true : undefined}
      className="bg-background py-section font-sans text-foreground"
    >
      <div className="mx-auto w-full max-w-page px-gutter">
        {back ? (
          <p className="mb-6">
            <a href={back.href} className={backClass}>
              <span aria-hidden="true">←</span>
              {back.label}
            </a>
          </p>
        ) : null}
        {body}
        {m.cart.count > 0 ? (
          <div className="sticky bottom-4 z-10 mt-10 flex justify-end">
            <a href={cart.href} data-testid="wz-cart-link" className={cartClass}>
              <span>{cart.label}</span>
              <span className="tabular-nums">{`${m.cart.count} шт. · ${rub(m.cart.total)}`}</span>
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
