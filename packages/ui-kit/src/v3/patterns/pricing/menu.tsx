// Pricing «menu»: set like a printed menu on the centre axis — each category between two short rules, every line
// with its name in the display face, the note under it and the price below; categories pair up in two columns on wide
// screens. Suits cafés, salons and studios with a few lines per category. Own composition.
type Price = { amount: number; from?: boolean; unit?: string };
type Item = { name: string; text?: string; detail?: string; price: Price };

export type PricingMenuProps = {
  title: string;
  lead?: string;
  groups: { title: string; items: Item[] }[];
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

export default function PricingMenu({ title, lead, groups, note }: PricingMenuProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section text-center">
        <h2 className="mx-auto max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">
          {title}
        </h2>
        {lead ? <p className="mx-auto mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <div className="mx-auto mt-12 grid max-w-5xl gap-x-16 gap-y-14 lg:mt-16 lg:grid-cols-2">
          {groups.map((g) => (
            <div key={g.title} className="min-w-0">
              <h3 className="flex items-center gap-4 text-small font-bold text-muted-foreground">
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
                <span className="max-w-[75%] text-balance">{g.title}</span>
                <span aria-hidden="true" className="h-px flex-1 bg-border" />
              </h3>
              <ul className="mt-8 flex flex-col gap-8">
                {g.items.map((it) => (
                  <li key={it.name}>
                    <p className="font-display text-h3 font-bold text-balance wrap-break-word">{it.name}</p>
                    {it.text || it.detail ? (
                      <p className="mx-auto mt-1 max-w-sm text-small text-muted-foreground">
                        {[it.text, it.detail].filter(Boolean).join(", ")}
                      </p>
                    ) : null}
                    <p className="mt-2 text-body font-bold tabular-nums">
                      {rub(it.price)}
                      {it.price.unit ? (
                        <span className="font-normal text-muted-foreground"> {it.price.unit}</span>
                      ) : null}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {note ? <p className="mx-auto mt-14 max-w-text text-small text-muted-foreground">{note}</p> : null}
      </div>
    </section>
  );
}
