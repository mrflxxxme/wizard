// Services «photo menu»: a photo of the place across the whole section and, set on it at the right, a solid card
// like a menu board — names with dotted leaders to their prices, a line of description under each, a note and the
// action. Text never sits on the photo itself (catalog I04, I05); on phones the photo comes first and the card
// overlaps its lower edge. Own composition.
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

export type ServicesPhotoMenuProps = {
  title: string;
  intro?: string;
  items: Service[];
  image: Image;
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 w-full items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto";

export default function ServicesPhotoMenu({
  title,
  intro,
  items,
  image,
  action,
  note,
}: ServicesPhotoMenuProps) {
  return (
    <section className="relative isolate bg-background font-sans text-foreground lg:bg-muted">
      <img
        src={image.src}
        srcSet={srcSetOf(image.src)}
        sizes="100vw"
        alt={image.alt}
        loading="lazy"
        className="aspect-4/3 w-full bg-muted object-cover lg:absolute lg:inset-0 lg:-z-10 lg:aspect-auto lg:h-full"
      />
      <div className="mx-auto w-full max-w-page px-gutter pb-section lg:py-section">
        <div className="relative -mt-16 rounded-lg bg-card p-6 text-card-foreground shadow-md sm:p-10 lg:mt-0 lg:ml-auto lg:max-w-xl">
          <h2 className="font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? <p className="mt-3 text-body text-pretty text-muted-foreground">{intro}</p> : null}
          <ul className="mt-8 grid gap-5">
            {items.map((s) => (
              <li key={s.title} className="min-w-0">
                <div className="flex items-baseline gap-3">
                  <h3 className="min-w-0 text-lead font-bold wrap-break-word">{s.title}</h3>
                  <span
                    aria-hidden="true"
                    className="min-w-6 flex-1 border-b-2 border-dotted border-border"
                  />
                  {s.price ? (
                    <p className="text-lead font-bold whitespace-nowrap tabular-nums">{s.price}</p>
                  ) : null}
                </div>
                {s.text || s.duration ? (
                  <p className="mt-1 text-small text-pretty text-muted-foreground">
                    {[s.duration, s.text].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {note ? (
            <p className="mt-8 border-t border-border pt-5 text-small text-muted-foreground">{note}</p>
          ) : null}
          {action ? (
            <a href={action.href} className={`mt-6 ${primaryClass}`}>
              {action.label}
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
