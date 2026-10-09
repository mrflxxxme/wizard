// FAQ «open grid»: every answer visible at once for a short list — questions as small headings with a rule above,
// short answers under them, in two columns on desktop; nothing to click, easy to scan. Own composition.
type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqOpenGridProps = {
  title: string;
  intro?: string;
  items: QA[];
  contactText?: string;
  contact?: Link;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function FaqOpenGrid({ title, intro, items, contactText, contact }: FaqOpenGridProps) {
  return (
    <section className="bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <div className="mt-12 grid gap-x-16 gap-y-10 md:grid-cols-2 lg:gap-y-12">
          {items.map((it) => (
            <div key={it.q} className="min-w-0 border-t border-foreground pt-5">
              <h3 className="font-display text-h3 font-bold text-pretty wrap-break-word">{it.q}</h3>
              <p className="mt-3 max-w-text text-body text-pretty text-muted-foreground">{it.a}</p>
            </div>
          ))}
        </div>
        {contactText || contact ? (
          <div className="mt-14 flex flex-col items-start gap-4 rounded-lg bg-background p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
            {contactText ? <p className="text-lead text-pretty">{contactText}</p> : null}
            {contact ? (
              <a href={contact.href} className={`shrink-0 ${primaryClass}`}>
                {contact.label}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
