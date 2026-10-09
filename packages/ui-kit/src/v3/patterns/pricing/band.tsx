// Pricing «band»: the plans as wide rows on a tinted band — name and term, what is included in a run of short
// phrases, the price and the action on one line from lg, stacked on phones. The recommended plan gets a brand rule
// and a label, never extra height (catalog D1 Pricing). Own composition.
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

export type PricingBandProps = {
  title: string;
  lead?: string;
  plans: Plan[];
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

export default function PricingBand({ title, lead, plans, note }: PricingBandProps) {
  return (
    <section className="bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <ul className="mt-10 flex flex-col gap-3 lg:mt-14">
          {plans.map((p) => (
            <li
              key={p.name}
              className={`grid gap-5 rounded-lg bg-card p-6 text-card-foreground sm:p-8 lg:grid-cols-12 lg:items-center lg:gap-8 ${p.recommended ? "border-2 border-primary" : "border border-transparent"}`}
            >
              <div className="min-w-0 lg:col-span-3">
                {p.recommended ? (
                  <p className="mb-2 inline-flex rounded-sm bg-primary px-2 py-0.5 text-small font-bold text-primary-foreground">
                    Рекомендуем
                  </p>
                ) : null}
                <h3 className="font-display text-h3 font-bold text-balance wrap-break-word">{p.name}</h3>
                {p.detail ? <p className="mt-1 text-small text-muted-foreground">{p.detail}</p> : null}
              </div>
              <ul className="flex min-w-0 flex-wrap gap-x-5 gap-y-1 text-body text-muted-foreground lg:col-span-5">
                {p.features.map((f) => (
                  <li key={f} className="flex items-baseline gap-2">
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 translate-y-[-0.2em] rounded-full bg-current"
                    />
                    <span className="min-w-0 wrap-break-word">{f}</span>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-t border-border pt-5 lg:col-span-4 lg:flex-col lg:items-end lg:border-t-0 lg:pt-0 lg:text-right">
                <div className="min-w-0">
                  <p className="font-display text-h2 font-bold whitespace-nowrap tabular-nums">
                    {rub(p.price)}
                  </p>
                  {p.price.unit ? <p className="text-small text-muted-foreground">{p.price.unit}</p> : null}
                </div>
                <a
                  href={p.action.href}
                  className={`inline-flex min-h-11 max-w-full min-w-11 items-center justify-center rounded-control px-5 text-center text-body font-bold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${p.recommended ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-foreground text-foreground hover:bg-muted"}`}
                >
                  {p.action.label}
                </a>
              </div>
            </li>
          ))}
        </ul>
        {note ? <p className="mt-8 max-w-text text-small text-muted-foreground">{note}</p> : null}
      </div>
    </section>
  );
}
