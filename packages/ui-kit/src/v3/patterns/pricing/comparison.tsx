// Pricing «comparison»: from md a table with the plans as columns (name, price, action in the head) and what each
// includes as rows, ticks and dashes named for screen readers; below md every plan becomes its own block with the
// same rows as a list, so nothing scrolls sideways (catalog D1 Pricing «comparison»). Own composition.
type Link = { label: string; href: string };
type Price = { amount: number; from?: boolean; unit?: string };
type Plan = {
  name: string;
  text?: string;
  detail?: string;
  price: Price;
  features: string[];
  recommended?: boolean;
  action: Link;
};

export type PricingComparisonProps = {
  title: string;
  lead?: string;
  plans: Plan[];
  compare: { label: string; values: (boolean | string)[] }[];
  note?: string;
};

/** Narrow no-break space between digit groups, no-break space before the sign (Russian typesetting of sums). */
const NNBSP = String.fromCharCode(0x202f);
const NBSP = String.fromCharCode(0xa0);

/** «2 500 ₽», «от 1 200 ₽»: digit groups split by a narrow no-break space, the sign after a no-break space. */
function rub(p: Price): string {
  const [int = "", frac] = p.amount.toFixed(Number.isInteger(p.amount) ? 0 : 2).split(".");
  const sum = `${int.replace(/\B(?=(\d{3})+(?!\d))/g, NNBSP)}${frac ? `,${frac}` : ""}${NBSP}₽`;
  return p.from ? `от${NBSP}${sum}` : sum;
}

/** A value of the comparison: a tick or a dash with a spoken name, or the text as given. */
function Value({ v }: { v: boolean | string | undefined }) {
  if (typeof v === "string") return <span className="text-body font-bold">{v}</span>;
  return v ? (
    <svg
      role="img"
      aria-label="Есть"
      viewBox="0 0 16 16"
      className="inline size-5 fill-none stroke-current stroke-2"
    >
      <path d="M2.5 8.5l3.5 3.5 7.5-8" />
    </svg>
  ) : (
    <svg
      role="img"
      aria-label="Нет"
      viewBox="0 0 16 16"
      className="inline size-5 fill-none stroke-current stroke-2 text-muted-foreground"
    >
      <path d="M4 8h8" />
    </svg>
  );
}

const actionClass =
  "inline-flex min-h-11 items-center justify-center rounded-control px-5 text-center text-body font-bold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const primaryClass = "bg-primary text-primary-foreground hover:bg-primary/90";
const outlineClass = "border border-foreground text-foreground hover:bg-muted";

export default function PricingComparison({ title, lead, plans, compare, note }: PricingComparisonProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}

        <table className="mt-14 hidden w-full table-fixed border-collapse md:table">
          <thead>
            <tr>
              <td className="w-1/4" />
              {plans.map((p) => (
                <th
                  key={p.name}
                  scope="col"
                  className={`px-4 pt-6 pb-8 text-left align-bottom font-normal ${p.recommended ? "rounded-t-lg bg-muted" : ""}`}
                >
                  {p.recommended ? (
                    <span className="mb-3 inline-flex rounded-sm bg-primary px-2 py-1 text-small font-bold text-primary-foreground">
                      Рекомендуем
                    </span>
                  ) : null}
                  <span className="block font-display text-h3 font-bold text-balance wrap-break-word">
                    {p.name}
                  </span>
                  <span className="mt-3 block text-h2 font-bold whitespace-nowrap tabular-nums">
                    {rub(p.price)}
                  </span>
                  <span className="block min-h-6 text-small text-muted-foreground">
                    {p.price.unit ?? p.detail}
                  </span>
                  <a
                    href={p.action.href}
                    className={`mt-5 w-full ${actionClass} ${p.recommended ? primaryClass : outlineClass}`}
                  >
                    {p.action.label}
                  </a>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {compare.map((row) => (
              <tr key={row.label} className="border-t border-border">
                <th scope="row" className="py-4 pr-4 text-left align-top text-body font-normal">
                  {row.label}
                </th>
                {plans.map((p, i) => (
                  <td key={p.name} className={`px-4 py-4 align-top ${p.recommended ? "bg-muted" : ""}`}>
                    <Value v={row.values[i]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <ul className="mt-10 flex flex-col gap-5 md:hidden">
          {plans.map((p, i) => (
            <li
              key={p.name}
              className={`rounded-lg p-6 ${p.recommended ? "border-2 border-primary" : "border border-border"}`}
            >
              {p.recommended ? (
                <p className="mb-3 inline-flex rounded-sm bg-primary px-2 py-1 text-small font-bold text-primary-foreground">
                  Рекомендуем
                </p>
              ) : null}
              <h3 className="font-display text-h3 font-bold wrap-break-word">{p.name}</h3>
              <p className="mt-2 text-h2 font-bold tabular-nums">{rub(p.price)}</p>
              {(p.price.unit ?? p.detail) ? (
                <p className="text-small text-muted-foreground">{p.price.unit ?? p.detail}</p>
              ) : null}
              <dl className="mt-5 border-t border-border">
                {compare.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-start justify-between gap-4 border-b border-border py-3"
                  >
                    <dt className="min-w-0 text-body">{row.label}</dt>
                    <dd className="shrink-0 text-right">
                      <Value v={row.values[i]} />
                    </dd>
                  </div>
                ))}
              </dl>
              <a
                href={p.action.href}
                className={`mt-5 flex w-full ${actionClass} ${p.recommended ? primaryClass : outlineClass}`}
              >
                {p.action.label}
              </a>
            </li>
          ))}
        </ul>
        {note ? <p className="mt-8 max-w-text text-small text-muted-foreground">{note}</p> : null}
      </div>
    </section>
  );
}
