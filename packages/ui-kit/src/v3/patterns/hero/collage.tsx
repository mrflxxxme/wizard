// First screen «collage»: the offer on the left, two or three photos overlapping with offsets on the right, framed
// by the page colour; on phones a single photo (catalog D1 Hero collage). Own composition.
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeroCollageProps = {
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  images: Image[];
};

/** Entrance of the first screen (catalog E3): once, only with the lively motion profile, never with reduced motion. */
function useEnter() {
  const reduce = useReducedMotion();
  const [lively] = useState(
    () =>
      typeof document !== "undefined" &&
      getComputedStyle(document.documentElement).getPropertyValue("--ds-motion").trim() === "lively",
  );
  const on = lively && !reduce;
  return (step: number) =>
    on
      ? {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.6, delay: step * 0.05, ease: [0.23, 1, 0.32, 1] as const },
        }
      : {};
}

const frameClass = "h-full w-full rounded-md border-4 border-background bg-muted object-cover";

export default function HeroCollage({ title, lead, action, secondary, images }: HeroCollageProps) {
  const enter = useEnter();
  const [first, second, third] = images;
  return (
    <section className="overflow-hidden bg-background font-sans text-foreground">
      <div className="mx-auto grid w-full max-w-page items-center gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-12">
        <div className="min-w-0 lg:col-span-5">
          <motion.h1
            {...enter(0)}
            className="font-display text-hero font-bold text-balance wrap-break-word hyphens-auto"
          >
            {title}
          </motion.h1>
          {lead ? (
            <motion.p {...enter(1)} className="mt-5 text-lead text-muted-foreground">
              {lead}
            </motion.p>
          ) : null}
          <motion.div {...enter(2)} className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <a
              href={action.href}
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {action.label}
            </a>
            {secondary ? (
              <a
                href={secondary.href}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-6 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {secondary.label}
              </a>
            ) : null}
          </motion.div>
        </div>
        <motion.div
          {...enter(1)}
          className="grid aspect-4/3 min-w-0 grid-cols-6 grid-rows-6 sm:aspect-square lg:col-span-7"
        >
          {first ? (
            <img
              src={first.src}
              alt={first.alt}
              fetchPriority="high"
              className={`col-span-6 row-span-6 sm:col-start-1 sm:col-end-5 sm:row-start-1 sm:row-end-5 ${frameClass}`}
            />
          ) : null}
          {second ? (
            <img
              src={second.src}
              alt={second.alt}
              loading="lazy"
              className={`z-10 col-span-3 col-start-4 row-span-3 row-start-3 hidden sm:block ${frameClass}`}
            />
          ) : null}
          {third ? (
            <img
              src={third.src}
              alt={third.alt}
              loading="lazy"
              className={`z-20 col-span-3 col-start-2 row-span-2 row-start-5 hidden sm:block ${frameClass}`}
            />
          ) : null}
        </motion.div>
      </div>
    </section>
  );
}
