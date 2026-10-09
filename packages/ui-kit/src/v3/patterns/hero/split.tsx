// First screen «split»: the offer on the left (title, lead, actions, one practical line), a photo on the right;
// on phones the text comes first and the photo follows. Composition after HyperUI «Banners» (MIT, © Mark Mead),
// rewritten on the design system tokens.
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeroSplitProps = {
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  note?: string;
  image: Image;
  /** Place of the section in the page source: the build injects it (ui-kit.yaml#wz_id), never the composer. */
  wzId?: string;
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

export default function HeroSplit({ title, lead, action, secondary, note, image, wzId }: HeroSplitProps) {
  const enter = useEnter();
  return (
    <LazyMotion features={domAnimation}>
      <section data-wz-component="Hero" data-wz-id={wzId} className="bg-background font-sans text-foreground">
        <div className="mx-auto grid w-full max-w-page items-center gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-14">
          <div className="min-w-0 lg:col-span-6">
            <m.h1
              {...enter(0)}
              className="font-display text-hero font-bold text-balance wrap-break-word hyphens-auto"
            >
              {title}
            </m.h1>
            {lead ? (
              <m.p {...enter(1)} className="mt-5 max-w-text text-lead text-muted-foreground">
                {lead}
              </m.p>
            ) : null}
            <m.div {...enter(2)} className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <a href={action.href} data-testid="wz-hero-primary" className={primaryClass}>
                {action.label}
              </a>
              {secondary ? (
                <a href={secondary.href} className={secondaryClass}>
                  {secondary.label}
                </a>
              ) : null}
            </m.div>
            {note ? <p className="mt-5 text-small text-muted-foreground">{note}</p> : null}
          </div>
          <m.div {...enter(1)} className="min-w-0 lg:col-span-6">
            <img
              src={image.src}
              alt={image.alt}
              fetchPriority="high"
              className="aspect-4/3 w-full rounded-lg bg-muted object-cover lg:aspect-4/5"
            />
          </m.div>
        </div>
      </section>
    </LazyMotion>
  );
}
