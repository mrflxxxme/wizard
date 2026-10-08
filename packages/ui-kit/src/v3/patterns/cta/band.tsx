// Call to action «band»: a full-width band of the brand colour, the message on the left and the actions on the right
// (stacked on phones) — one intent (catalog D1 CTA band). Composition after HyperUI «CTA» (MIT, © Mark Mead),
// rewritten on the design system tokens.
type Link = { label: string; href: string };

export type CtaBandProps = {
  title: string;
  text?: string;
  action: Link;
  secondary?: Link;
};

export default function CtaBand({ title, text, action, secondary }: CtaBandProps) {
  return (
    <section className="bg-primary font-sans text-primary-foreground">
      <div className="mx-auto flex w-full max-w-page flex-col gap-8 px-gutter py-14 md:flex-row md:items-center md:justify-between md:gap-12">
        <div className="max-w-2xl min-w-0">
          <h2 className="font-display text-h2 font-bold text-balance wrap-break-word">{title}</h2>
          {text ? <p className="mt-3 text-body">{text}</p> : null}
        </div>
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row">
          <a
            href={action.href}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-background px-6 text-center text-body font-bold text-foreground transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground"
          >
            {action.label}
          </a>
          {secondary ? (
            <a
              href={secondary.href}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-primary-foreground px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-foreground"
            >
              {secondary.label}
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}
