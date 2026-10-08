// First screen «centered»: the offer centred on a calm field, actions side by side, an optional wide photo below.
// Composition after HyperUI «Banners» (MIT, © Mark Mead), rewritten on the design system tokens.
import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeroCenteredProps = {
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  note?: string;
  image?: Image;
};

const primaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const secondaryClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border px-6 text-center text-body font-bold text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

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

export default function HeroCentered({ title, lead, action, secondary, note, image }: HeroCenteredProps) {
  const enter = useEnter();
  return (
    <section className="bg-background font-sans text-foreground">
      <div
        className={`mx-auto flex w-full max-w-page flex-col items-center px-gutter pt-section text-center ${image ? "" : "pb-section"}`}
      >
        <motion.h1
          {...enter(0)}
          className="max-w-4xl font-display text-hero font-bold text-balance wrap-break-word hyphens-auto"
        >
          {title}
        </motion.h1>
        {lead ? (
          <motion.p {...enter(1)} className="mt-6 max-w-text text-lead text-pretty text-muted-foreground">
            {lead}
          </motion.p>
        ) : null}
        <motion.div
          {...enter(2)}
          className="mt-8 flex w-full flex-col justify-center gap-3 sm:w-auto sm:flex-row sm:flex-wrap"
        >
          <a href={action.href} className={primaryClass}>
            {action.label}
          </a>
          {secondary ? (
            <a href={secondary.href} className={secondaryClass}>
              {secondary.label}
            </a>
          ) : null}
        </motion.div>
        {note ? <p className="mt-5 text-small text-muted-foreground">{note}</p> : null}
      </div>
      {image ? (
        <motion.div {...enter(3)} className="mx-auto w-full max-w-page px-gutter pt-12 pb-section">
          <img
            src={image.src}
            alt={image.alt}
            className="aspect-4/3 w-full rounded-lg bg-muted object-cover sm:aspect-video"
          />
        </motion.div>
      ) : null}
    </section>
  );
}
