// Services «bento»: the main service with its photo in a large cell, the others in cells of different width and tone —
// one contrasting, one quiet, the rest filling the last row exactly, so there are as many cells as services and no
// holes (catalog D1 Features bento, L12). Own composition.
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

export type ServicesBentoProps = {
  title: string;
  intro?: string;
  items: Service[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Grid span of cell `i` of `n`: the first is large, the next two narrow, the rest share the last row evenly. */
function span(i: number, n: number): string {
  const md = i === 0 || ((n - 1) % 2 === 1 && i === n - 1) ? "md:col-span-2" : "";
  if (i === 0) return `${md} lg:col-span-4 lg:row-span-2`;
  if (i < 3) return `${md} lg:col-span-2`;
  const rest = n - 3;
  if (rest === 1) return `${md} lg:col-span-6`;
  if (rest === 2) return `${md} lg:col-span-3`;
  return `${md} lg:col-span-2`;
}

/** Tone of a cell: the second contrasts, the third and every other cell after it are quiet, the rest are cards. */
function tone(i: number): { cell: string; muted: string } {
  if (i === 1) return { cell: "bg-inverse text-inverse-foreground", muted: "text-inverse-foreground/80" };
  if (i % 2 === 0) return { cell: "bg-muted text-foreground", muted: "text-muted-foreground" };
  return { cell: "border border-border bg-card text-card-foreground", muted: "text-muted-foreground" };
}

export default function ServicesBento({ title, intro, items, action, note }: ServicesBentoProps) {
  const n = items.length;
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <ul className="mt-12 grid gap-3 md:grid-cols-2 lg:grid-cols-6 lg:gap-4">
          {items.map((s, i) => {
            const t = i === 0 ? tone(3) : tone(i);
            const lead = i === 0;
            return (
              <li
                key={s.title}
                className={`flex min-w-0 flex-col overflow-hidden rounded-lg ${t.cell} ${span(i, n)}`}
              >
                {lead && s.image ? (
                  <img
                    src={s.image.src}
                    srcSet={srcSetOf(s.image.src)}
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    alt={s.image.alt}
                    loading="lazy"
                    className="aspect-16/10 w-full bg-muted object-cover lg:aspect-auto lg:min-h-72 lg:flex-1"
                  />
                ) : null}
                <div
                  className={`flex min-w-0 flex-1 flex-col ${lead ? "p-6 sm:p-8 lg:flex-none" : "min-h-56 p-6"}`}
                >
                  <h3
                    className={`font-display font-bold text-balance wrap-break-word ${lead ? "text-h2" : "text-h3"}`}
                  >
                    {s.title}
                  </h3>
                  {s.text ? (
                    <p
                      className={`mt-3 text-pretty ${lead ? "max-w-text text-lead" : "text-body"} ${t.muted}`}
                    >
                      {s.text}
                    </p>
                  ) : null}
                  <div className="mt-auto flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pt-6">
                    <div className="min-w-0">
                      {s.duration ? <p className={`text-small ${t.muted}`}>{s.duration}</p> : null}
                      {s.price ? (
                        <p className="font-display text-h3 font-bold whitespace-nowrap tabular-nums">
                          {s.price}
                        </p>
                      ) : null}
                    </div>
                    {s.link ? (
                      <a
                        href={s.link.href}
                        className="inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-inherit underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
                      >
                        <span>{s.link.label}</span>
                        <span aria-hidden="true">→</span>
                      </a>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {note || action ? (
          <div className="mt-10 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
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
