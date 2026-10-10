// About «letter»: a tall photo of the place with its caption on the left, on the right the story told like a letter —
// title, a lead in the text colour, quieter paragraphs and the signature of a real person from the brief under a
// rule. On phones the text comes first. Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type AboutSplitLetterProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  image: Image;
  caption?: string;
  signature?: { name: string; role?: string };
  action?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function AboutSplitLetter({
  title,
  lead,
  paragraphs,
  image,
  caption,
  signature,
  action,
}: AboutSplitLetterProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
        <figure className="order-2 min-w-0 lg:order-1 lg:col-span-5">
          <img
            src={image.src}
            srcSet={srcSetOf(image.src)}
            sizes="(min-width: 1024px) 50vw, 100vw"
            alt={image.alt}
            loading="lazy"
            className="aspect-4/5 w-full rounded-lg bg-muted object-cover"
          />
          {caption ? (
            <figcaption className="mt-3 text-small text-muted-foreground">{caption}</figcaption>
          ) : null}
        </figure>
        <div className="order-1 min-w-0 lg:order-2 lg:col-span-6 lg:col-start-7 lg:pt-10">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {lead ? <p className="mt-6 text-lead text-pretty">{lead}</p> : null}
          <div className="mt-5 grid gap-4 text-body text-pretty text-muted-foreground">
            {paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
          {signature ? (
            <p className="mt-10 flex flex-col border-t border-border pt-5">
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
        </div>
      </div>
    </section>
  );
}
