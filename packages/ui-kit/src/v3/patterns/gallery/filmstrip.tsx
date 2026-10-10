// Gallery «filmstrip»: a row of large photos running off the edge of the screen with snap points — turned by finger,
// by the arrow keys once the row has focus, or by the named buttons next to the title; it never scrolls by itself and
// jumps without smooth scrolling under reduced motion (catalog D1 Gallery «scroll-snap», M06). Own composition.
import { srcSetOf } from "@wizard/ui-kit/v3/headless";
import { useEffect, useRef, useState } from "react";

type Link = { label: string; href: string };
type Photo = { src: string; alt: string; caption?: string };

export type GalleryFilmstripProps = {
  title: string;
  lead?: string;
  images: Photo[];
  action?: Link;
};

const arrowClass =
  "inline-flex size-11 items-center justify-center rounded-control border border-border text-lead text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:border-transparent disabled:bg-transparent disabled:text-muted-foreground";

export default function GalleryFilmstrip({ title, lead, images, action }: GalleryFilmstripProps) {
  const row = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState({ start: true, end: false });
  const track = () => {
    const el = row.current;
    if (!el) return;
    const start = el.scrollLeft <= 4;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setEdge((e) => (e.start === start && e.end === end ? e : { start, end }));
  };
  // The buttons follow the row: both off when every photo fits, as the viewport changes.
  useEffect(() => {
    track();
    window.addEventListener("resize", track);
    return () => window.removeEventListener("resize", track);
  });
  const turn = (dir: number) => {
    const el = row.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: reduce ? "auto" : "smooth" });
  };
  return (
    <section className="overflow-hidden bg-background font-sans text-foreground">
      <div className="mx-auto w-full max-w-page px-gutter py-section">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 max-w-3xl">
            <h2 className="font-display text-h1 font-bold text-balance wrap-break-word">{title}</h2>
            {lead ? <p className="mt-4 max-w-text text-body text-muted-foreground">{lead}</p> : null}
          </div>
          <div className="flex shrink-0 gap-3">
            <button
              type="button"
              aria-label="Листать фото назад"
              disabled={edge.start}
              onClick={() => turn(-1)}
              className={arrowClass}
            >
              <span aria-hidden="true">←</span>
            </button>
            <button
              type="button"
              aria-label="Листать фото вперёд"
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
          className="-mx-gutter mt-10 flex snap-x snap-mandatory scroll-px-gutter gap-3 overflow-x-auto px-gutter pb-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:gap-5 lg:mt-12"
        >
          {images.map((im) => (
            <li key={im.src} className="w-[82%] shrink-0 snap-start sm:w-[26rem] lg:w-[34rem]">
              <figure>
                <img
                  src={im.src}
                  srcSet={srcSetOf(im.src)}
                  sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                  alt={im.alt}
                  loading="lazy"
                  className="aspect-4/3 w-full rounded-md bg-muted object-cover"
                />
                {im.caption ? (
                  <figcaption className="mt-3 text-small text-muted-foreground">{im.caption}</figcaption>
                ) : null}
              </figure>
            </li>
          ))}
        </ul>
        {action ? (
          <a
            href={action.href}
            className="mt-6 inline-flex min-h-11 min-w-11 items-center gap-2 text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {action.label}
            <span aria-hidden="true">→</span>
          </a>
        ) : null}
      </div>
    </section>
  );
}
