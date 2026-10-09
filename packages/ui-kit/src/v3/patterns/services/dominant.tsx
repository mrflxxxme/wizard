// Services «dominant»: one main service carries the section — a wide photo, the name large, the description, what is
// included in two columns, price and booking — while the other services follow as a short priced list beside it
// (catalog D1 Features dominant-list, instead of three equal cards L01). Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

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

export type ServicesDominantProps = {
  title: string;
  intro?: string;
  items: Service[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ServicesDominant({ title, intro, items, action, note }: ServicesDominantProps) {
  const [main, ...rest] = items;
  if (!main) return null;
  const cta = main.link ?? action;
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <div className="mt-12 grid gap-12 lg:grid-cols-12 lg:gap-x-12">
          <article className="min-w-0 lg:col-span-7">
            {main.image ? (
              <img
                src={main.image.src}
                srcSet={srcSetOf(main.image.src)}
                sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                alt={main.image.alt}
                loading="lazy"
                className="aspect-3/2 w-full rounded-lg bg-muted object-cover"
              />
            ) : null}
            <div className="mt-8 flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2">
              <h3 className="min-w-0 font-display text-h1 font-bold text-balance wrap-break-word">
                {main.title}
              </h3>
              {main.price ? (
                <p className="font-display text-h2 font-bold whitespace-nowrap tabular-nums">{main.price}</p>
              ) : null}
            </div>
            {main.duration ? <p className="mt-1 text-body text-muted-foreground">{main.duration}</p> : null}
            {main.text ? <p className="mt-5 max-w-text text-lead text-pretty">{main.text}</p> : null}
            {main.points?.length ? (
              <ul className="mt-6 grid gap-x-8 gap-y-3 border-t border-border pt-6 sm:grid-cols-2">
                {main.points.map((p) => (
                  <li key={p} className="flex gap-3 text-body">
                    <span
                      aria-hidden="true"
                      className="mt-[0.45em] size-2.5 shrink-0 rounded-full bg-primary"
                    />
                    <span className="min-w-0">{p}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {cta ? (
              <a href={cta.href} className={`mt-8 ${primaryClass}`}>
                {cta.label}
              </a>
            ) : null}
          </article>
          <div className="min-w-0 lg:col-span-4 lg:col-start-9">
            <ul className="border-t-2 border-foreground">
              {rest.map((s) => (
                <li key={s.title} className="border-b border-border py-6">
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="min-w-0 font-display text-h3 font-bold text-balance wrap-break-word">
                      {s.title}
                    </h3>
                    {s.price ? (
                      <p className="text-body font-bold whitespace-nowrap tabular-nums">{s.price}</p>
                    ) : null}
                  </div>
                  {s.text ? (
                    <p className="mt-2 text-body text-pretty text-muted-foreground">{s.text}</p>
                  ) : null}
                  {s.duration ? <p className="mt-2 text-small text-muted-foreground">{s.duration}</p> : null}
                  {s.link ? (
                    <a href={s.link.href} className={`mt-1 ${linkClass}`}>
                      <span>{s.link.label}</span>
                      <span aria-hidden="true">→</span>
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
            {note ? <p className="mt-6 text-small text-muted-foreground">{note}</p> : null}
            {action && main.link ? (
              <a href={action.href} className={`mt-4 ${linkClass} underline`}>
                <span>{action.label}</span>
                <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
