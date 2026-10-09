// Team «single host»: one person carries the section — a large portrait, the section title as a quiet rubric, the
// name set large, the role, a few lines in the owner's words, confirmed facts and booking with this person
// (catalog D1 Team single-host). Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamSingleHostProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function TeamSingleHost({ title, intro, people, action, note }: TeamSingleHostProps) {
  const [host] = people;
  if (!host) return null;
  const cta = host.link ?? action;
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page items-center gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
        <img
          src={host.photo.src}
          alt={host.photo.alt}
          loading="lazy"
          className="aspect-4/5 w-full rounded-lg bg-muted object-cover lg:col-span-5"
        />
        <div className="min-w-0 lg:col-span-6 lg:col-start-7">
          <h2 className="text-body font-bold text-muted-foreground">{title}</h2>
          <h3 className="mt-3 font-display text-hero font-bold text-balance wrap-break-word hyphens-auto">
            {host.name}
          </h3>
          <p className="mt-3 text-lead text-muted-foreground">{host.role}</p>
          {intro ? <p className="mt-8 text-lead text-pretty">{intro}</p> : null}
          {host.bio ? <p className="mt-4 text-body text-pretty">{host.bio}</p> : null}
          {host.facts?.length ? (
            <ul className="mt-8 divide-y divide-border border-y border-border">
              {host.facts.map((f) => (
                <li key={f} className="py-3 text-body">
                  {f}
                </li>
              ))}
            </ul>
          ) : null}
          {cta ? (
            <a href={cta.href} className={`mt-8 ${primaryClass}`}>
              {cta.label}
            </a>
          ) : null}
          {note ? <p className="mt-4 text-small text-muted-foreground">{note}</p> : null}
        </div>
      </div>
    </section>
  );
}
