// First screen «offer card»: the title and lead on the left, on the right a card with the concrete offer from the
// brief (name, price, what is included) and the main action inside it (catalog D1 Hero offer-card). Own composition.
import { useFitWords } from "@wizard/ui-kit/v3/headless";
import { domAnimation, LazyMotion, m, useReducedMotion } from "motion/react";
import { useState } from "react";

type Link = { label: string; href: string };

export type HeroOfferCardProps = {
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  note?: string;
  offer: { title: string; price?: string; points?: string[] };
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

export default function HeroOfferCard({
  title,
  lead,
  action,
  secondary,
  note,
  offer,
  wzId,
}: HeroOfferCardProps) {
  const enter = useEnter();
  const fit = useFitWords<HTMLHeadingElement>(title);
  return (
    <LazyMotion features={domAnimation}>
      <section data-wz-component="Hero" data-wz-id={wzId} className="bg-muted font-sans text-foreground">
        <div className="mx-auto grid w-full max-w-page items-center gap-10 px-gutter py-section lg:grid-cols-12 lg:gap-12">
          <div className="min-w-0 lg:col-span-7">
            <m.h1
              ref={fit}
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
            {secondary ? (
              <a
                href={secondary.href}
                className="mt-6 inline-flex min-h-11 min-w-11 items-center text-body font-bold text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {secondary.label}
              </a>
            ) : null}
          </div>
          <m.div
            {...enter(2)}
            className="min-w-0 rounded-lg border border-border bg-card p-6 text-card-foreground sm:p-8 lg:col-span-5"
          >
            <h2 className="font-display text-h3 font-bold wrap-break-word">{offer.title}</h2>
            {offer.price ? (
              <p className="mt-2 font-display text-h1 font-bold tabular-nums wrap-break-word">
                {offer.price}
              </p>
            ) : null}
            {offer.points?.length ? (
              <ul className="mt-6 flex flex-col gap-3 border-t border-border pt-6">
                {offer.points.map((p) => (
                  <li key={p} className="flex gap-3 text-body">
                    <span aria-hidden="true" className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" />
                    <span className="min-w-0">{p}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <a
              href={action.href}
              data-testid="wz-hero-primary"
              className="mt-8 flex min-h-11 w-full items-center justify-center rounded-control bg-primary px-6 text-center text-body font-bold text-primary-foreground transition-colors duration-200 hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {action.label}
            </a>
            {note ? <p className="mt-4 text-small text-muted-foreground">{note}</p> : null}
          </m.div>
        </div>
      </section>
    </LazyMotion>
  );
}
