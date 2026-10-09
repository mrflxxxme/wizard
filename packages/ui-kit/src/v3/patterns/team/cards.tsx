// Team «cards»: horizontal cards in two columns — the portrait filling the left part, the name, role, a few lines
// about the person, confirmed facts as quiet tags and booking with them on the right; on phones the portrait sits on
// top. Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo?: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamCardsProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-card-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-card-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Initials of a name for a person without a photo. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => w.charAt(0))
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default function TeamCards({ title, intro, people, action, note }: TeamCardsProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <ul className="mt-12 grid gap-4 lg:grid-cols-2 lg:gap-6">
          {people.map((p) => (
            <li
              key={p.name}
              className="grid min-w-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground sm:grid-cols-5"
            >
              {p.photo ? (
                <img
                  src={p.photo.src}
                  alt={p.photo.alt}
                  loading="lazy"
                  className="aspect-4/3 h-full w-full bg-muted object-cover sm:col-span-2 sm:aspect-auto sm:min-h-64"
                />
              ) : (
                <div
                  aria-hidden="true"
                  className="flex aspect-4/3 items-center justify-center bg-muted font-display text-hero font-bold text-muted-foreground sm:col-span-2 sm:aspect-auto sm:min-h-64"
                >
                  {initials(p.name)}
                </div>
              )}
              <div className="flex min-w-0 flex-col p-6 sm:col-span-3 sm:p-8">
                <h3 className="font-display text-h2 font-bold text-balance wrap-break-word">{p.name}</h3>
                <p className="mt-1 text-body text-muted-foreground">{p.role}</p>
                {p.bio ? <p className="mt-4 text-body text-pretty">{p.bio}</p> : null}
                {p.facts?.length ? (
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {p.facts.map((f) => (
                      <li key={f} className="rounded-sm bg-muted px-2.5 py-1 text-small text-foreground">
                        {f}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {p.link ? (
                  <a href={p.link.href} className={`mt-auto self-start pt-4 ${linkClass}`}>
                    {p.link.label}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
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
