// First screen «event poster»: the title as a poster headline, then the date and the place set large between heavy
// rules, the action next to them, the lead below (catalog D1 Hero event-poster). Own composition.
import { useFitWords } from "@wizard/ui-kit/v3/headless";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useState } from "react";

type Link = { label: string; href: string };

export type HeroEventPosterProps = {
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  when: string;
  where: string;
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

export default function HeroEventPoster({
  title,
  lead,
  action,
  secondary,
  when,
  where,
  wzId,
}: HeroEventPosterProps) {
  const enter = useEnter();
  const fit = useFitWords<HTMLHeadingElement>(title);
  return (
    <LazyMotion features={domAnimation}>
      <section data-wz-component="Hero" data-wz-id={wzId} className="bg-background font-sans text-foreground">
        <div className="mx-auto w-full max-w-page px-gutter py-section">
          <m.h1
            ref={fit}
            {...enter(0)}
            className="max-w-5xl font-display text-hero font-bold text-balance wrap-break-word hyphens-auto"
          >
            {title}
          </m.h1>
          <m.div
            {...enter(1)}
            className="mt-10 grid border-y-2 border-foreground lg:grid-cols-12 lg:items-center"
          >
            <dl className="grid sm:grid-cols-2 lg:col-span-9">
              <div className="border-b border-border py-5 sm:border-r sm:border-b-0 sm:pr-6">
                <dt className="text-small text-muted-foreground">Когда</dt>
                <dd className="mt-1 font-display text-h2 font-bold wrap-break-word">{when}</dd>
              </div>
              <div className="border-b border-border py-5 sm:border-b-0 sm:pl-6 lg:border-r lg:pr-6">
                <dt className="text-small text-muted-foreground">Где</dt>
                <dd className="mt-1 font-display text-h3 font-bold wrap-break-word">{where}</dd>
              </div>
            </dl>
            <div className="py-5 lg:col-span-3 lg:pl-6">
              <a
                href={action.href}
                data-testid="wz-hero-primary"
                className="flex min-h-11 w-full items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {action.label}
              </a>
            </div>
          </m.div>
          {lead || secondary ? (
            <div className="mt-8 grid gap-4 md:grid-cols-12">
              {lead ? <p className="text-lead text-muted-foreground md:col-span-7">{lead}</p> : null}
              {secondary ? (
                <a
                  href={secondary.href}
                  className="inline-flex min-h-11 min-w-11 items-center text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:col-span-4 md:col-start-9 md:justify-self-end"
                >
                  {secondary.label}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </LazyMotion>
  );
}
