// Team «portraits»: a grid of 3:4 portraits with the name and role under each — two columns on phones, three or four
// on desktop; a person without a photo keeps their place with initials on a quiet field, never a stock face
// (catalog I02). Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo?: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamPortraitsProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center text-small font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Initials of a name for a person without a photo. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default function TeamPortraits({ title, intro, people, action, note }: TeamPortraitsProps) {
  const cols = people.length === 3 || people.length > 4 ? "lg:grid-cols-3" : "lg:grid-cols-4";
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <ul className={`mt-12 grid grid-cols-2 gap-x-4 gap-y-10 sm:gap-x-6 ${cols} lg:gap-x-8 lg:gap-y-14`}>
          {people.map((p) => (
            <li key={p.name} className="min-w-0">
              {p.photo ? (
                <img
                  src={p.photo.src}
                  srcSet={srcSetOf(p.photo.src)}
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  alt={p.photo.alt}
                  loading="lazy"
                  className="aspect-3/4 w-full rounded-md bg-muted object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex aspect-3/4 w-full items-center justify-center rounded-md bg-muted font-display text-h1 font-bold text-muted-foreground"
                >
                  {initials(p.name)}
                </div>
              )}
              <h3 className="mt-4 font-display text-h3 font-bold text-balance wrap-break-word">{p.name}</h3>
              <p className="mt-1 text-small text-pretty text-muted-foreground">{p.role}</p>
              {p.link ? (
                <a href={p.link.href} className={linkClass}>
                  {p.link.label}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
        {note || action ? (
          <div className="mt-12 flex flex-col gap-5 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between">
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
