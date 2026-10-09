// Order «summary»: the page of one order for its buyer, like a receipt in a card — the number as the heading, the
// status, the goods with their quantities and sums, how the order is received (the pickup point, the СДЭК point with
// the term and the track number, the courier), the total and «Оплатить» while the order waits for its payment. The
// logic is the module's: useOrder (C4) reads the order of the address by the buyer's secret kept in this browser
// (no contacts come back), offers the payment again and, back from the payment page, asks again until the payment's
// notice is in. Statuses, sums and names come only from the data. Own composition.
import { rub, useOrder } from "@wizard/ui-kit/v3/headless";
import { type ReactNode, useId } from "react";

type Link = { label: string; href: string };

export type OrderSummaryProps = {
  /** Level of the heading: 1 when the section is the heading of its page (/order/:id), else 2. */
  level?: 1 | 2;
  /** Address prefix of the order pages: the order id is the next segment (default «/order/»). */
  path?: string;
  /** The module's payment (publicFront.actions[].shop.payment); absent — the shop takes no online payment. */
  payment?: { integration: string; binding: string };
  /** Back to the goods. */
  back?: Link;
  /** A direct channel to the shop for questions about the order. */
  contact?: Link;
  /** Place of the section in the page source: the build injects it (ui-kit.yaml#wz_id), never the composer. */
  wzId?: string;
};

const primaryClass =
  "inline-flex min-h-12 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";
const linkClass =
  "inline-flex min-h-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const DAY = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
});

/** «12 октября, 14:30» of a moment, null for anything else. */
function momentOf(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : DAY.format(d);
}

/** The heading of the page in its size. */
function Title({ level, id, children }: { level: 1 | 2; id: string; children: ReactNode }) {
  const H = level === 1 ? "h1" : "h2";
  return (
    <H
      id={id}
      className={`font-display font-bold text-balance wrap-break-word ${level === 1 ? "text-h1" : "text-h2"}`}
    >
      {children}
    </H>
  );
}

export default function OrderSummary(props: OrderSummaryProps) {
  const { level = 2, path = "/order/", payment, back, contact } = props;
  const m = useOrder({ path, payment: payment ?? null });
  const o = m.order;
  const uid = useId();
  const Sub = level === 1 ? "h2" : "h3";
  let body: ReactNode;
  if (m.state === "loading")
    body = (
      <div role="status">
        <span className="sr-only">Загружаем заказ…</span>
        <div aria-hidden="true" className="space-y-4">
          <div className="h-10 w-1/2 rounded-sm bg-muted" />
          <div className="h-5 w-1/3 rounded-sm bg-muted" />
          <div className="h-32 w-full rounded-md bg-muted" />
        </div>
      </div>
    );
  else if (m.state === "missing" || !o)
    body = (
      <div data-testid="wz-empty">
        <Title level={level} id={`${uid}-title`}>
          Заказ не найден
        </Title>
        <p className="mt-4 text-body text-muted-foreground">
          Откройте заказ на том устройстве, где оформляли его, по ссылке после оплаты — или напишите в
          магазин.
        </p>
      </div>
    );
  else {
    const until = o.payable ? momentOf(o.payUntil) : null;
    const where = o.pickup
      ? [o.pickup.name, o.pickup.address, o.pickup.hours]
      : o.cdek
        ? [o.cdek.city, o.cdek.address, o.cdek.days]
        : [];
    body = (
      <article>
        <Title level={level} id={`${uid}-title`}>
          <span data-testid="wz-order-number">{`Заказ №${o.number}`}</span>
        </Title>
        <p className="mt-4 flex flex-wrap items-center gap-3 text-body">
          <span className="text-muted-foreground">Статус</span>
          <strong
            data-testid="wz-order-status"
            aria-live="polite"
            className="rounded-control bg-muted px-3 py-1 font-bold"
          >
            {o.statusLabel}
          </strong>
        </p>
        {m.checking ? (
          <p role="status" className="mt-3 text-body text-muted-foreground">
            Проверяем оплату — страница обновится сама.
          </p>
        ) : null}
        <div className="mt-8 rounded-lg border border-border bg-card p-5 text-card-foreground sm:p-8">
          <Sub className="font-display text-h3 font-bold">Состав заказа</Sub>
          <ul className="mt-4 divide-y divide-border">
            {o.lines.map((l, i) => (
              <li
                key={`${l.name}-${String(i)}`}
                data-testid="wz-order-line"
                className="flex items-baseline justify-between gap-4 py-3 text-body"
              >
                <span className="min-w-0 wrap-break-word">{`${l.name} × ${l.qty}`}</span>
                <span className="shrink-0 tabular-nums">{rub(l.sum)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 border-t border-border pt-4 text-body">
            <dt>Товары</dt>
            <dd className="text-right tabular-nums">{rub(o.itemsTotal)}</dd>
            <dt>Доставка</dt>
            <dd className="text-right tabular-nums">
              {o.deliveryPrice > 0 ? rub(o.deliveryPrice) : "бесплатно"}
            </dd>
            <dt className="text-lead font-bold">Итого</dt>
            <dd data-testid="wz-order-total" className="text-right text-lead font-bold tabular-nums">
              {rub(o.total)}
            </dd>
          </dl>
          <Sub className="mt-8 font-display text-h3 font-bold">Получение</Sub>
          <p data-testid="wz-order-delivery" className="mt-3 text-body wrap-break-word">
            <span className="font-bold">{o.deliveryLabel}</span>
            {where.filter(Boolean).length ? (
              <span className="block text-muted-foreground">{where.filter(Boolean).join(" · ")}</span>
            ) : null}
            {o.cdek?.track ? <span className="block">{`Трек-номер СДЭК: ${o.cdek.track}`}</span> : null}
          </p>
          {m.canPay ? (
            <div className="mt-8 border-t border-border pt-6">
              <button
                type="button"
                data-testid="wz-order-pay"
                aria-disabled={m.paying ? true : undefined}
                onClick={() => {
                  if (!m.paying) void m.pay();
                }}
                className={`w-full sm:w-auto ${primaryClass}`}
              >
                {m.paying ? "Переходим к оплате…" : `Оплатить ${rub(o.total)}`}
              </button>
              {until ? (
                <p className="mt-3 text-small text-muted-foreground">{`Заказ ждёт оплаты до ${until}`}</p>
              ) : null}
              {m.payError ? (
                <p role="alert" className="mt-3 text-small font-bold">
                  {m.payError}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </article>
    );
  }
  return (
    <section
      data-wz-component="ShopOrder"
      data-wz-id={props.wzId}
      aria-labelledby={m.state === "loading" ? undefined : `${uid}-title`}
      aria-busy={m.state === "loading" ? true : undefined}
      className="bg-background py-section font-sans text-foreground"
    >
      <div className="mx-auto w-full max-w-text px-gutter">
        {body}
        {back || contact ? (
          <p className="mt-8 flex flex-wrap gap-x-8 gap-y-2">
            {back ? (
              <a href={back.href} className={linkClass}>
                <span aria-hidden="true">←</span>
                {back.label}
              </a>
            ) : null}
            {contact ? (
              <a href={contact.href} className={linkClass}>
                {contact.label}
              </a>
            ) : null}
          </p>
        ) : null}
      </div>
    </section>
  );
}
