// Services «numbered»: a programme or a sequence of work stages in its real order — numbers only because the order
// is real (catalog L05). Columns under a heavy rule with large numerals on desktop, a vertical line with the same
// numerals on phones; durations and prices sit on one baseline at the foot of each column (L19). Own composition.
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

export type ServicesNumberedProps = {
  title: string;
  intro?: string;
  items: Service[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ServicesNumbered({ title, intro, items, action, note }: ServicesNumberedProps) {
  const cols = items.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3";
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <ol className={`mt-12 grid gap-y-10 md:grid-cols-2 md:gap-x-10 lg:gap-x-8 lg:gap-y-14 ${cols}`}>
          {items.map((s, i) => (
            <li
              key={s.title}
              className="relative flex min-w-0 flex-col border-l-2 border-foreground pl-6 md:border-t-2 md:border-l-0 md:pt-6 md:pl-0"
            >
              <span
                aria-hidden="true"
                className="font-display text-hero leading-none font-bold text-muted-foreground tabular-nums"
              >
                {i + 1}
              </span>
              <h3 className="mt-4 font-display text-h3 font-bold text-balance wrap-break-word">{s.title}</h3>
              {s.text ? <p className="mt-3 text-body text-pretty text-muted-foreground">{s.text}</p> : null}
              {s.points?.length ? (
                <ul className="mt-3 grid gap-1 text-small text-muted-foreground">
                  {s.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              ) : null}
              {s.duration || s.price ? (
                <p className="mt-auto flex flex-wrap items-baseline justify-between gap-x-4 pt-5 text-small font-bold">
                  <span>{s.duration}</span>
                  {s.price ? <span className="tabular-nums">{s.price}</span> : null}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
        {note || action ? (
          <div className="mt-14 flex flex-col gap-5 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between">
            {note ? <p className="text-body text-muted-foreground">{note}</p> : <span aria-hidden="true" />}
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
