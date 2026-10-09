// Services «editorial»: the section title set small as a rubric with the intro, then each service as a magazine row
// under a hairline — its name large in the display face on the left, on the right a small portrait-format photo when
// there is one beside the description, duration, price and its own link. Own composition.
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

export type ServicesEditorialProps = {
  title: string;
  intro?: string;
  items: Service[];
  action?: Link;
  note?: string;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ServicesEditorial({ title, intro, items, action, note }: ServicesEditorialProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="grid gap-4 border-b-2 border-foreground pb-8 lg:grid-cols-12 lg:gap-12">
          <h2 className="font-display text-h3 font-bold text-balance wrap-break-word lg:col-span-4">
            {title}
          </h2>
          {intro ? (
            <p className="max-w-text text-body text-pretty text-muted-foreground lg:col-span-6 lg:col-start-7">
              {intro}
            </p>
          ) : null}
        </div>
        <ul>
          {items.map((s) => (
            <li
              key={s.title}
              className="grid gap-6 border-b border-border py-10 lg:grid-cols-12 lg:gap-12 lg:py-14"
            >
              <h3 className="min-w-0 font-display text-h1 font-bold text-balance wrap-break-word hyphens-auto lg:col-span-7">
                {s.title}
              </h3>
              <div className="flex min-w-0 gap-5 lg:col-span-5 lg:pt-2">
                {s.image ? (
                  <img
                    src={s.image.src}
                    alt={s.image.alt}
                    loading="lazy"
                    className="aspect-3/4 w-24 shrink-0 self-start bg-muted object-cover sm:w-28"
                  />
                ) : null}
                <div className="flex min-w-0 flex-col items-start gap-3">
                  {s.text ? <p className="text-body text-pretty">{s.text}</p> : null}
                  {s.duration || s.price ? (
                    <p className="flex flex-wrap items-baseline gap-x-3 text-body">
                      {s.duration ? <span className="text-muted-foreground">{s.duration}</span> : null}
                      {s.duration && s.price ? (
                        <span aria-hidden="true" className="text-muted-foreground">
                          ·
                        </span>
                      ) : null}
                      {s.price ? <span className="font-bold tabular-nums">{s.price}</span> : null}
                    </p>
                  ) : null}
                  {s.link ? (
                    <a href={s.link.href} className={linkClass}>
                      <span>{s.link.label}</span>
                      <span aria-hidden="true">→</span>
                    </a>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
        {note || action ? (
          <div className="mt-10 grid lg:grid-cols-12 lg:gap-12">
            <div className="flex min-w-0 flex-col items-start gap-4 lg:col-span-5 lg:col-start-8">
              {note ? <p className="text-small text-muted-foreground">{note}</p> : null}
              {action ? (
                <a href={action.href} className={linkClass}>
                  <span>{action.label}</span>
                  <span aria-hidden="true">→</span>
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
