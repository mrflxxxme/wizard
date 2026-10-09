// FAQ «cards»: each question a card of its own in two columns, a button in a heading that opens its answer
// (aria-expanded, aria-controls, WAI-ARIA accordion), the first one open; an answer opened by the visitor appears
// with a short fade — only opacity with reduced motion, nothing with the still profile (catalog E3). Own composition.
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useId, useState } from "react";

type Link = { label: string; href: string };
type QA = { q: string; a: string };

export type FaqCardsProps = {
  title: string;
  intro?: string;
  items: QA[];
  contactText?: string;
  contact?: Link;
};

const linkClass =
  "inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline decoration-primary decoration-2 underline-offset-4 transition-colors duration-200 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Motion of an answer opened by the visitor: a 200 ms fade and slide, opacity only when motion is reduced. */
function useAnswerMotion() {
  const reduce = useReducedMotion();
  const [still] = useState(
    () =>
      typeof document !== "undefined" &&
      getComputedStyle(document.documentElement).getPropertyValue("--ds-motion").trim() === "still",
  );
  return (opened: boolean) =>
    opened && !still
      ? {
          initial: reduce ? { opacity: 0 } : { opacity: 0, y: -6 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: reduce ? 0.15 : 0.2, ease: [0.23, 1, 0.32, 1] as const },
        }
      : {};
}

function Item({ q, a, first }: QA & { first: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(first);
  const [opened, setOpened] = useState(false);
  const enter = useAnswerMotion();
  return (
    <li className="min-w-0 rounded-lg border border-border bg-card text-card-foreground">
      <h3>
        <button
          type="button"
          id={`${id}-q`}
          aria-expanded={open}
          aria-controls={`${id}-a`}
          onClick={() => {
            setOpened(true);
            setOpen((v) => !v);
          }}
          className="flex min-h-11 w-full items-start justify-between gap-5 rounded-lg p-5 text-left text-body font-bold text-card-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:p-6"
        >
          <span className="min-w-0 text-pretty">{q}</span>
          <span
            aria-hidden="true"
            className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-foreground transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-45" : ""}`}
          >
            +
          </span>
        </button>
      </h3>
      <div id={`${id}-a`} hidden={!open}>
        {open ? (
          <m.p {...enter(opened)} className="px-5 pb-6 text-body text-pretty text-muted-foreground sm:px-6">
            {a}
          </m.p>
        ) : null}
      </div>
    </li>
  );
}

export default function FaqCards({ title, intro, items, contactText, contact }: FaqCardsProps) {
  return (
    <LazyMotion features={domAnimation}>
      <section className="bg-background font-sans text-foreground">
        <div className="mx-auto w-full max-w-page px-gutter py-section">
          <div className="max-w-3xl">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {intro ? (
              <p className="mt-4 max-w-text text-lead text-pretty text-muted-foreground">{intro}</p>
            ) : null}
          </div>
          <ul className="mt-12 grid items-start gap-3 md:grid-cols-2 lg:gap-4">
            {items.map((it, i) => (
              <Item key={it.q} q={it.q} a={it.a} first={i === 0} />
            ))}
          </ul>
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
    </LazyMotion>
  );
}
