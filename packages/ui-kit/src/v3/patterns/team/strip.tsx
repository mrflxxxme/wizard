// Team «strip»: a quiet tinted band with the title and a strip of portraits scrolled by hand with snap points (no
// autoplay, catalog M06, D1 Gallery scroll-snap); on desktop four portraits fill the row and the rest scroll.
// Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamStripProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function TeamStrip({ title, intro, people, action, note }: TeamStripProps) {
  return (
    <section className="bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl min-w-0">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {intro ? <p className="mt-4 text-body text-pretty text-muted-foreground">{intro}</p> : null}
          </div>
          {action ? (
            <a href={action.href} className={`shrink-0 ${linkClass}`}>
              <span>{action.label}</span>
              <span aria-hidden="true">→</span>
            </a>
          ) : null}
        </div>
        <section
          aria-label={title}
          className="-mx-gutter mt-10 snap-x snap-mandatory scroll-px-gutter overflow-x-auto px-gutter pb-4"
        >
          <ul className="flex gap-4 lg:gap-6">
            {people.map((p) => (
              <li key={p.name} className="w-64 shrink-0 snap-start sm:w-72 lg:w-[calc((100%-4.5rem)/4)]">
                <img
                  src={p.photo.src}
                  srcSet={srcSetOf(p.photo.src)}
                  sizes="(min-width: 1024px) 25vw, 50vw"
                  alt={p.photo.alt}
                  loading="lazy"
                  className="aspect-3/4 w-full rounded-md bg-background object-cover"
                />
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
        </section>
        {note ? <p className="mt-6 text-small text-muted-foreground">{note}</p> : null}
      </div>
    </section>
  );
}
