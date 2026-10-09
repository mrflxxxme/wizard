// About «quote»: the owner's own words set large in the display face, signed with their real name, role and photo
// from the brief; under a rule the title, lead and story run in two columns. Own composition.
type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type AboutQuoteProps = {
  title: string;
  lead?: string;
  paragraphs: string[];
  quote: { text: string; author: string; role?: string; photo?: Image };
  action?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function AboutQuote({ title, lead, paragraphs, quote, action }: AboutQuoteProps) {
  // A short quote is set at poster size; a longer one steps down to stay readable.
  const size = quote.text.length <= 120 ? "text-h1 lg:text-hero" : "text-h2 lg:text-h1";
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="font-display text-h3 font-bold text-balance wrap-break-word">{title}</h2>
        <figure className="mt-10 lg:mt-14">
          <blockquote className="max-w-5xl">
            <p className={`font-display font-bold text-balance wrap-break-word hyphens-auto ${size}`}>
              «{quote.text}»
            </p>
          </blockquote>
          <figcaption className="mt-8 flex items-center gap-4">
            {quote.photo ? (
              <img
                src={quote.photo.src}
                alt={quote.photo.alt}
                loading="lazy"
                className="size-16 shrink-0 rounded-full bg-muted object-cover"
              />
            ) : (
              <span aria-hidden="true" className="h-0.5 w-10 shrink-0 bg-primary" />
            )}
            <span className="flex min-w-0 flex-col">
              <span className="text-body font-bold">{quote.author}</span>
              {quote.role ? <span className="text-small text-muted-foreground">{quote.role}</span> : null}
            </span>
          </figcaption>
        </figure>
        <div className="mt-14 grid gap-6 border-t border-border pt-8 md:grid-cols-2 md:gap-12">
          <div className="min-w-0">
            {lead ? <p className="text-lead text-pretty">{lead}</p> : null}
            {action ? (
              <a href={action.href} className={`mt-5 ${linkClass}`}>
                <span>{action.label}</span>
                <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </div>
          <div className="grid min-w-0 gap-4 text-body text-pretty text-muted-foreground">
            {paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
