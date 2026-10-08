// Call to action «card»: an inset card on the page — the message and a note on the left, the actions aligned to its
// bottom-right edge. Card styling after shadcn/ui (MIT, © 2023 shadcn), rewritten on the design system tokens.
type Link = { label: string; href: string };

export type CtaCardProps = {
  title: string;
  text?: string;
  action: Link;
  secondary?: Link;
  note?: string;
};

export default function CtaCard({ title, text, action, secondary, note }: CtaCardProps) {
  return (
    <section className="bg-background py-section font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter">
        <div className="grid gap-8 rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-10 md:grid-cols-[minmax(0,1fr)_auto] md:items-end lg:p-12">
          <div className="min-w-0">
            <h2 className="font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
            {text ? <p className="mt-4 max-w-text text-body text-muted-foreground">{text}</p> : null}
            {note ? <p className="mt-4 text-small text-muted-foreground">{note}</p> : null}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row md:flex-col lg:flex-row">
            {secondary ? (
              <a
                href={secondary.href}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control px-5 text-center text-body font-bold text-card-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {secondary.label}
              </a>
            ) : null}
            <a
              href={action.href}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {action.label}
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
