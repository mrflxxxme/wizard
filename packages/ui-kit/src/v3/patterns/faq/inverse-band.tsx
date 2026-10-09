// FAQ «inverse band»: a contrasting full-width band — the title, intro and a direct channel on the left, the questions
// as native disclosures between faint rules on the right; one conscious contrasting band per page (catalog C10).
// Own composition.
type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqInverseBandProps = {
  title: string;
  intro?: string;
  items: QA[];
  contactText?: string;
  contact?: Link;
};

export default function FaqInverseBand({ title, intro, items, contactText, contact }: FaqInverseBandProps) {
  return (
    <section className="bg-inverse font-sans text-inverse-foreground">
      <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
        <div className="min-w-0 lg:col-span-4">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? <p className="mt-4 text-body text-pretty text-inverse-foreground/80">{intro}</p> : null}
          {contactText || contact ? (
            <div className="mt-8 hidden lg:block">
              {contactText ? (
                <p className="text-body text-pretty text-inverse-foreground/80">{contactText}</p>
              ) : null}
              {contact ? (
                <a
                  href={contact.href}
                  className="mt-4 inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-inverse-foreground px-6 text-center text-body font-bold text-inverse transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground"
                >
                  {contact.label}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="min-w-0 border-t border-inverse-foreground/25 lg:col-span-7 lg:col-start-6">
          {items.map((it) => (
            <details key={it.q} className="group border-b border-inverse-foreground/25">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-6 py-5 text-lead font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 text-pretty">{it.q}</span>
                <span aria-hidden="true" className="relative size-4 shrink-0">
                  <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-current" />
                  <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-current transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" />
                </span>
              </summary>
              <p className="max-w-text pb-6 text-body text-pretty text-inverse-foreground/80">{it.a}</p>
            </details>
          ))}
        </div>
        {contactText || contact ? (
          <div className="lg:hidden">
            {contactText ? (
              <p className="text-body text-pretty text-inverse-foreground/80">{contactText}</p>
            ) : null}
            {contact ? (
              <a
                href={contact.href}
                className="mt-4 inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-inverse-foreground px-6 text-center text-body font-bold text-inverse transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-inverse-foreground"
              >
                {contact.label}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
