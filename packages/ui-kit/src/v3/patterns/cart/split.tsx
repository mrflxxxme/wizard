// Cart «split»: the cart and the checkout on one page — the lines of the cart with their quantities on the left, the
// checkout in a card on the right that stays in view (one column on phones): how to get the order (self-pickup at a
// point of the shop, a СДЭК pickup point found by the city, the shop's courier), the buyer's contacts, the consent to
// the processing of personal data, the sums and «Оформить заказ». The logic is the module's: useCheckout (C4) keeps
// the cart of this browser, asks the module for the СДЭК points and price, places the order by the module's function
// (the prices and the stock are the server's) and takes the buyer to the payment or to the order's page. Own
// composition.
import { type CheckoutField, rub, srcSetOf, useCheckout } from "@wizard/ui-kit/v3/headless";
import { type FormEvent, Fragment, type ReactNode, useId } from "react";

type Link = { label: string; href: string };
type Method = "pickup" | "cdek" | "courier";

export type CartSplitProps = {
  /** The heading of the page part (the cart). */
  title: string;
  /** Level of the heading: 1 when the section is the heading of its page (/cart), else 2. */
  level?: 1 | 2;
  /** The module's checkout (publicFront.actions[].shop): delivery methods, payment, functions and names. */
  checkout: {
    methods: { value: Method; label: string }[];
    online: boolean;
    courierPrice?: number;
    pointEntity?: string;
    placeFn?: string;
    cdekFn?: string;
    payment?: { integration: string; binding: string };
    orderPath?: string;
    /** A separate box of the letters about the order (V3-18). */
    consentMessages?: boolean;
  };
  /** Back to the goods. */
  back?: Link;
  /** What an empty cart says. */
  empty?: string;
  /** A line of the shop under the sums (returns, delivery terms), from the brief. */
  note?: string;
  /** The seller's pages (V3-18): the offer the order accepts, delivery and payment, returns. */
  terms?: { offer: Link; delivery?: Link; returns?: Link };
  /** Place of the section in the page source: the build injects it (ui-kit.yaml#wz_id), never the composer. */
  wzId?: string;
};

const controlClass =
  "block min-h-12 w-full min-w-0 rounded-control border border-border bg-background px-4 py-2.5 text-body text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[invalid=true]:border-2 aria-[invalid=true]:border-foreground";
const primaryClass =
  "inline-flex min-h-12 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";
const secondaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-5 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-progress";
const iconClass =
  "inline-flex size-11 items-center justify-center rounded-control border border-border text-lead text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:text-muted-foreground";
const textButtonClass =
  "inline-flex min-h-11 items-center text-small font-bold text-muted-foreground underline underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const backClass =
  "inline-flex min-h-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const termsLinkClass =
  "text-inherit underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-ring";

const LABELS: Record<CheckoutField, string> = {
  name: "Имя и фамилия",
  phone: "Телефон",
  email: "Почта для чека",
  address: "Адрес доставки",
  comment: "Комментарий к заказу",
};

/** A field error under its field, announced with it (aria-describedby). */
function Problem({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-2 flex items-start gap-2 text-small font-bold">
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        className="mt-0.5 size-4 shrink-0"
      >
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 4.5v4.5M8 11.25v.25" strokeLinecap="round" />
      </svg>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A choice card: the whole card is the radio's 44 px target, the drawn dot shows the choice. */
function Choice(props: {
  name: string;
  value: string;
  checked: boolean;
  onChange(): void;
  children: ReactNode;
}) {
  const { name, value, checked, onChange, children } = props;
  return (
    <label
      className={`relative flex min-h-12 cursor-pointer items-start gap-3 rounded-md bg-background p-3 text-body has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring ${
        checked ? "border-2 border-primary" : "border border-border hover:border-muted-foreground"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="absolute inset-0 m-0 size-full cursor-pointer appearance-none rounded-md"
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
          checked ? "border-primary" : "border-muted-foreground"
        }`}
      >
        {checked ? <span className="size-2.5 rounded-full bg-primary" /> : null}
      </span>
      <span className="pointer-events-none min-w-0">{children}</span>
    </label>
  );
}

/** A checkbox with a 44 px target (catalog A01): the native input, transparent, over the drawn box. */
function Check(props: {
  id: string;
  checked: boolean;
  onChange(v: boolean): void;
  invalid?: boolean;
  describedBy?: string;
  /** The box may stay empty (the letters about the order): not required. */
  optional?: boolean;
}) {
  const { id, checked, onChange, invalid, describedBy, optional } = props;
  return (
    <span className="relative -ml-2.5 flex size-11 shrink-0 items-center justify-center">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        required={!optional}
        onChange={(e) => onChange(e.target.checked)}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        className="absolute inset-0 m-0 size-11 cursor-pointer appearance-none rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
      />
      <span
        aria-hidden="true"
        className={`pointer-events-none flex size-6 items-center justify-center rounded-sm border-2 ${
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground bg-background"
        }`}
      >
        {checked ? (
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="size-4"
          >
            <path d="M3 8.5l3.2 3L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </span>
    </span>
  );
}

/** «Самовывоз — бесплатно», «Курьер — 350 ₽»: the price of a method when the page knows it. */
function methodLabel(m: { value: Method; label: string }, courierPrice?: number): string {
  if (m.value === "pickup") return `${m.label} — бесплатно`;
  if (m.value === "courier" && courierPrice !== undefined) return `${m.label} — ${rub(courierPrice)}`;
  return m.label;
}

/** The lines of the cart: the name, the quantity with − and +, the sum and «Убрать». */
function Lines({ c, empty, back }: { c: ReturnType<typeof useCheckout>; empty?: string; back?: Link }) {
  const cart = c.cart;
  if (cart.lines.length === 0)
    return (
      <div data-testid="wz-empty" className="rounded-lg border border-border p-6 sm:p-8">
        <p className="text-body">{empty ?? "В корзине пока ничего нет."}</p>
        {back ? (
          <a href={back.href} className={`mt-5 ${secondaryClass}`}>
            {back.label}
          </a>
        ) : null}
      </div>
    );
  return (
    <>
      <ul className="divide-y divide-border border-y border-border">
        {cart.lines.map((l) => (
          <li
            key={l.id}
            data-testid="wz-cart-line"
            data-wz-product={l.id}
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 py-5 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:items-center"
          >
            {l.photo ? (
              <img
                src={l.photo}
                srcSet={srcSetOf(l.photo)}
                sizes="96px"
                alt=""
                aria-hidden="true"
                loading="lazy"
                className="size-16 rounded-md bg-muted object-cover"
              />
            ) : (
              <span aria-hidden="true" className="size-16 rounded-md bg-muted" />
            )}
            <div className="min-w-0">
              <p className="text-body font-bold wrap-break-word">{l.name}</p>
              {l.price !== null ? (
                <p className="text-small text-muted-foreground tabular-nums">{`${rub(l.price)} за шт.`}</p>
              ) : null}
              <button
                type="button"
                data-testid="wz-cart-remove"
                onClick={() => cart.remove(l.id)}
                className={textButtonClass}
              >
                Убрать
              </button>
            </div>
            <div className="col-start-2 flex items-center gap-2 sm:col-start-auto">
              <button
                type="button"
                data-testid="wz-cart-dec"
                aria-label={`Меньше: ${l.name}`}
                onClick={() => cart.setQty(l.id, l.qty - 1)}
                className={iconClass}
              >
                −
              </button>
              <output aria-live="polite" className="min-w-8 text-center text-body font-bold tabular-nums">
                {l.qty}
              </output>
              <button
                type="button"
                data-testid="wz-cart-inc"
                aria-label={`Больше: ${l.name}`}
                disabled={typeof l.max === "number" && l.qty >= l.max}
                onClick={() => cart.setQty(l.id, l.qty + 1)}
                className={iconClass}
              >
                +
              </button>
            </div>
            <p className="col-start-2 text-lead font-bold tabular-nums sm:col-start-auto sm:min-w-28 sm:text-right">
              {l.price !== null ? rub(l.price * l.qty) : ""}
            </p>
          </li>
        ))}
      </ul>
      <p data-testid="wz-cart-total" className="mt-5 flex justify-between gap-4 text-lead font-bold">
        <span>Товары</span>
        <span className="tabular-nums">{rub(cart.total)}</span>
      </p>
    </>
  );
}

/** The checkout form: delivery, contacts, consent, sums and the action. */
function Checkout({
  c,
  checkout,
  level,
  note,
  terms,
}: {
  c: ReturnType<typeof useCheckout>;
  checkout: CartSplitProps["checkout"];
  level: 1 | 2;
  note?: string;
  terms?: CartSplitProps["terms"];
}) {
  const uid = useId();
  const Heading = level === 1 ? "h2" : "h3";
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void c.submit();
  };
  const field = (name: CheckoutField, type: string, required: boolean, autoComplete?: string) => {
    const id = `${uid}-${name}`;
    const err = c.errors[name];
    return (
      <div data-testid={`wz-field-${name}`} className="min-w-0">
        <label htmlFor={id} className="block text-small font-bold">
          {LABELS[name]}
          {required ? null : <span className="font-normal text-muted-foreground"> — по желанию</span>}
        </label>
        <div className="mt-2">
          {name === "comment" ? (
            <textarea
              id={id}
              name={name}
              rows={3}
              maxLength={1000}
              value={c.values[name]}
              onChange={(e) => c.setValue(name, e.target.value)}
              className={controlClass}
            />
          ) : (
            <input
              id={id}
              name={name}
              type={type}
              required={required}
              autoComplete={autoComplete}
              inputMode={type === "tel" ? "tel" : type === "email" ? "email" : undefined}
              value={c.values[name]}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? `${id}-err` : undefined}
              onChange={(e) => c.setValue(name, e.target.value)}
              className={controlClass}
            />
          )}
        </div>
        {err ? <Problem id={`${id}-err`}>{err}</Problem> : null}
      </div>
    );
  };
  const consentId = `${uid}-consent`;
  return (
    <div
      data-wz-component="ShopCheckout"
      className="rounded-lg border border-border bg-card p-5 text-card-foreground sm:p-8"
    >
      <Heading className="font-display text-h3 font-bold text-balance">Оформление заказа</Heading>
      <form
        noValidate
        onSubmit={onSubmit}
        aria-describedby={c.formError ? `${uid}-form-err` : undefined}
        className="mt-6 flex flex-col gap-6"
      >
        <fieldset data-testid="wz-field-delivery" className="min-w-0">
          <legend className="text-small font-bold">Как получить заказ</legend>
          <div className="mt-3 grid gap-2">
            {c.methods.map((m) => (
              <Choice
                key={m.value}
                name={`${uid}-delivery`}
                value={m.value}
                checked={c.method === m.value}
                onChange={() => c.setMethod(m.value)}
              >
                {methodLabel(m, checkout.courierPrice)}
              </Choice>
            ))}
          </div>
        </fieldset>
        {c.method === "pickup" ? (
          <fieldset
            data-testid="wz-field-pickup_point"
            aria-busy={c.points.isLoading ? true : undefined}
            className="min-w-0"
          >
            <legend className="text-small font-bold">Пункт самовывоза</legend>
            {c.points.items.length === 0 && !c.points.isLoading ? (
              <p className="mt-3 text-body text-muted-foreground">
                Пункты самовывоза скоро появятся — выберите другой способ получения.
              </p>
            ) : (
              <div className="mt-3 grid gap-2">
                {c.points.items.map((p) => (
                  <Choice
                    key={p.id}
                    name={`${uid}-point`}
                    value={p.id}
                    checked={c.pickupPoint === p.id}
                    onChange={() => c.setPickupPoint(p.id)}
                  >
                    <span className="block font-bold wrap-break-word">{String(p.name ?? "")}</span>
                    {p.address ? (
                      <span className="block text-small text-muted-foreground wrap-break-word">
                        {String(p.address)}
                      </span>
                    ) : null}
                    {p.hours ? (
                      <span className="block text-small text-muted-foreground">{String(p.hours)}</span>
                    ) : null}
                  </Choice>
                ))}
              </div>
            )}
          </fieldset>
        ) : null}
        {c.method === "cdek" ? (
          <div className="flex min-w-0 flex-col gap-4">
            <div data-testid="wz-field-cdek_city" className="min-w-0">
              <label htmlFor={`${uid}-city`} className="block text-small font-bold">
                Город доставки
              </label>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  id={`${uid}-city`}
                  name="cdek_city"
                  autoComplete="address-level2"
                  value={c.cdek.city}
                  aria-invalid={c.cdek.error ? true : undefined}
                  aria-describedby={c.cdek.error ? `${uid}-city-err` : undefined}
                  onChange={(e) => c.cdek.setCity(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void c.cdek.find();
                    }
                  }}
                  className={controlClass}
                />
                <button
                  type="button"
                  data-testid="wz-cdek-find"
                  aria-disabled={c.cdek.loading ? true : undefined}
                  onClick={() => {
                    if (!c.cdek.loading) void c.cdek.find();
                  }}
                  className={`shrink-0 ${secondaryClass}`}
                >
                  {c.cdek.loading ? "Ищем пункты…" : "Найти пункты СДЭК"}
                </button>
              </div>
              {c.cdek.error ? <Problem id={`${uid}-city-err`}>{c.cdek.error}</Problem> : null}
            </div>
            {c.cdek.result ? (
              <fieldset data-testid="wz-field-cdek_point" className="min-w-0">
                <legend className="text-small font-bold">
                  <span data-testid="wz-cdek-quote">
                    {`СДЭК, ${c.cdek.result.city}: ${rub(c.cdek.result.price)}, ${c.cdek.result.days}`}
                  </span>
                </legend>
                {c.cdek.result.test ? (
                  <p className="mt-2 text-small text-muted-foreground">
                    Пример расчёта: магазин ещё не подключил свой ключ СДЭК.
                  </p>
                ) : null}
                <div className="mt-3 grid max-h-96 gap-2 overflow-y-auto">
                  {c.cdek.result.points.map((p) => (
                    <Choice
                      key={p.code}
                      name={`${uid}-cdek`}
                      value={p.code}
                      checked={c.cdek.point === p.code}
                      onChange={() => c.cdek.setPoint(p.code)}
                    >
                      <span className="block font-bold wrap-break-word">{p.address}</span>
                      <span className="block text-small text-muted-foreground wrap-break-word">
                        {[p.name, p.hours].filter(Boolean).join(" · ")}
                      </span>
                    </Choice>
                  ))}
                </div>
              </fieldset>
            ) : null}
          </div>
        ) : null}
        {c.errors.delivery ? <Problem>{c.errors.delivery}</Problem> : null}
        <fieldset className="flex min-w-0 flex-col gap-4">
          <legend className="text-small font-bold">Получатель</legend>
          {c.method === "courier" ? field("address", "text", true, "street-address") : null}
          {field("name", "text", true, "name")}
          {field("phone", "tel", true, "tel")}
          {field("email", "email", false, "email")}
          {field("comment", "text", false)}
        </fieldset>
        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 border-t border-border pt-5 text-body">
          <dt>Товары</dt>
          <dd className="text-right tabular-nums">{rub(c.cart.total)}</dd>
          <dt>Доставка</dt>
          <dd className="text-right tabular-nums">
            {c.deliveryPrice === null ? "после выбора пункта" : rub(c.deliveryPrice)}
          </dd>
          <dt className="text-lead font-bold">Итого</dt>
          <dd data-testid="wz-checkout-total" className="text-right text-lead font-bold tabular-nums">
            {rub(c.total)}
          </dd>
        </dl>
        {c.consent.required ? (
          <div data-testid="wz-consent">
            <div className="flex items-start gap-2">
              <Check
                id={consentId}
                checked={c.consent.checked}
                onChange={c.consent.set}
                invalid={!!c.consent.error}
                describedBy={c.consent.error ? `${consentId}-err` : undefined}
              />
              <label htmlFor={consentId} className="min-w-0 pt-2.5 text-small text-muted-foreground">
                {c.consent.text}
                {c.consent.policyPage ? (
                  <>
                    {" "}
                    в соответствии с{" "}
                    <a
                      href={c.consent.policyPage}
                      data-testid="wz-consent-policy-link"
                      target="_blank"
                      rel="noopener"
                      className="text-inherit underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      политикой обработки персональных данных
                    </a>
                  </>
                ) : null}
              </label>
            </div>
            {c.consent.error ? <Problem id={`${consentId}-err`}>{c.consent.error}</Problem> : null}
          </div>
        ) : null}
        {c.messages ? (
          <div data-testid="wz-consent-messages" className="flex items-start gap-2">
            <Check
              id={`${consentId}-messages`}
              checked={c.messages.checked}
              onChange={c.messages.set}
              optional
            />
            <label
              htmlFor={`${consentId}-messages`}
              className="min-w-0 pt-2.5 text-small text-muted-foreground"
            >
              {c.messages.text}
            </label>
          </div>
        ) : null}
        {c.formError ? (
          <div id={`${uid}-form-err`} role="alert">
            <Problem>{c.formError}</Problem>
          </div>
        ) : null}
        <button
          type="submit"
          data-testid="wz-checkout-submit"
          aria-disabled={c.pending ? true : undefined}
          className={`w-full ${primaryClass}`}
        >
          {c.pending ? "Оформляем заказ…" : checkout.online ? "Оформить и оплатить" : "Оформить заказ"}
        </button>
        {terms ? (
          <p data-testid="wz-checkout-terms" className="text-small text-muted-foreground">
            Оформляя заказ, вы принимаете условия{" "}
            <a href={terms.offer.href} target="_blank" rel="noopener" className={termsLinkClass}>
              публичной оферты
            </a>
            {terms.delivery || terms.returns ? (
              <>
                {". "}
                {[terms.delivery, terms.returns]
                  .filter((l): l is Link => !!l)
                  .map((l, i) => (
                    <Fragment key={l.href}>
                      {i > 0 ? " · " : null}
                      <a href={l.href} target="_blank" rel="noopener" className={termsLinkClass}>
                        {l.label}
                      </a>
                    </Fragment>
                  ))}
              </>
            ) : null}
          </p>
        ) : null}
        {note ? <p className="text-small text-muted-foreground">{note}</p> : null}
      </form>
    </div>
  );
}

export default function CartSplit(props: CartSplitProps) {
  const { title, level = 2, checkout, back, empty, note, terms } = props;
  const c = useCheckout(checkout);
  const uid = useId();
  const Title = level === 1 ? "h1" : "h2";
  const placed = c.placed;
  return (
    <section
      data-wz-component="ShopCart"
      data-wz-id={props.wzId}
      aria-labelledby={`${uid}-title`}
      className="bg-background py-section font-sans text-foreground"
    >
      <div className="mx-auto w-full max-w-page px-gutter">
        <Title
          id={`${uid}-title`}
          className={`font-display font-bold text-balance wrap-break-word ${level === 1 ? "text-h1" : "text-h2"}`}
        >
          {title}
        </Title>
        {placed ? (
          <p role="status" className="mt-6 text-lead">
            {`Заказ №${placed.number} оформлен — открываем ${placed.pay ? "оплату" : "его страницу"}…`}
          </p>
        ) : (
          <div className="mt-8 grid gap-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start lg:gap-12">
            <div className="min-w-0">
              <Lines c={c} empty={empty} back={back} />
              {back && c.cart.lines.length > 0 ? (
                <p className="mt-6">
                  <a href={back.href} className={backClass}>
                    <span aria-hidden="true">←</span>
                    {back.label}
                  </a>
                </p>
              ) : null}
            </div>
            {c.cart.lines.length > 0 ? (
              <div className="min-w-0 lg:sticky lg:top-8">
                <Checkout c={c} checkout={checkout} level={level} note={note} terms={terms} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
