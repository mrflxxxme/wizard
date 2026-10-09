// Team «lead»: the head of the business carries the section — a large portrait, name, role, a few lines in their own
// words and booking with them — while the rest of the team sits beside as smaller square portraits with names and
// roles. Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo?: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamLeadProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Initials of a name for a person without a photo. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default function TeamLead({ title, intro, people, action, note }: TeamLeadProps) {
  const [lead, ...rest] = people;
  if (!lead) return null;
  const cta = lead.link ?? action;
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
          <article className="grid min-w-0 gap-6 sm:grid-cols-2 sm:items-end lg:col-span-7 lg:self-start">
            {lead.photo ? (
              <img
                src={lead.photo.src}
                srcSet={srcSetOf(lead.photo.src)}
                sizes="(min-width: 1024px) 50vw, 100vw"
                alt={lead.photo.alt}
                loading="lazy"
                className="aspect-4/5 w-full rounded-lg bg-muted object-cover"
              />
            ) : null}
            <div className="min-w-0">
              <h3 className="font-display text-h1 font-bold text-balance wrap-break-word">{lead.name}</h3>
              <p className="mt-2 text-body text-muted-foreground">{lead.role}</p>
              {lead.bio ? <p className="mt-5 text-body text-pretty">{lead.bio}</p> : null}
              {cta ? (
                <a href={cta.href} className={`mt-6 ${primaryClass}`}>
                  {cta.label}
                </a>
              ) : null}
            </div>
          </article>
          <div className="min-w-0 lg:col-span-4 lg:col-start-9 lg:border-l lg:border-border lg:pl-8">
            <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 lg:grid-cols-2">
              {rest.map((p) => (
                <li key={p.name} className="min-w-0">
                  {p.photo ? (
                    <img
                      src={p.photo.src}
                      srcSet={srcSetOf(p.photo.src)}
                      sizes="(min-width: 1024px) 25vw, 50vw"
                      alt={p.photo.alt}
                      loading="lazy"
                      className="aspect-square w-full rounded-md bg-muted object-cover"
                    />
                  ) : (
                    <div
                      aria-hidden="true"
                      className="flex aspect-square w-full items-center justify-center rounded-md bg-muted font-display text-h2 font-bold text-muted-foreground"
                    >
                      {initials(p.name)}
                    </div>
                  )}
                  <h3 className="mt-3 text-body font-bold text-balance wrap-break-word">{p.name}</h3>
                  <p className="text-small text-pretty text-muted-foreground">{p.role}</p>
                </li>
              ))}
            </ul>
            {note ? <p className="mt-8 text-small text-muted-foreground">{note}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
