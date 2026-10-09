// Pricing «featured»: the main offer on a brand-colour panel across seven columns — name, price set large, what is
// included and the action — and the other prices as a quiet list beside it (catalog D1 Features «dominant-list»
// applied to prices). Own composition.
type Link = { label: string; href: string };
type Price = { amount: number; from?: boolean; unit?: string };
type Item = { name: string; text?: string; detail?: string; price: Price };
type Plan = Item & { features: string[]; recommended?: boolean; action: Link };

export type PricingFeaturedProps = {
  title: string;
  lead?: string;
  offer: Plan;
  items: Item[];
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

export default function PricingFeatured({ title, lead, offer, items, note }: PricingFeaturedProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <div className="mt-10 grid gap-10 lg:mt-14 lg:grid-cols-12 lg:gap-12">
          <article className="flex min-w-0 flex-col rounded-lg bg-primary p-6 text-primary-foreground sm:p-10 lg:col-span-7">
            <h3 className="font-display text-h2 font-bold text-balance wrap-break-word">{offer.name}</h3>
            {offer.detail ? <p className="mt-2 text-body">{offer.detail}</p> : null}
            <p className="mt-8 font-display text-hero leading-none font-bold whitespace-nowrap tabular-nums">
              {rub(offer.price)}
            </p>
            {offer.price.unit ? <p className="mt-2 text-body">{offer.price.unit}</p> : null}
            {offer.text ? <p className="mt-8 max-w-text text-lead">{offer.text}</p> : null}
            <ul className="mt-8 flex flex-col gap-3 border-t border-primary-foreground/40 pt-6">
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
            <a
              href={offer.action.href}
              className="mt-10 inline-flex min-h-12 items-center justify-center self-start rounded-control bg-primary-foreground px-6 text-center text-body font-bold text-primary transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground max-sm:w-full"
            >
              {offer.action.label}
            </a>
          </article>
          <div className="min-w-0 lg:col-span-5">
            <ul className="divide-y divide-border border-y border-border">
              {items.map((it) => (
                <li key={it.name} className="flex items-start justify-between gap-6 py-5">
                  <div className="min-w-0">
                    <p className="text-body font-bold wrap-break-word">{it.name}</p>
                    {it.detail || it.text ? (
                      <p className="mt-1 text-small text-muted-foreground">
                        {[it.detail, it.text].filter(Boolean).join(". ")}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-body font-bold whitespace-nowrap tabular-nums">{rub(it.price)}</p>
                    {it.price.unit ? (
                      <p className="mt-1 text-small text-muted-foreground">{it.price.unit}</p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            {note ? <p className="mt-6 text-small text-muted-foreground">{note}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
