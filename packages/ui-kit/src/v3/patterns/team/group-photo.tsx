// Team «group photo»: portraits side by side as one strip with hairline gaps, like a group shot in a magazine, and a
// caption that names everyone in order — «на фото слева направо» — then short bios in columns under a rule.
// Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };
type Person = { name: string; role: string; photo: Image; bio?: string; facts?: string[]; link?: Link };

export type TeamGroupPhotoProps = {
  title: string;
  intro?: string;
  people: Person[];
  action?: Link;
  note?: string;
};

const STRIP: Record<number, string> = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4",
  5: "md:grid-cols-5",
};
const BIOS: Record<number, string> = { 2: "lg:grid-cols-2", 4: "lg:grid-cols-4" };
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function TeamGroupPhoto({ title, intro, people, action, note }: TeamGroupPhotoProps) {
  const withBio = people.filter((p) => p.bio);
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <figure className="mt-12">
          <div className={`grid grid-cols-2 gap-1 ${STRIP[people.length] ?? "md:grid-cols-3"}`}>
            {people.map((p) => (
              <img
                key={p.name}
                src={p.photo.src}
                srcSet={srcSetOf(p.photo.src)}
                sizes="(min-width: 1024px) 25vw, 50vw"
                alt={p.photo.alt}
                loading="lazy"
                className="aspect-3/4 w-full bg-muted object-cover"
              />
            ))}
          </div>
          <figcaption className="mt-4 max-w-4xl text-small text-pretty text-muted-foreground">
            <span>На фото слева направо: </span>
            {people.map((p, i) => (
              <span key={p.name}>
                <span className="font-bold text-foreground">{p.name}</span>
                {`, ${p.role}`}
                {i < people.length - 1 ? "; " : "."}
              </span>
            ))}
          </figcaption>
        </figure>
        {withBio.length ? (
          <div
            className={`mt-12 grid gap-x-10 gap-y-8 border-t border-border pt-8 md:grid-cols-2 ${BIOS[withBio.length] ?? "lg:grid-cols-3"}`}
          >
            {withBio.map((p) => (
              <div key={p.name} className="min-w-0">
                <h3 className="font-display text-h3 font-bold text-balance wrap-break-word">{p.name}</h3>
                <p className="mt-2 text-body text-pretty text-muted-foreground">{p.bio}</p>
                {p.link ? (
                  <a href={p.link.href} className={`mt-1 ${linkClass}`}>
                    {p.link.label}
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
        {note || action ? (
          <div className="mt-10 flex flex-col items-start gap-3">
            {note ? <p className="text-small text-muted-foreground">{note}</p> : null}
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
