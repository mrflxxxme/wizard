// Pricing «cards»: two to four plans side by side; each card is a subgrid of the row, so names, prices, lists and
// buttons line up across cards whatever the text length (catalog L19). The recommended plan — only when the owner
// names it — stands out by colour and a label, not by height (catalog D1 Pricing). Own composition.
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

export type PricingCardsProps = {
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

const COLUMNS: Record<number, string> = {
  2: "md:grid-cols-2 lg:max-w-4xl",
  3: "md:grid-cols-2 lg:grid-cols-3",
  4: "md:grid-cols-2 lg:grid-cols-4",
};

export default function PricingCards({ title, lead, plans, note }: PricingCardsProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <ul className={`mt-10 grid gap-x-5 gap-y-5 lg:mt-14 ${COLUMNS[plans.length] ?? ""}`}>
          {plans.map((p) => (
            <li
              key={p.name}
              className={`row-span-5 grid grid-rows-subgrid gap-y-0 rounded-lg bg-card p-6 text-card-foreground sm:p-8 ${p.recommended ? "border-2 border-primary" : "border border-border"}`}
            >
              <div className="min-w-0">
                {p.recommended ? (
                  <p className="mb-4 inline-flex rounded-sm bg-primary px-2 py-1 text-small font-bold text-primary-foreground">
                    Рекомендуем
                  </p>
                ) : null}
                <h3 className="font-display text-h3 font-bold text-balance wrap-break-word">{p.name}</h3>
                {p.detail ? <p className="mt-1 text-small text-muted-foreground">{p.detail}</p> : null}
              </div>
              <div className="mt-6">
                <p className="font-display text-h1 font-bold whitespace-nowrap tabular-nums">
                  {rub(p.price)}
                </p>
                {p.price.unit ? <p className="text-small text-muted-foreground">{p.price.unit}</p> : null}
              </div>
              <div className="mt-4">
                {p.text ? <p className="text-body text-muted-foreground">{p.text}</p> : null}
              </div>
              <ul className="mt-6 flex flex-col gap-3 border-t border-border pt-6">
                {p.features.map((f) => (
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
                href={p.action.href}
                className={`mt-8 inline-flex min-h-11 w-full items-center justify-center self-end rounded-control px-6 text-center text-body font-bold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${p.recommended ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-foreground text-foreground hover:bg-muted"}`}
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
