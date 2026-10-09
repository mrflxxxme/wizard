// FAQ «grouped»: the questions by topic — each topic opens with a heavy rule, its name on the left and its questions
// as native disclosures on the right; on phones the name heads its list. Own composition.
type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqGroupedProps = {
  title: string;
  intro?: string;
  groups: { title: string; items: QA[] }[];
  contactText?: string;
  contact?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function FaqGrouped({ title, intro, groups, contactText, contact }: FaqGroupedProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="max-w-3xl">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? (
            <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
          ) : null}
        </div>
        <div className="mt-12 grid gap-12 lg:gap-16">
          {groups.map((g) => (
            <div
              key={g.title}
              className="grid gap-4 border-t-2 border-foreground pt-5 lg:grid-cols-12 lg:gap-x-12"
            >
              <h3 className="font-display text-h3 font-bold text-balance wrap-break-word lg:col-span-4">
                {g.title}
              </h3>
              <div className="min-w-0 lg:col-span-8">
                {g.items.map((it) => (
                  <details key={it.q} className="group border-b border-border lg:first:-mt-4">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-6 py-4 text-body font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0 text-pretty">{it.q}</span>
                      <span
                        aria-hidden="true"
                        className="inline-flex size-6 shrink-0 items-center justify-center transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
                      >
                        <span className="size-2.5 -translate-y-0.5 rotate-45 border-r-2 border-b-2 border-current" />
                      </span>
                    </summary>
                    <p className="max-w-text pb-5 text-body text-pretty text-muted-foreground">{it.a}</p>
                  </details>
                ))}
              </div>
            </div>
          ))}
        </div>
        {contactText || contact ? (
          <div className="mt-12 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-6">
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
