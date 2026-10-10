// About «centered»: a short manifesto on one axis — the title, the lead in the text colour, a few quiet paragraphs at
// a reading measure and the signature of a real person under a short rule; a wide photo of the place closes the
// section when there is one. Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type AboutCenteredProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  signature?: { name: string; role?: string };
  image?: Image;
  action?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function AboutCentered({
  title,
  lead,
  paragraphs,
  signature,
  image,
  action,
}: AboutCenteredProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-page flex-col items-center px-gutter py-section text-center">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-6 max-w-2xl text-lead text-pretty">{lead}</p> : null}
        <div className="mt-6 grid max-w-text gap-4 text-body text-pretty text-muted-foreground">
          {paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        {signature ? (
          <p className="mt-10 flex flex-col items-center">
            <span aria-hidden="true" className="mb-5 h-0.5 w-12 bg-primary" />
            <span className="font-display text-h3 font-bold">{signature.name}</span>
            {signature.role ? (
              <span className="text-small text-muted-foreground">{signature.role}</span>
            ) : null}
          </p>
        ) : null}
        {action ? (
          <a href={action.href} className={`mt-6 ${linkClass}`}>
            <span>{action.label}</span>
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
        {image ? (
          <img
            src={image.src}
            srcSet={srcSetOf(image.src)}
            sizes="(min-width: 1024px) 50vw, 100vw"
            alt={image.alt}
            loading="lazy"
            className="mt-14 aspect-4/3 w-full rounded-lg bg-muted object-cover sm:aspect-21/9"
          />
        ) : null}
      </div>
    </section>
  );
}
