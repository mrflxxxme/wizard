// FAQ «tabs»: the topics as a segmented switch of tabs (WAI-ARIA tabs: arrows, Home and End move between them, only
// the chosen tab is in the Tab order) and under it the questions of the chosen topic as native disclosures.
// Own composition.
import { type KeyboardEvent, useId, useRef, useState } from "react";

type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqTabsProps = {
  title: string;
  intro?: string;
  groups: { title: string; items: QA[] }[];
  contactText?: string;
  contact?: Link;
};

const tabClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control px-5 text-center text-body font-bold text-muted-foreground transition-colors duration-200 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-sm";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Index of the tab a key moves to, or -1 for keys the tab list does not handle. */
function moveTo(key: string, i: number, n: number): number {
  if (key === "ArrowRight" || key === "ArrowDown") return (i + 1) % n;
  if (key === "ArrowLeft" || key === "ArrowUp") return (i - 1 + n) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return -1;
}

export default function FaqTabs({ title, intro, groups, contactText, contact }: FaqTabsProps) {
  const [active, setActive] = useState(0);
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = moveTo(e.key, i, groups.length);
    if (next < 0) return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  };
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-4xl px-gutter py-section">
        <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {intro ? (
          <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
        ) : null}
        <div
          role="tablist"
          aria-label={title}
          className="mt-10 inline-flex max-w-full flex-wrap gap-1 rounded-control bg-muted p-1"
        >
          {groups.map((g, i) => (
            <button
              key={g.title}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={i === active}
              aria-controls={`${id}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              onClick={() => setActive(i)}
              onKeyDown={(e) => onKey(e, i)}
              className={tabClass}
            >
              {g.title}
            </button>
          ))}
        </div>
        {groups.map((g, i) => (
          <div
            key={g.title}
            role="tabpanel"
            id={`${id}-panel-${i}`}
            aria-labelledby={`${id}-tab-${i}`}
            hidden={i !== active}
            className="mt-8 border-t border-border"
          >
            {g.items.map((it) => (
              <details key={it.q} className="group border-b border-border">
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-6 py-5 text-lead font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0 text-pretty">{it.q}</span>
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-h3 leading-none font-normal transition-transform duration-200 group-open:rotate-45 motion-reduce:transition-none"
                  >
                    +
                  </span>
                </summary>
                <p className="max-w-text pb-6 text-body text-pretty text-muted-foreground">{it.a}</p>
              </details>
            ))}
          </div>
        ))}
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
