// FAQ «accordion»: the title and intro on one axis, the questions in a narrow column between hairlines as native
// disclosures (details and summary: keyboard and screen readers for free), one answer open at a time, the first one
// open; under the list a way to ask what is not answered. Own composition.
import { useId } from "react";

type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqAccordionProps = {
  title: string;
  intro?: string;
  items: QA[];
  contactText?: string;
  contact?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export default function FaqAccordion({ title, intro, items, contactText, contact }: FaqAccordionProps) {
  const group = useId();
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
          {intro ? <p className="mt-4 text-lead text-pretty text-muted-foreground">{intro}</p> : null}
        </div>
        <div className="mx-auto mt-12 max-w-3xl border-t border-border">
          {items.map((it, i) => (
            <details key={it.q} name={group} open={i === 0} className="group border-b border-border">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-6 py-5 text-lead font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <span className="min-w-0 text-pretty">{it.q}</span>
                <span aria-hidden="true" className="relative size-4 shrink-0">
                  <span className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 bg-current" />
                  <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-current transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" />
                </span>
              </summary>
              <p className="max-w-text pb-6 text-body text-pretty text-muted-foreground">{it.a}</p>
            </details>
          ))}
        </div>
        {contactText || contact ? (
          <div className="mx-auto mt-10 flex max-w-2xl flex-col items-center gap-2 text-center">
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
