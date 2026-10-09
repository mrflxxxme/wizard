// Team «centered»: a small team on one axis — round portraits, the name, role and a couple of lines in the owner's
// words under each, booking with the person; for one to four people. Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo?: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamCenteredProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Initials of a name for a person without a photo. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default function TeamCentered({ title, intro, people, action, note }: TeamCenteredProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section text-center">
        <h2 className="mx-auto max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">
          {title}
        </h2>
        {intro ? (
          <p className="mx-auto mt-4 max-w-2xl text-lead text-pretty text-muted-foreground">{intro}</p>
        ) : null}
        <ul className="mt-14 flex flex-wrap justify-center gap-x-12 gap-y-14">
          {people.map((p) => (
            <li key={p.name} className="flex w-full max-w-xs min-w-0 flex-col items-center">
              {p.photo ? (
                <img
                  src={p.photo.src}
                  srcSet={srcSetOf(p.photo.src)}
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  alt={p.photo.alt}
                  loading="lazy"
                  className="size-40 rounded-full bg-muted object-cover"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex size-40 items-center justify-center rounded-full bg-muted font-display text-h1 font-bold text-muted-foreground"
                >
                  {initials(p.name)}
                </div>
              )}
              <h3 className="mt-6 font-display text-h3 font-bold text-balance wrap-break-word">{p.name}</h3>
              <p className="mt-1 text-small text-muted-foreground">{p.role}</p>
              {p.bio ? <p className="mt-4 text-body text-pretty">{p.bio}</p> : null}
              {p.link ? (
                <a href={p.link.href} className={`mt-2 ${linkClass}`}>
                  {p.link.label}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
        {note || action ? (
          <div className="mt-14 flex flex-col items-center gap-4">
            {action ? (
              <a href={action.href} className={primaryClass}>
                {action.label}
              </a>
            ) : null}
            {note ? <p className="text-small text-muted-foreground">{note}</p> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
