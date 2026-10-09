// First screen «full-bleed photo»: the photo fills the screen edge to edge, the offer sits bottom-left on a scrim
// panel that keeps text readable over any part of the photo (catalog I04). Own composition.
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useState } from "react";

type Link = { label: string; href: string };
type Image = { src: string; alt: string };

export type HeroFullBleedProps = {
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  note?: string;
  image: Image;
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

export default function HeroFullBleed({
  title,
  lead,
  action,
  secondary,
  note,
  image,
  wzId,
}: HeroFullBleedProps) {
  const enter = useEnter();
  return (
    <LazyMotion features={domAnimation}>
      <section
        data-wz-component="Hero"
        data-wz-id={wzId}
        className="relative isolate flex min-h-[min(88svh,52rem)] items-end overflow-hidden bg-inverse font-sans"
      >
        <img
          src={image.src}
          alt={image.alt}
          fetchPriority="high"
          className="absolute inset-0 -z-10 h-full w-full object-cover"
        />
        <div className="mx-auto w-full max-w-page px-gutter py-section">
          <m.div {...enter(0)} className="max-w-2xl rounded-lg bg-scrim p-6 text-scrim-foreground sm:p-10">
            <h1 className="font-display text-hero font-bold text-balance wrap-break-word hyphens-auto">
              {title}
            </h1>
            {lead ? <p className="mt-5 text-lead text-scrim-foreground">{lead}</p> : null}
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <a
                href={action.href}
                data-testid="wz-hero-primary"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scrim-foreground"
              >
                {action.label}
              </a>
              {secondary ? (
                <a
                  href={secondary.href}
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-scrim-foreground px-6 text-center text-body font-bold text-scrim-foreground transition-colors duration-200 hover:bg-scrim-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-scrim-foreground"
                >
                  {secondary.label}
                </a>
              ) : null}
            </div>
            {note ? <p className="mt-5 text-small text-scrim-foreground">{note}</p> : null}
          </m.div>
        </div>
      </section>
    </LazyMotion>
  );
}
