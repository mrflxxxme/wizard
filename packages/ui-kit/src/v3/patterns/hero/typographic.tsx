// First screen «typographic»: no photo — the title set as a poster across the page, a heavy rule, the lead in the
// left half and the actions pushed to the right edge below it. Own composition.
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useState } from "react";

type Link = { label: string; href: string };

export type HeroTypographicProps = {
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  note?: string;
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

export default function HeroTypographic({
  title,
  lead,
  action,
  secondary,
  note,
  wzId,
}: HeroTypographicProps) {
  const enter = useEnter();
  return (
    <LazyMotion features={domAnimation}>
      <section data-wz-component="Hero" data-wz-id={wzId} className="bg-background font-sans text-foreground">
        <div className="mx-auto w-full max-w-page px-gutter py-section">
          <m.h1
            {...enter(0)}
            className="max-w-5xl font-display text-hero font-bold text-balance wrap-break-word hyphens-auto"
          >
            {title}
          </m.h1>
          <m.div
            {...enter(1)}
            className="mt-10 grid gap-8 border-t-2 border-foreground pt-6 md:grid-cols-12 md:gap-6"
          >
            {lead ? <p className="text-lead text-pretty md:col-span-6">{lead}</p> : null}
            <div className="flex flex-col gap-4 md:col-span-5 md:col-start-8 md:items-end">
              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap md:justify-end">
                <a
                  href={action.href}
                  data-testid="wz-hero-primary"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control bg-foreground px-6 text-center text-body font-bold text-background transition-opacity duration-200 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {action.label}
                </a>
                {secondary ? (
                  <a
                    href={secondary.href}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center px-2 text-center text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {secondary.label}
                  </a>
                ) : null}
              </div>
              {note ? <p className="text-small text-muted-foreground md:text-right">{note}</p> : null}
            </div>
          </m.div>
        </div>
      </section>
    </LazyMotion>
  );
}
