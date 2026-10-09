// Pricing «single»: one offer as a panel on a tinted field — what it is and what is included on the left in two
// columns of ticks, the price set large with the one action on the right (catalog D1 Pricing «single-plan»).
// Own composition.
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

export type PricingSingleProps = {
  title: string;
  lead?: string;
  offer: Plan;
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

export default function PricingSingle({ title, lead, offer, note }: PricingSingleProps) {
  return (
    <section className="bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <div className="mt-10 grid overflow-hidden rounded-lg border border-border bg-card text-card-foreground lg:mt-14 lg:grid-cols-12">
          <div className="min-w-0 p-6 sm:p-10 lg:col-span-7 lg:p-12">
            <h3 className="font-display text-h2 font-bold text-balance wrap-break-word">{offer.name}</h3>
            {offer.detail ? <p className="mt-2 text-body text-muted-foreground">{offer.detail}</p> : null}
            {offer.text ? <p className="mt-6 max-w-text text-lead">{offer.text}</p> : null}
            <ul className="mt-8 grid gap-x-8 gap-y-4 border-t border-border pt-8 sm:grid-cols-2">
              {offer.features.map((f) => (
                <li key={f} className="flex gap-3 text-body">
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="mt-1.5 size-4 shrink-0 fill-none stroke-current stroke-2"
                  >
                    <path d="M2.5 8.5l3.5 3.5 7.5-8" />
                  </svg>
                  <span className="min-w-0 wrap-break-word">{f}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex min-w-0 flex-col justify-between gap-10 border-t border-border p-6 sm:p-10 lg:col-span-5 lg:border-t-0 lg:border-l lg:p-12">
            <div>
              <p className="font-display text-hero leading-none font-bold whitespace-nowrap tabular-nums">
                {rub(offer.price)}
              </p>
              {offer.price.unit ? (
                <p className="mt-3 text-body text-muted-foreground">{offer.price.unit}</p>
              ) : null}
            </div>
            <div>
              <a
                href={offer.action.href}
                className="inline-flex min-h-12 w-full items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {offer.action.label}
              </a>
              {note ? <p className="mt-4 text-small text-muted-foreground">{note}</p> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
