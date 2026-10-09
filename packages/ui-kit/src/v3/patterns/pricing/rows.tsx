// Pricing «rows»: a price list set like a printed one — the name and the price on one line joined by a dotted
// leader, the duration and a short note under them, the unit under the price; tabular figures keep the prices in
// one column (catalog D1 PriceList «rows», T17). Own composition.
type Link = { label: string; href: string };
type Price = { amount: number; from?: boolean; unit?: string };
type Item = { name: string; text?: string; detail?: string; price: Price };

export type PricingRowsProps = {
  title: string;
  lead?: string;
  items: Item[];
  note?: string;
  action?: Link;
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

export default function PricingRows({ title, lead, items, note, action }: PricingRowsProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="mx-auto max-w-4xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
          <ul className="mt-10 flex flex-col gap-7 lg:mt-14">
            {items.map((it) => (
              <li key={it.name}>
                <div className="flex items-baseline gap-3">
                  <p className="min-w-0 text-lead font-bold text-balance wrap-break-word">{it.name}</p>
                  <span
                    aria-hidden="true"
                    className="min-w-6 flex-1 border-b-2 border-dotted border-muted-foreground"
                  />
                  <p className="shrink-0 text-lead font-bold whitespace-nowrap tabular-nums">
                    {rub(it.price)}
                  </p>
                </div>
                {it.detail || it.text || it.price.unit ? (
                  <div className="mt-1 flex items-start justify-between gap-6 text-small text-muted-foreground">
                    <p className="min-w-0">
                      {it.detail ? <span className="font-bold">{it.detail}</span> : null}
                      {it.detail && it.text ? <span aria-hidden="true"> · </span> : null}
                      {it.text}
                    </p>
                    {it.price.unit ? <p className="shrink-0 text-right">{it.price.unit}</p> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {note || action ? (
            <div className="mt-12 flex flex-col gap-6 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
              {note ? <p className="max-w-text text-small text-muted-foreground">{note}</p> : null}
              {action ? (
                <a
                  href={action.href}
                  className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {action.label}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
