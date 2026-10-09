// Shop components of the v2 front (V3-23, ui-kit.yaml#components ShopProducts, ShopCart, ShopCheckout, ShopOrder): the
// module «Интернет-магазин» renders its pages /shop, /cart and /order/:id with them. The logic is the headless shop of
// v3 (useShopCatalog, useCart, useCheckout, useOrder); the DOM contract is the same as the v3 patterns shop-*, cart-*,
// checkout-* and order-* — the goal programs GS-shop-* find wz-product, wz-cart-add, wz-cart-line, wz-field-*,
// wz-consent, wz-checkout-submit, wz-order-status and wz-order-pay on both fronts.
import { type FormEvent, type ReactNode, useId } from "react";
import { cx, useWzRoot, type WzBase } from "../data/context.js";
import type { Rec } from "../data/types.js";
import { ru } from "../i18n/ru.js";
import {
  type CheckoutField,
  rub,
  SHOP_DEFAULTS,
  SHOP_TEXTS,
  type ShopFields,
  type UseCheckoutOptions,
  type UseOrderOptions,
  useCart,
  useCheckout,
  useOrder,
  useShopCatalog,
} from "../v3/headless/shop.js";
import styles from "./Shop.module.css";

export interface ShopProductsProps extends WzBase {
  /** Entity of the goods (default product). */
  entity?: string;
  /** Entity of the sections: a filter above the goods. */
  categoryEntity?: string;
  fields?: ShopFields;
  /** Where the cart is (default /cart). */
  cartPath?: string;
  emptyText?: string;
  pageSize?: number;
}

/** The goods on sale with «В корзину», the stock and the way to the cart. */
export function ShopProducts(props: ShopProductsProps): ReactNode {
  const root = useWzRoot("ShopProducts", "wz-shop", props);
  const m = useShopCatalog(props.entity ?? SHOP_DEFAULTS.product, {
    pageSize: props.pageSize ?? 24,
    ...(props.fields ? { fields: props.fields } : {}),
  });
  const cartPath = props.cartPath ?? SHOP_DEFAULTS.cartPath;
  let body: ReactNode;
  if (m.isLoading && m.items.length === 0) body = <p role="status">{ru.states.loading}</p>;
  else if (m.error && m.items.length === 0) body = <p role="alert">{m.error.message}</p>;
  else if (m.items.length === 0)
    body = (
      <p className={styles.muted} data-testid="wz-empty">
        {props.emptyText ?? "Товары скоро появятся"}
      </p>
    );
  else
    body = (
      <ul className={styles.grid}>
        {m.items.map((row: Rec) => {
          const it = m.item(row);
          const out = it.stock !== null && it.stock <= 0;
          return (
            <li key={it.id} className={styles.card} data-testid="wz-product" data-wz-product={it.id}>
              {it.photo ? (
                <img src={it.photo} alt="" aria-hidden="true" loading="lazy" className={styles.photo} />
              ) : null}
              <div className={styles.cardBody}>
                <h3 className={styles.name}>{it.name}</h3>
                {it.description ? <p className={styles.muted}>{it.description}</p> : null}
                <p className={styles.priceRow}>
                  {it.price !== null ? <span className={styles.price}>{rub(it.price)}</span> : null}
                  {it.stock !== null ? (
                    <span className={styles.muted} data-testid="wz-product-stock">
                      {out ? SHOP_TEXTS.outOfStock : `В наличии: ${it.stock} шт.`}
                    </span>
                  ) : null}
                </p>
                <button
                  type="button"
                  className={styles.primary}
                  data-testid="wz-cart-add"
                  disabled={!it.canAdd}
                  aria-label={out ? `${it.name}: нет в наличии` : `В корзину: ${it.name}`}
                  onClick={() => m.add(row)}
                >
                  {out ? SHOP_TEXTS.outOfStock : it.inCart > 0 ? `В корзине: ${it.inCart}` : "В корзину"}
                </button>
                {m.added === it.id ? (
                  <p role="status" className={styles.note}>
                    {SHOP_TEXTS.added}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    );
  return (
    <section {...root} className={cx(styles.shop, props.className)} aria-busy={m.isLoading || undefined}>
      {body}
      {m.hasMore ? (
        <button type="button" className={styles.secondary} onClick={m.more}>
          {ru.catalog.more}
        </button>
      ) : null}
      {m.cart.count > 0 ? (
        <a href={cartPath} className={styles.cartLink} data-testid="wz-cart-link">
          {`Корзина: ${m.cart.count} шт. на ${rub(m.cart.total)} — оформить`}
        </a>
      ) : null}
    </section>
  );
}

export interface ShopCartProps extends WzBase {
  /** Where the goods are (the empty cart leads there). */
  shopPath?: string;
}

/** The lines of the cart: quantities, removal and the sum. */
export function ShopCart(props: ShopCartProps): ReactNode {
  const root = useWzRoot("ShopCart", "wz-cart", props);
  const cart = useCart();
  return (
    <section {...root} className={cx(styles.shop, props.className)} aria-live="polite">
      {cart.lines.length === 0 ? (
        <div data-testid="wz-empty" className={styles.stack}>
          <p className={styles.muted}>{SHOP_TEXTS.emptyCart}</p>
          {props.shopPath ? (
            <a href={props.shopPath} className={styles.secondary}>
              Перейти к товарам
            </a>
          ) : null}
        </div>
      ) : (
        <>
          <ul className={styles.lines}>
            {cart.lines.map((l) => (
              <li key={l.id} className={styles.line} data-testid="wz-cart-line" data-wz-product={l.id}>
                <span className={styles.lineName}>{l.name}</span>
                <span className={styles.qty}>
                  <button
                    type="button"
                    className={styles.icon}
                    data-testid="wz-cart-dec"
                    aria-label={`Меньше: ${l.name}`}
                    onClick={() => cart.setQty(l.id, l.qty - 1)}
                  >
                    −
                  </button>
                  <output aria-live="polite">{l.qty}</output>
                  <button
                    type="button"
                    className={styles.icon}
                    data-testid="wz-cart-inc"
                    aria-label={`Больше: ${l.name}`}
                    disabled={typeof l.max === "number" && l.qty >= l.max}
                    onClick={() => cart.setQty(l.id, l.qty + 1)}
                  >
                    +
                  </button>
                </span>
                <span className={styles.price}>{l.price !== null ? rub(l.price * l.qty) : ""}</span>
                <button
                  type="button"
                  className={styles.link}
                  data-testid="wz-cart-remove"
                  onClick={() => cart.remove(l.id)}
                >
                  Убрать
                </button>
              </li>
            ))}
          </ul>
          <p className={styles.total} data-testid="wz-cart-total">
            {`Товары: ${rub(cart.total)}`}
          </p>
        </>
      )}
    </section>
  );
}

export interface ShopCheckoutProps extends WzBase, UseCheckoutOptions {}

const FIELD_LABELS: Record<CheckoutField, string> = {
  name: "Имя и фамилия",
  phone: "Телефон",
  email: "Почта для чека",
  address: "Адрес доставки",
  comment: "Комментарий к заказу",
};

/** The checkout: delivery (self-pickup, СДЭК, courier), contacts with the consent, the order and its payment. */
export function ShopCheckout(props: ShopCheckoutProps): ReactNode {
  const root = useWzRoot("ShopCheckout", "wz-checkout", props);
  const { wzId: _w, testId: _t, className, ...opts } = props;
  const c = useCheckout(opts);
  const uid = useId();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void c.submit();
  };
  const field = (name: CheckoutField, type: string, required: boolean, autoComplete?: string) => {
    const id = `${uid}-${name}`;
    const err = c.errors[name];
    return (
      <div className={styles.field} data-testid={`wz-field-${name}`}>
        <label htmlFor={id} className={styles.label}>
          {FIELD_LABELS[name]}
          {required ? "" : " (необязательно)"}
        </label>
        {name === "comment" ? (
          <textarea
            id={id}
            name={name}
            className={styles.input}
            value={c.values[name]}
            maxLength={1000}
            onChange={(e) => c.setValue(name, e.target.value)}
          />
        ) : (
          <input
            id={id}
            name={name}
            type={type}
            className={styles.input}
            value={c.values[name]}
            required={required}
            autoComplete={autoComplete}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${id}-err` : undefined}
            onChange={(e) => c.setValue(name, e.target.value)}
          />
        )}
        {err ? (
          <p id={`${id}-err`} className={styles.error}>
            {err}
          </p>
        ) : null}
      </div>
    );
  };
  if (c.cart.lines.length === 0 && !c.placed) return null;
  return (
    <section {...root} className={cx(styles.shop, className)}>
      <form
        className={styles.stack}
        onSubmit={onSubmit}
        noValidate
        aria-describedby={c.formError ? `${uid}-form-err` : undefined}
      >
        <fieldset className={styles.fieldset} data-testid="wz-field-delivery">
          <legend className={styles.label}>Как получить заказ</legend>
          {c.methods.map((m) => (
            <label key={m.value} className={styles.choice}>
              <input
                type="radio"
                name="delivery"
                value={m.value}
                checked={c.method === m.value}
                onChange={() => c.setMethod(m.value)}
              />
              <span>
                {m.label}
                {m.value === "courier" && opts.courierPrice !== undefined
                  ? ` — ${rub(opts.courierPrice)}`
                  : ""}
                {m.value === "pickup" ? " — бесплатно" : ""}
              </span>
            </label>
          ))}
        </fieldset>
        {c.method === "pickup" ? (
          <div className={styles.field} data-testid="wz-field-pickup_point">
            <label htmlFor={`${uid}-point`} className={styles.label}>
              Пункт самовывоза
            </label>
            <select
              id={`${uid}-point`}
              name="pickup_point"
              className={styles.input}
              value={c.pickupPoint ?? ""}
              onChange={(e) => c.setPickupPoint(e.target.value || null)}
            >
              <option value="">Выберите пункт</option>
              {c.points.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {[p.name, p.address, p.hours].filter((x) => typeof x === "string" && x).join(" · ")}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {c.method === "cdek" ? (
          <div className={styles.stack}>
            <div className={styles.field} data-testid="wz-field-cdek_city">
              <label htmlFor={`${uid}-city`} className={styles.label}>
                Город доставки
              </label>
              <span className={styles.row}>
                <input
                  id={`${uid}-city`}
                  name="cdek_city"
                  className={styles.input}
                  value={c.cdek.city}
                  autoComplete="address-level2"
                  onChange={(e) => c.cdek.setCity(e.target.value)}
                />
                <button
                  type="button"
                  className={styles.secondary}
                  data-testid="wz-cdek-find"
                  disabled={c.cdek.loading}
                  onClick={() => void c.cdek.find()}
                >
                  {c.cdek.loading ? "Ищем…" : "Найти пункты СДЭК"}
                </button>
              </span>
              {c.cdek.error ? (
                <p role="alert" className={styles.error}>
                  {c.cdek.error}
                </p>
              ) : null}
            </div>
            {c.cdek.result ? (
              <fieldset className={styles.fieldset} data-testid="wz-field-cdek_point">
                <legend className={styles.label}>
                  <span data-testid="wz-cdek-quote">
                    {`СДЭК, ${c.cdek.result.city}: ${rub(c.cdek.result.price)}, ${c.cdek.result.days}`}
                  </span>
                </legend>
                {c.cdek.result.test ? (
                  <p className={styles.note}>Пример расчёта: ключ СДЭК магазина ещё не подключён.</p>
                ) : null}
                {c.cdek.result.points.map((p) => (
                  <label key={p.code} className={styles.choice}>
                    <input
                      type="radio"
                      name="cdek_point"
                      value={p.code}
                      checked={c.cdek.point === p.code}
                      onChange={() => c.cdek.setPoint(p.code)}
                    />
                    <span>{[p.name, p.address, p.hours].filter(Boolean).join(" · ")}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
        ) : null}
        {c.errors.delivery ? (
          <p role="alert" className={styles.error}>
            {c.errors.delivery}
          </p>
        ) : null}
        {c.method === "courier" ? field("address", "text", true, "street-address") : null}
        {field("name", "text", true, "name")}
        {field("phone", "tel", true, "tel")}
        {field("email", "email", false, "email")}
        {field("comment", "text", false)}
        <p className={styles.total} data-testid="wz-checkout-total">
          {c.deliveryPrice === null
            ? `Товары: ${rub(c.cart.total)}, доставка — после выбора пункта`
            : `К оплате: ${rub(c.total)}`}
        </p>
        {c.consent.required ? (
          <div className={styles.consent} data-testid="wz-consent">
            <label className={styles.choice}>
              <input
                type="checkbox"
                checked={c.consent.checked}
                required
                aria-invalid={c.consent.error ? true : undefined}
                onChange={(e) => c.consent.set(e.target.checked)}
              />
              <span>
                {c.consent.text}
                {c.consent.policyPage ? (
                  <>
                    {" "}
                    {ru.consent.policyPrefix}{" "}
                    <a
                      href={c.consent.policyPage}
                      target="_blank"
                      rel="noopener"
                      data-testid="wz-consent-policy-link"
                    >
                      {ru.consent.policyLink}
                    </a>
                  </>
                ) : null}
              </span>
            </label>
            {c.consent.error ? <p className={styles.error}>{c.consent.error}</p> : null}
          </div>
        ) : null}
        {c.formError ? (
          <p id={`${uid}-form-err`} role="alert" className={styles.error}>
            {c.formError}
          </p>
        ) : null}
        <button
          type="submit"
          className={styles.primary}
          data-testid="wz-checkout-submit"
          disabled={c.pending}
        >
          {c.pending ? "Оформляем…" : opts.online ? "Оформить и оплатить" : "Оформить заказ"}
        </button>
      </form>
    </section>
  );
}

export interface ShopOrderProps extends WzBase, UseOrderOptions {
  /** Where the goods are. */
  shopPath?: string;
}

/** The order of its buyer: the goods, the sums, the delivery, the status and the payment while it waits for one. */
export function ShopOrder(props: ShopOrderProps): ReactNode {
  const root = useWzRoot("ShopOrder", "wz-order", props);
  const { wzId: _w, testId: _t, className, shopPath, ...opts } = props;
  const m = useOrder(opts);
  const o = m.order;
  let body: ReactNode;
  if (m.state === "loading") body = <p role="status">{ru.states.loading}</p>;
  else if (m.state === "missing" || !o)
    body = (
      <p className={styles.muted} data-testid="wz-empty">
        {SHOP_TEXTS.missing}
      </p>
    );
  else
    body = (
      <div className={styles.stack}>
        <h2 className={styles.heading} data-testid="wz-order-number">{`Заказ №${o.number}`}</h2>
        <p>
          Статус:{" "}
          <strong data-testid="wz-order-status" aria-live="polite">
            {o.statusLabel}
          </strong>
        </p>
        <ul className={styles.lines}>
          {o.lines.map((l, i) => (
            <li key={`${l.name}-${String(i)}`} className={styles.line} data-testid="wz-order-line">
              <span className={styles.lineName}>{`${l.name} × ${l.qty}`}</span>
              <span className={styles.price}>{rub(l.sum)}</span>
            </li>
          ))}
        </ul>
        <p data-testid="wz-order-delivery">
          {o.deliveryLabel}
          {o.pickup
            ? `: ${[o.pickup.name, o.pickup.address, o.pickup.hours].filter(Boolean).join(" · ")}`
            : ""}
          {o.cdek ? `: ${[o.cdek.city, o.cdek.address, o.cdek.days].filter(Boolean).join(" · ")}` : ""}
          {o.cdek?.track ? `, трек-номер ${o.cdek.track}` : ""}
          {o.deliveryPrice > 0 ? ` — ${rub(o.deliveryPrice)}` : ""}
        </p>
        <p className={styles.total} data-testid="wz-order-total">{`Итого: ${rub(o.total)}`}</p>
        {m.checking ? <p role="status">Проверяем оплату…</p> : null}
        {m.canPay ? (
          <button
            type="button"
            className={styles.primary}
            data-testid="wz-order-pay"
            disabled={m.paying}
            onClick={() => void m.pay()}
          >
            {m.paying ? "Переходим к оплате…" : `Оплатить ${rub(o.total)}`}
          </button>
        ) : null}
        {m.payError ? (
          <p role="alert" className={styles.error}>
            {m.payError}
          </p>
        ) : null}
      </div>
    );
  return (
    <section {...root} className={cx(styles.shop, className)}>
      {body}
      {shopPath ? (
        <a href={shopPath} className={styles.secondary}>
          Вернуться к товарам
        </a>
      ) : null}
    </section>
  );
}
