// Call to action «typographic»: a short question above, then the action itself set at poster size as one link with
// an arrow between rules; the secondary path as a plain link. Own composition.
type Link = { label: string; href: string };

export type CtaTypographicProps = {
  title: string;
  text?: string;
  action: Link;
  secondary?: Link;
};

export default function CtaTypographic({ title, text, action, secondary }: CtaTypographicProps) {
  return (
    <section className="border-y border-border bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <h2 className="font-display text-h3 font-bold text-balance wrap-break-word">{title}</h2>
        {text ? <p className="mt-3 max-w-text text-body text-muted-foreground">{text}</p> : null}
        <a
          href={action.href}
          className="group mt-8 inline-flex min-h-11 max-w-full items-baseline gap-4 font-display text-hero font-bold text-foreground underline decoration-primary decoration-4 underline-offset-8 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <span className="min-w-0 text-balance wrap-break-word hyphens-auto">{action.label}</span>
          <span
            aria-hidden="true"
            className="shrink-0 transition-transform duration-200 group-hover:translate-x-2"
          >
            →
          </span>
        </a>
        {secondary ? (
          <div className="mt-8">
            <a
              href={secondary.href}
              className="inline-flex min-h-11 min-w-11 items-center text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {secondary.label}
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
