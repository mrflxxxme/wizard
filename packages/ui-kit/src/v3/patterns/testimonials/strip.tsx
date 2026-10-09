// Testimonials «strip»: a tinted band with a row of review cards that scrolls sideways with snap points — by finger,
// by the arrow keys once the row has focus, or by the named buttons next to the title; nothing scrolls by itself
// (catalog M06) and the buttons jump without smooth scrolling under reduced motion. Own composition.
import { useEffect, useRef, useState } from "react";

type Link = { label: string; href: string };
type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};

export type TestimonialsStripProps = {
  title: string;
  lead?: string;
  reviews: Review[];
  more?: Link;
};

const arrowClass =
  "inline-flex size-11 items-center justify-center rounded-control border border-border bg-card text-lead text-card-foreground transition-colors duration-200 hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:border-transparent disabled:bg-transparent disabled:text-muted-foreground";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const score = (v: number) => String(v).replace(".", ",");

export default function TestimonialsStrip({ title, lead, reviews, more }: TestimonialsStripProps) {
  const row = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const track = () => {
    const el = row.current;
    if (!el) return;
    const start = el.scrollLeft <= 4;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setEdge((e) => (e.start === start && e.end === end ? e : { start, end }));
  };
  // The buttons follow the row: both off when every card fits, as the viewport changes.
  useEffect(() => {
    track();
    window.addEventListener("resize", track);
    return () => window.removeEventListener("resize", track);
  });
  const turn = (dir: number) => {
    const el = row.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduce ? "auto" : "smooth" });
  };
  return (
    <section className="bg-muted font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 max-w-3xl">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {lead ? <p className="mt-4 max-w-text text-body text-muted-foreground">{lead}</p> : null}
          </div>
          <div className="flex shrink-0 gap-3">
            <button
              type="button"
              aria-label="Листать отзывы назад"
              disabled={edge.start}
              onClick={() => turn(-1)}
              className={arrowClass}
            >
              <span aria-hidden="true">←</span>
            </button>
            <button
              type="button"
              aria-label="Листать отзывы вперёд"
              disabled={edge.end}
              onClick={() => turn(1)}
              className={arrowClass}
            >
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
        <ul
          ref={row}
          onScroll={track}
          aria-label={title}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling row must be reachable by keyboard (WCAG 2.1.1)
          tabIndex={0}
          className="-mx-gutter mt-10 flex snap-x snap-mandatory scroll-px-gutter gap-4 overflow-x-auto px-gutter pb-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:mt-12"
        >
          {reviews.map((r) => (
            <li
              key={`${r.author}|${r.text.slice(0, 40)}`}
              className="flex w-[85%] shrink-0 snap-start sm:w-[23rem] lg:w-[25rem]"
            >
              <figure className="flex w-full flex-col justify-between gap-8 rounded-lg bg-card p-6 text-card-foreground sm:p-8">
                <blockquote>
                  <p className="text-body text-pretty wrap-break-word">{r.text}</p>
                </blockquote>
                <figcaption className="flex flex-col gap-1">
                  <span className="font-bold wrap-break-word">{r.author}</span>
                  {r.detail ? <span className="text-small text-muted-foreground">{r.detail}</span> : null}
                  <span className="flex flex-wrap items-center gap-x-3 text-small text-muted-foreground">
                    {r.source?.href ? (
                      <a href={r.source.href} className={linkClass}>
                        {r.source.label}
                      </a>
                    ) : r.source ? (
                      <span className="font-bold">{r.source.label}</span>
                    ) : null}
                    {r.date ? <span>{r.date}</span> : null}
                    {r.rating ? (
                      <span>
                        Оценка {score(r.rating.value)} из {r.rating.max}
                      </span>
                    ) : null}
                  </span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
        {more ? (
          <a href={more.href} className={`mt-6 gap-2 text-body ${linkClass}`}>
            {more.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
