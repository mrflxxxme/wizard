// FAQ «typographic»: the questions themselves carry the section — set in the display face at heading size between
// heavy rules as native disclosures, a large plus turning into a cross; the answers open under them at lead size in a
// reading measure. Own composition.
type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqTypographicProps = {
  title: string;
  intro?: string;
  items: QA[];
  contactText?: string;
  contact?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function FaqTypographic({ title, intro, items, contactText, contact }: FaqTypographicProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="grid gap-3 lg:grid-cols-12 lg:gap-x-12">
          <h2 className="text-body font-bold lg:col-span-4">{title}</h2>
          {intro ? (
            <p className="max-w-text text-body text-pretty text-muted-foreground lg:col-span-6 lg:col-start-7">
              {intro}
            </p>
          ) : null}
        </div>
        <div className="mt-8 border-b-2 border-foreground">
          {items.map((it) => (
            <details key={it.q} className="group border-t-2 border-foreground">
              <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-6 py-6 font-display text-h2 font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:py-8 [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 text-balance wrap-break-word">{it.q}</span>
                <span
                  aria-hidden="true"
                  className="shrink-0 font-sans leading-none font-normal transition-transform duration-200 group-open:rotate-45 motion-reduce:transition-none"
                >
                  +
                </span>
              </summary>
              <div className="grid pb-8 lg:grid-cols-12 lg:gap-x-12">
                <p className="max-w-text text-lead text-pretty text-muted-foreground lg:col-span-6 lg:col-start-7">
                  {it.a}
                </p>
              </div>
            </details>
          ))}
        </div>
        {contactText || contact ? (
          <div className="mt-8 grid gap-2 lg:grid-cols-12 lg:gap-x-12">
            <div className="flex flex-col items-start gap-2 lg:col-span-6 lg:col-start-7">
              {contactText ? <p className="text-body text-muted-foreground">{contactText}</p> : null}
              {contact ? (
                <a href={contact.href} className={linkClass}>
                  <span>{contact.label}</span>
                  <span aria-hidden="true">→</span>
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
