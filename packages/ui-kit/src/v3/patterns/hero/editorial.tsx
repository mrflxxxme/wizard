// First screen «editorial»: a tall photo with a caption on the left, on the right the title set large and, under a
// heavy rule, the lead and the actions in two columns — a magazine spread. On phones the text comes first.
// Own composition.
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeroEditorialProps = {
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  note?: string;
  image: Image;
  caption?: string;
  /** Place of the section in the page source: the build injects it (ui-kit.yaml#wz_id), never the composer. */
  wzId?: string;
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

export default function HeroEditorial({
  title,
  lead,
  action,
  secondary,
  note,
  image,
  caption,
  wzId,
}: HeroEditorialProps) {
  const enter = useEnter();
  return (
    <LazyMotion features={domAnimation}>
      <section data-wz-component="Hero" data-wz-id={wzId} className="bg-background font-sans text-foreground">
        <div className="mx-auto grid w-full max-w-page gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-x-12">
          <m.figure {...enter(1)} className="order-2 min-w-0 lg:order-1 lg:col-span-5">
            <img
              src={image.src}
              alt={image.alt}
              fetchPriority="high"
              className="aspect-4/5 w-full bg-muted object-cover lg:aspect-3/4"
            />
            {caption ? (
              <figcaption className="mt-3 border-t border-border pt-2 text-small text-muted-foreground">
                {caption}
              </figcaption>
            ) : null}
          </m.figure>
          <div className="order-1 flex min-w-0 flex-col justify-between gap-10 lg:order-2 lg:col-span-7">
            <m.h1
              {...enter(0)}
              className="font-display text-hero font-bold text-balance wrap-break-word hyphens-auto"
            >
              {title}
            </m.h1>
            <m.div {...enter(2)} className="grid gap-6 border-t-2 border-foreground pt-6 sm:grid-cols-2">
              {lead ? <p className="text-lead">{lead}</p> : null}
              <div className="flex flex-col items-stretch gap-3 sm:items-start">
                <a
                  href={action.href}
                  data-testid="wz-hero-primary"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {action.label}
                </a>
                {secondary ? (
                  <a
                    href={secondary.href}
                    className="inline-flex min-h-11 min-w-11 items-center text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {secondary.label}
                  </a>
                ) : null}
                {note ? <p className="text-small text-muted-foreground">{note}</p> : null}
              </div>
            </m.div>
          </div>
        </div>
      </section>
    </LazyMotion>
  );
}
