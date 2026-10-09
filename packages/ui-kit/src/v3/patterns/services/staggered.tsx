// Services «staggered»: photo cards in two columns with the right column set lower (a transform; with an even count
// the grid reserves the space below), so the section reads as a portfolio rather than a tile grid. Under each photo
// the name and price share a line, the description and the link follow. On phones one column in order.
// Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Service = {
  title: string;
  text?: string;
  price?: string;
  duration?: string;
  points?: string[];
  image: Image;
  link?: Link;
};

export type ServicesStaggeredProps = {
  title: string;
  intro?: string;
  items: Service[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ServicesStaggered({ title, intro, items, action, note }: ServicesStaggeredProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <div
          className={`mt-12 grid gap-x-12 gap-y-14 md:grid-cols-2 lg:gap-x-20 ${items.length % 2 === 0 ? "md:pb-24 lg:pb-40" : ""}`}
        >
          {items.map((s) => (
            <article key={s.title} className="min-w-0 md:even:translate-y-24 lg:even:translate-y-40">
              <img
                src={s.image.src}
                alt={s.image.alt}
                loading="lazy"
                className="aspect-4/5 w-full rounded-lg bg-muted object-cover md:aspect-5/4"
              />
              <div className="mt-5 flex items-baseline justify-between gap-6 border-b border-border pb-3">
                <h3 className="min-w-0 font-display text-h2 font-bold text-balance wrap-break-word">
                  {s.title}
                </h3>
                {s.price ? (
                  <p className="text-body font-bold whitespace-nowrap tabular-nums">{s.price}</p>
                ) : null}
              </div>
              {s.text ? <p className="mt-3 text-body text-pretty text-muted-foreground">{s.text}</p> : null}
              {s.duration ? <p className="mt-2 text-small text-muted-foreground">{s.duration}</p> : null}
              {s.link ? (
                <a href={s.link.href} className={`mt-2 ${linkClass}`}>
                  <span>{s.link.label}</span>
                  <span aria-hidden="true">→</span>
                </a>
              ) : null}
            </article>
          ))}
        </div>
        {note || action ? (
          <div className="mt-14 flex flex-col gap-5 border-t-2 border-foreground pt-8 sm:flex-row sm:items-center sm:justify-between">
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
