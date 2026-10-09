// FAQ «sticky side»: the title, intro and a quiet card «не нашли ответ» with a direct channel stay pinned on the left
// while the questions scroll by on the right as native disclosures (details and summary); the first answer is open.
// Own composition.
type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqStickySideProps = {
  title: string;
  intro?: string;
  items: QA[];
  contactText?: string;
  contact?: Link;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function FaqStickySide({ title, intro, items, contactText, contact }: FaqStickySideProps) {
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
        <div className="min-w-0 lg:sticky lg:top-8 lg:col-span-4 lg:self-start">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? <p className="mt-4 text-body text-pretty text-muted-foreground">{intro}</p> : null}
          {contactText || contact ? (
            <div className="mt-8 hidden rounded-lg bg-muted p-6 lg:block">
              {contactText ? <p className="text-body text-pretty">{contactText}</p> : null}
              {contact ? (
                <a href={contact.href} className={`mt-4 ${primaryClass}`}>
                  {contact.label}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="min-w-0 lg:col-span-7 lg:col-start-6">
          <div className="border-t-2 border-foreground">
            {items.map((it, i) => (
              <details key={it.q} open={i === 0} className="group border-b border-border">
                <summary className="flex min-h-11 cursor-pointer list-none items-start justify-between gap-6 py-6 text-lead font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 text-pretty">{it.q}</span>
                  <span
                    aria-hidden="true"
                    className="mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full border border-border transition-colors duration-200 group-open:border-foreground group-open:bg-foreground group-open:text-background"
                  >
                    <span className="relative size-3">
                      <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-current" />
                      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-current transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" />
                    </span>
                  </span>
                </summary>
                <p className="max-w-text pr-12 pb-6 text-body text-pretty text-muted-foreground">{it.a}</p>
              </details>
            ))}
          </div>
          {contactText || contact ? (
            <div className="mt-8 rounded-lg bg-muted p-6 lg:hidden">
              {contactText ? <p className="text-body text-pretty">{contactText}</p> : null}
              {contact ? (
                <a href={contact.href} className={`mt-4 ${primaryClass}`}>
                  {contact.label}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
