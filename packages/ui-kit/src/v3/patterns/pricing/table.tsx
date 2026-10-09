// Pricing «table»: a real table «service — duration — price» under a heavy rule, prices right-aligned in tabular
// figures. Below md each row folds into a two-line block (name and price on top, duration and note under it), so the
// table never scrolls sideways at 390 px. Own composition.
import { useId } from "react";

type Link = { label: string; href: string };
type Price = { amount: number; from?: boolean; unit?: string };
type Item = { name: string; text?: string; detail?: string; price: Price };

export type PricingTableProps = {
  title: string;
  lead?: string;
  items: Item[];
  columns?: { name: string; detail?: string; price: string };
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

const headClass = "py-3 text-left align-bottom text-small font-bold text-muted-foreground";

export default function PricingTable({ title, lead, items, columns, note, action }: PricingTableProps) {
  const id = useId();
  const withDetail = items.some((it) => it.detail);
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 id={id} className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">
          {title}
        </h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <table aria-labelledby={id} className="mt-10 w-full border-collapse lg:mt-14">
          <thead className="max-md:hidden">
            <tr className="border-b-2 border-foreground">
              <th scope="col" className={`w-1/2 pr-6 ${headClass}`}>
                {columns?.name ?? "Услуга"}
              </th>
              {withDetail ? (
                <th scope="col" className={`pr-6 ${headClass}`}>
                  {columns?.detail ?? "Длительность"}
                </th>
              ) : null}
              <th scope="col" className={`text-right ${headClass}`}>
                {columns?.price ?? "Цена"}
              </th>
            </tr>
          </thead>
          <tbody className="max-md:block max-md:border-t-2 max-md:border-foreground">
            {items.map((it) => (
              <tr
                key={it.name}
                className="border-b border-border max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-4 max-md:gap-y-1 max-md:py-4"
              >
                <th scope="row" className="py-5 pr-6 text-left align-top font-normal max-md:p-0">
                  <span className="block text-body font-bold wrap-break-word">{it.name}</span>
                  {it.text ? (
                    <span className="mt-1 block text-small text-muted-foreground">{it.text}</span>
                  ) : null}
                </th>
                {withDetail ? (
                  <td className="py-5 pr-6 align-top text-body text-muted-foreground max-md:col-start-1 max-md:row-start-2 max-md:p-0 max-md:text-small">
                    {it.detail}
                  </td>
                ) : null}
                <td className="py-5 text-right align-top max-md:col-start-2 max-md:row-span-2 max-md:row-start-1 max-md:p-0">
                  <span className="block text-body font-bold whitespace-nowrap tabular-nums">
                    {rub(it.price)}
                  </span>
                  {it.price.unit ? (
                    <span className="block text-small text-muted-foreground">{it.price.unit}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {note || action ? (
          <div className="mt-8 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
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
    </section>
  );
}
