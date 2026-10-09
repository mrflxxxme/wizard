// FAQ «two columns»: the title and intro above, the questions split into two independent columns of native
// disclosures (details and summary) so a long list stays short (catalog L17); one column in order on phones; the
// direct channel closes the section. Own composition.
type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqTwoColumnProps = {
  title: string;
  intro?: string;
  items: QA[];
  contactText?: string;
  contact?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** One column of disclosures; the second keeps its top rule only side by side, on phones it continues the first. */
function Column({ items, rule }: { items: QA[]; rule: string }) {
  return (
    <div className={`min-w-0 border-foreground ${rule}`}>
      {items.map((it) => (
        <details key={it.q} className="group border-b border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-5 py-5 text-body font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 text-pretty">{it.q}</span>
            <span aria-hidden="true" className="relative mt-1.5 size-3.5 shrink-0">
              <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-current" />
              <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-current transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" />
            </span>
          </summary>
          <p className="pb-5 text-body text-pretty text-muted-foreground">{it.a}</p>
        </details>
      ))}
    </div>
  );
}

export default function FaqTwoColumn({ title, intro, items, contactText, contact }: FaqTwoColumnProps) {
  const half = Math.ceil(items.length / 2);
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <div className="mt-12 grid items-start md:grid-cols-2 md:gap-x-10 lg:gap-x-16">
          <Column items={items.slice(0, half)} rule="border-t" />
          <Column items={items.slice(half)} rule="md:border-t" />
        </div>
        {contactText || contact ? (
          <div className="mt-10 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-6">
            {contactText ? <p className="text-body text-muted-foreground">{contactText}</p> : null}
            {contact ? (
              <a href={contact.href} className={linkClass}>
                <span>{contact.label}</span>
                <span aria-hidden="true">→</span>
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
