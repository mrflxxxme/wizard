// Testimonials «carousel»: one review at a time on the centre axis, turned by named «previous» and «next» buttons
// or the arrow keys; it never turns by itself (catalog M06). All slides share one grid cell, so the section keeps the
// height of the longest review and the buttons do not jump; the change is announced politely. Own composition.
import { useState } from "react";

type Link = { label: string; href: string };
type Review = {
  text: string;
  author: string;
  detail?: string;
  source?: { label: string; href?: string };
  date?: string;
  rating?: { value: number; max: number };
};

export type TestimonialsCarouselProps = {
  title: string;
  lead?: string;
  reviews: Review[];
  more?: Link;
};

const arrowClass =
  "inline-flex size-11 items-center justify-center rounded-control border border-border text-lead text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const linkClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

const score = (v: number) => String(v).replace(".", ",");

export default function TestimonialsCarousel({ title, lead, reviews, more }: TestimonialsCarouselProps) {
  const [current, setCurrent] = useState(0);
  const n = reviews.length;
  const go = (step: number) => setCurrent((c) => (c + step + n) % n);
  return (
    <section className="bg-background font-sans text-foreground">
      <div className="mx-auto flex w-full max-w-page flex-col items-center px-gutter py-section text-center">
        <h2 className="max-w-3xl font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
        {lead ? <p className="mt-4 max-w-text text-lead text-muted-foreground">{lead}</p> : null}
        <section
          aria-label={title}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") go(-1);
            if (e.key === "ArrowRight") go(1);
          }}
          className="mt-12 w-full max-w-4xl border-y border-border py-10 sm:py-14"
        >
          <div aria-live="polite" className="grid">
            {reviews.map((r, k) => {
              const on = k === current;
              return (
                <figure
                  key={`${r.author}|${r.text.slice(0, 40)}`}
                  aria-hidden={!on}
                  aria-label={`Отзыв ${k + 1} из ${n}`}
                  className={`col-start-1 row-start-1 flex flex-col items-center ${on ? "visible" : "invisible"}`}
                >
                  <blockquote>
                    <p
                      className={`font-display text-balance wrap-break-word ${r.text.length > 200 ? "text-h3" : "text-h2"}`}
                    >
                      «{r.text}»
                    </p>
                  </blockquote>
                  <figcaption className="mt-8 flex flex-col items-center gap-1">
                    <span className="text-lead font-bold wrap-break-word">{r.author}</span>
                    {r.detail ? <span className="text-small text-muted-foreground">{r.detail}</span> : null}
                    <span className="flex flex-wrap items-center justify-center gap-x-4 text-small text-muted-foreground">
                      {r.source?.href ? (
                        <a href={r.source.href} tabIndex={on ? undefined : -1} className={linkClass}>
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
              );
            })}
          </div>
          <div className="mt-10 flex items-center justify-center gap-6">
            <button type="button" aria-label="Предыдущий отзыв" onClick={() => go(-1)} className={arrowClass}>
              <span aria-hidden="true">←</span>
            </button>
            <p className="min-w-16 text-body text-muted-foreground tabular-nums">
              {current + 1} / {n}
            </p>
            <button type="button" aria-label="Следующий отзыв" onClick={() => go(1)} className={arrowClass}>
              <span aria-hidden="true">→</span>
            </button>
          </div>
        </section>
        {more ? (
          <a href={more.href} className={`mt-8 gap-2 text-body ${linkClass}`}>
            {more.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
