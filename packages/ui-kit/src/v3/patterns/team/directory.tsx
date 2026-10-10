// Team «directory»: the people as rows of a directory under a heavy rule — a small round photo when there is one, the
// name large in the display face, the role and confirmed facts, booking with the person at the right edge. Works
// without photos. Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo?: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamDirectoryProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function TeamDirectory({ title, intro, people, action, note }: TeamDirectoryProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <ul className="mt-12 border-t-2 border-foreground">
          {people.map((p) => (
            <li
              key={p.name}
              className="grid gap-x-8 gap-y-3 border-b border-border py-6 md:grid-cols-12 md:items-center"
            >
              <div className="flex min-w-0 items-center gap-4 md:col-span-5">
                {p.photo ? (
                  <img
                    src={p.photo.src}
                    srcSet={srcSetOf(p.photo.src)}
                    sizes="(min-width: 1024px) 25vw, 50vw"
                    alt={p.photo.alt}
                    loading="lazy"
                    className="size-14 shrink-0 rounded-full bg-muted object-cover sm:size-16"
                  />
                ) : null}
                <h3 className="min-w-0 font-display text-h2 font-bold text-balance wrap-break-word">
                  {p.name}
                </h3>
              </div>
              <div className="min-w-0 md:col-span-4">
                <p className="text-body">{p.role}</p>
                {p.facts?.length ? (
                  <p className="mt-1 text-small text-muted-foreground">{p.facts.join(" · ")}</p>
                ) : null}
              </div>
              <div className="min-w-0 md:col-span-3 md:justify-self-end">
                {p.link ? (
                  <a href={p.link.href} className={`md:text-right ${linkClass}`}>
                    {p.link.label}
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {note || action ? (
          <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            {note ? <p className="text-small text-muted-foreground">{note}</p> : <span aria-hidden="true" />}
            {action ? (
              <a href={action.href} className={linkClass}>
                <span>{action.label}</span>
                <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
