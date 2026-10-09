// Team «credits»: the team as the credits of a film, without photos — on one central axis the role set small to the
// right edge of the left half and the name large in the display face to the left of the right half; on phones the
// role sits above the name. For businesses without portraits of their people. Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo?: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamCreditsProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function TeamCredits({ title, intro, people, action, note }: TeamCreditsProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? <p className="mt-4 text-body text-pretty text-muted-foreground">{intro}</p> : null}
        </div>
        <dl className="mx-auto mt-12 grid max-w-4xl gap-y-6 border-y border-border py-10 sm:gap-y-5">
          {people.map((p) => (
            <div
              key={p.name}
              className="grid min-w-0 gap-1 text-center sm:grid-cols-2 sm:items-baseline sm:gap-8"
            >
              <dt className="text-small text-pretty text-muted-foreground sm:text-right">{p.role}</dt>
              <dd className="font-display text-h2 font-bold text-balance wrap-break-word sm:text-left">
                {p.name}
              </dd>
            </div>
          ))}
        </dl>
        {note || action ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
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
