// Pricing «split photo»: a tall photo of the work or the place on one half (it stays in view while the list scrolls
// on wide screens), a short price list between rules with the action on the other; on phones the photo comes first
// as a wide band. Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Price = { amount: number; from?: boolean; unit?: string };
type Item = { name: string; text?: string; detail?: string; price: Price };

export type PricingSplitPhotoProps = {
  title: string;
  lead?: string;
  items: Item[];
  image: Image;
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

export default function PricingSplitPhoto({
  title,
  lead,
  items,
  image,
  note,
  action,
}: PricingSplitPhotoProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-14">
        <div className="min-w-0 lg:col-span-5">
          <img
            src={image.src}
            srcSet={srcSetOf(image.src)}
            sizes="(min-width: 1024px) 50vw, 100vw"
            alt={image.alt}
            loading="lazy"
            className="aspect-16/10 w-full rounded-lg bg-muted object-cover lg:sticky lg:top-8 lg:aspect-3/4"
          />
        </div>
        <div className="min-w-0 lg:col-span-7">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-4 max-w-text text-body text-muted-foreground">{lead}</p> : null}
          <ul className="mt-8 divide-y divide-border border-y border-border lg:mt-10">
            {items.map((it) => (
              <li key={it.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 py-5">
                <p className="text-lead font-bold wrap-break-word">{it.name}</p>
                <p className="text-lead font-bold whitespace-nowrap tabular-nums">{rub(it.price)}</p>
                {it.detail || it.text ? (
                  <p className="mt-1 text-small text-muted-foreground">
                    {[it.detail, it.text].filter(Boolean).join(". ")}
                  </p>
                ) : null}
                {it.price.unit ? (
                  <p className="col-start-2 mt-1 text-right text-small text-muted-foreground">
                    {it.price.unit}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {action ? (
            <a
              href={action.href}
              className="mt-8 inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {action.label}
            </a>
          ) : null}
          {note ? <p className="mt-6 max-w-text text-small text-muted-foreground">{note}</p> : null}
        </div>
      </div>
    </section>
  );
}
