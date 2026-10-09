// About «editorial»: a magazine spread — the title large across the top, then under a heavy rule a wide photo with its
// caption and, beside it, the lead as a standfirst in the display face and the story opening with a drop cap.
// Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type AboutEditorialProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  image: Image;
  caption?: string;
  action?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function AboutEditorial({
  title,
  lead,
  paragraphs,
  image,
  caption,
  action,
}: AboutEditorialProps) {
  const [first, ...rest] = paragraphs;
  // A short title is set at poster size; a long one steps down so it keeps to three lines.
  const size = title.length <= 48 ? "text-hero" : "text-h1";
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className={`max-w-4xl font-display font-bold text-balance wrap-break-word hyphens-auto ${size}`}>
          {title}
        </h2>
        <div className="mt-10 grid gap-10 border-t-2 border-foreground pt-8 lg:grid-cols-12 lg:gap-x-12">
          <figure className="min-w-0 lg:col-span-7">
            <img
              src={image.src}
              alt={image.alt}
              loading="lazy"
              className="aspect-3/2 w-full bg-muted object-cover"
            />
            {caption ? (
              <figcaption className="mt-3 border-l-2 border-primary pl-3 text-small text-muted-foreground">
                {caption}
              </figcaption>
            ) : null}
          </figure>
          <div className="min-w-0 lg:col-span-5">
            {lead ? <p className="font-display text-h3 font-bold text-pretty">{lead}</p> : null}
            <div className={`grid gap-4 text-body text-pretty ${lead ? "mt-6" : ""}`}>
              {first ? (
                <p className="first-letter:float-left first-letter:mt-1 first-letter:mr-3 first-letter:font-display first-letter:text-hero first-letter:leading-[0.8] first-letter:font-bold">
                  {first}
                </p>
              ) : null}
              {rest.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
            {action ? (
              <a href={action.href} className={`mt-6 ${linkClass}`}>
                <span>{action.label}</span>
                <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
