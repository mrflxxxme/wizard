// Services «price list»: the title and intro above, then the services as rows of a price list under a heavy rule —
// name with a short description and its own link, duration, price in tabular figures at the right edge (catalog D1
// PriceList rows, T17); a practical note and the action close the list. Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Service = {
  title: string;
  text?: string;
  price?: string;
  duration?: string;
  points?: string[];
  image?: Image;
  link?: Link;
};

export type ServicesPriceListProps = {
  title: string;
  intro?: string;
  items: Service[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const rowLinkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ServicesPriceList({ title, intro, items, action, note }: ServicesPriceListProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <ul className="mt-12 border-t-2 border-foreground">
          {items.map((s) => (
            <li
              key={s.title}
              className="grid gap-x-8 gap-y-3 border-b border-border py-6 md:grid-cols-12 md:items-baseline md:py-8"
            >
              <div className="min-w-0 md:col-span-7">
                <h3 className="font-display text-h3 font-bold text-balance wrap-break-word">{s.title}</h3>
                {s.text ? <p className="mt-2 max-w-text text-body text-muted-foreground">{s.text}</p> : null}
                {s.link ? (
                  <a href={s.link.href} className={`mt-2 ${rowLinkClass}`}>
                    {s.link.label}
                  </a>
                ) : null}
              </div>
              <div className="flex min-w-0 items-baseline justify-between gap-6 md:col-span-5 md:grid md:grid-cols-5">
                <p className="text-small text-muted-foreground md:col-span-2 md:text-right">{s.duration}</p>
                {s.price ? (
                  <p className="font-display text-h3 font-bold whitespace-nowrap tabular-nums md:col-span-3 md:text-right">
                    {s.price}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {note || action ? (
          <div className="mt-8 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            {note ? <p className="text-small text-muted-foreground">{note}</p> : <span aria-hidden="true" />}
            {action ? (
              <a href={action.href} className={primaryClass}>
                {action.label}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
