// Call to action «centered»: a quiet tinted field with the message, the actions and a practical note on one axis.
// Composition after HyperUI «CTA» (MIT, © Mark Mead), rewritten on the design system tokens.
type Link = { label: string; href: string };

export type CtaCenteredProps = {
  title: string;
  text?: string;
  action: Link;
  secondary?: Link;
  note?: string;
};

export default function CtaCentered({ title, text, action, secondary, note }: CtaCenteredProps) {
  return (
    <section className="bg-muted font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-page flex-col items-center px-gutter py-section text-center">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {text ? <p className="mt-5 max-w-text text-lead text-pretty text-muted-foreground">{text}</p> : null}
        <div className="mt-8 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row">
          <a
            href={action.href}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {action.label}
          </a>
          {secondary ? (
            <a
              href={secondary.href}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-foreground px-6 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {secondary.label}
            </a>
          ) : null}
        </div>
        {note ? <p className="mt-5 text-small text-muted-foreground">{note}</p> : null}
      </div>
    </section>
  );
}
