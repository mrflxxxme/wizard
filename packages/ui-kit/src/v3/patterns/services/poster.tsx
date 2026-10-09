// Services «poster»: a typographic index — the names of the services set large in the display face and run together
// like a poster, each with its price small at the top of the line (under the name on phones); under a rule the
// intro, a note and the action. For studios whose services are known by name; descriptions live on their own pages.
// Own composition.
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

export type ServicesPosterProps = {
  title: string;
  intro?: string;
  items: Service[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ServicesPoster({ title, intro, items, action, note }: ServicesPosterProps) {
  // Fewer names carry the largest step; a longer index steps down so it stays a poster, not a wall.
  const size = items.length <= 4 ? "text-hero" : "text-h1";
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="text-body font-bold text-muted-foreground">{title}</h2>
        <ul
          className={`mt-6 flex flex-wrap items-baseline gap-x-10 gap-y-3 font-display font-bold wrap-break-word hyphens-auto lg:gap-x-14 ${size}`}
        >
          {items.map((s) => (
            <li key={s.title} className="flex min-w-0 flex-col items-start sm:block">
              {s.link ? (
                <a
                  href={s.link.href}
                  className="inline-flex min-h-11 items-center text-foreground underline decoration-transparent decoration-4 underline-offset-8 transition-colors duration-200 hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                >
                  {s.title}
                </a>
              ) : (
                s.title
              )}
              {s.price ? (
                <span className="font-sans sm:ml-2 sm:align-top text-small font-bold whitespace-nowrap text-muted-foreground tabular-nums">
                  {s.price}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {intro || note || action ? (
          <div className="mt-12 grid gap-6 border-t border-border pt-8 md:grid-cols-12 md:items-start md:gap-10">
            <div className="min-w-0 md:col-span-7 lg:col-span-6">
              {intro ? <p className="text-lead text-pretty">{intro}</p> : null}
              {note ? <p className="mt-3 text-small text-muted-foreground">{note}</p> : null}
            </div>
            {action ? (
              <div className="md:col-span-5 md:justify-self-end lg:col-span-6">
                <a href={action.href} className={primaryClass}>
                  {action.label}
                </a>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
