// Services «split with a photo»: the title, intro and a tall photo of the place stay pinned on the left while the
// services scroll by on the right — each with its price on the title line, a description, what is included and its
// own link; on phones the photo follows the intro. Own composition.
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

export type ServicesSplitMediaProps = {
  title: string;
  intro?: string;
  items: Service[];
  image: Image;
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const itemLinkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function ServicesSplitMedia({
  title,
  intro,
  items,
  image,
  action,
  note,
}: ServicesSplitMediaProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-12 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
        <div className="min-w-0 lg:sticky lg:top-8 lg:col-span-5 lg:self-start">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? <p className="mt-4 text-lead text-pretty text-muted-foreground">{intro}</p> : null}
          <img
            src={image.src}
            srcSet={srcSetOf(image.src)}
            sizes="(min-width: 1024px) 50vw, 100vw"
            alt={image.alt}
            loading="lazy"
            className="mt-8 aspect-4/3 w-full rounded-lg bg-muted object-cover lg:aspect-4/3"
          />
        </div>
        <div className="min-w-0 lg:col-span-6 lg:col-start-7">
          <ul className="grid gap-0">
            {items.map((s) => (
              <li
                key={s.title}
                className="border-t border-border py-8 first:border-t-0 first:pt-0 lg:first:pt-2"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <h3 className="min-w-0 font-display text-h2 font-bold text-balance wrap-break-word">
                    {s.title}
                  </h3>
                  {s.price ? (
                    <p className="font-display text-h3 font-bold whitespace-nowrap tabular-nums">{s.price}</p>
                  ) : null}
                </div>
                {s.duration ? <p className="mt-1 text-small text-muted-foreground">{s.duration}</p> : null}
                {s.text ? <p className="mt-4 text-body text-pretty">{s.text}</p> : null}
                {s.points?.length ? (
                  <ul className="mt-4 grid gap-2">
                    {s.points.map((p) => (
                      <li key={p} className="flex gap-3 text-body text-muted-foreground">
                        <span aria-hidden="true" className="mt-[0.8em] h-px w-4 shrink-0 bg-foreground" />
                        <span className="min-w-0">{p}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {s.link ? (
                  <a href={s.link.href} className={`mt-3 ${itemLinkClass}`}>
                    <span>{s.link.label}</span>
                    <span aria-hidden="true">→</span>
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
          {note || action ? (
            <div className="mt-4 flex flex-col items-start gap-4 border-t-2 border-foreground pt-8">
              {note ? <p className="text-small text-muted-foreground">{note}</p> : null}
              {action ? (
                <a href={action.href} className={primaryClass}>
                  {action.label}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
