// Pricing «tabs»: a long price list split by category into tabs (WAI-ARIA tabs: the arrow keys, Home and End move
// between them, only the chosen tab is in the tab order; on phones the row of tabs scrolls sideways edge to edge);
// the lines of a category run in two columns on wide screens (catalog D1 PriceList «grouped», L17). Own composition.
import { type KeyboardEvent, useId, useRef, useState } from "react";

type Price = { amount: number; from?: boolean; unit?: string };
type Item = { name: string; text?: string; detail?: string; price: Price };

export type PricingTabsProps = {
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

export default function PricingTabs({ title, lead, groups, note }: PricingTabsProps) {
  const id = useId();
  const [active, setActive] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const select = (i: number) => {
    const n = (i + groups.length) % groups.length;
    setActive(n);
    tabs.current[n]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, number> = {
      ArrowRight: active + 1,
      ArrowLeft: active - 1,
      Home: 0,
      End: groups.length - 1,
    };
    const to = keys[e.key];
    if (to === undefined) return;
    e.preventDefault();
    select(to);
  };
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2
          id={`${id}-title`}
          className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word"
        >
          {title}
        </h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <div
          role="tablist"
          aria-labelledby={`${id}-title`}
          onKeyDown={onKey}
          className="-mx-gutter mt-10 flex scroll-px-gutter gap-1 overflow-x-auto border-b border-border px-gutter lg:mx-0 lg:mt-12 lg:px-0"
        >
          {groups.map((g, i) => {
            const on = i === active;
            return (
              <button
                key={g.title}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${i}`}
                aria-selected={on}
                aria-controls={`${id}-panel-${i}`}
                tabIndex={on ? 0 : -1}
                onClick={() => setActive(i)}
                className={`min-h-12 shrink-0 border-b-2 px-4 text-body font-bold whitespace-nowrap transition-colors duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {g.title}
              </button>
            );
          })}
        </div>
        {groups.map((g, i) => (
          <div
            key={g.title}
            role="tabpanel"
            id={`${id}-panel-${i}`}
            aria-labelledby={`${id}-tab-${i}`}
            hidden={i !== active}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a tab panel without focusable content takes focus (WAI-ARIA tabs)
            tabIndex={0}
            className="focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <ul className="grid lg:grid-cols-2 lg:gap-x-16">
              {g.items.map((it) => (
                <li
                  key={it.name}
                  className="flex items-start justify-between gap-6 border-b border-border py-5 lg:py-6"
                >
                  <div className="min-w-0">
                    <p className="text-body font-bold wrap-break-word">{it.name}</p>
                    {it.text ? <p className="mt-1 text-small text-muted-foreground">{it.text}</p> : null}
                    {it.detail ? <p className="mt-1 text-small text-muted-foreground">{it.detail}</p> : null}
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
          </div>
        ))}
        {note ? <p className="mt-8 max-w-text text-small text-muted-foreground">{note}</p> : null}
      </div>
    </section>
  );
}
