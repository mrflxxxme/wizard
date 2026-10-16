// First screen «aurora»: a light page with soft colour clouds drifting behind a centred offer and a proof line.
// Light effect (CSS blur + Motion drift); static clouds on phones and under reduced motion. Idea after Magic UI
// «Aurora Text» and «Retro Grid» (MIT, © Magic UI), rewritten on the theme tokens.
import { domAnimation, LazyMotion, m } from "motion/react";
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { useStill } from "../kit/motion.js";
import { line, linkSlot, para, variantSlot } from "../kit/slots.js";
import { type Link, primaryBtn, Section, secondaryBtn } from "../kit/ui.js";

const VARIANTS = ["clouds", "grid"] as const;

export type HeroAuroraProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  action: Link;
  secondary?: Link;
  /** Proof under the actions: a rating and what it is based on. */
  proof?: { rating: string; label: string };
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

const CLOUDS = [
  { cls: "left-[8%] top-[10%] size-[38rem] bg-primary/30", x: [0, 60, 0], y: [0, 40, 0] },
  { cls: "right-[6%] top-[22%] size-[30rem] bg-primary/20", x: [0, -50, 0], y: [0, 30, 0] },
  { cls: "left-[35%] bottom-[-20%] size-[34rem] bg-muted", x: [0, 30, 0], y: [0, -40, 0] },
] as const;

export default function HeroAurora({
  eyebrow,
  title,
  lead,
  action,
  secondary,
  proof,
  variant = "clouds",
  wzId,
}: HeroAuroraProps) {
  const still = useStill();
  const backdrop = (
    <LazyMotion features={domAnimation}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        {CLOUDS.map((c) => (
          <m.div
            key={c.cls}
            className={`absolute rounded-full blur-3xl ${c.cls}`}
            animate={still ? undefined : { x: [...c.x], y: [...c.y] }}
            transition={{ duration: 18, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
          />
        ))}
        {variant === "grid" ? (
          <div className="absolute inset-0 bg-[linear-gradient(var(--color-border)_1px,transparent_1px),linear-gradient(90deg,var(--color-border)_1px,transparent_1px)] mask-[radial-gradient(70%_60%_at_50%_40%,black,transparent)] bg-size-[56px_56px] opacity-60" />
        ) : null}
        <div className="absolute inset-x-0 bottom-0 h-40 bg-linear-to-b from-transparent to-background" />
      </div>
    </LazyMotion>
  );
  return (
    <Section
      block="HeroAurora"
      wzId={wzId}
      backdrop={backdrop}
      inner="py-section md:py-[calc(var(--spacing-section)*1.6)]"
    >
      <div className="mx-auto max-w-[52rem] text-center">
        {eyebrow ? (
          <p className="inline-flex items-center gap-2 rounded-control border border-border bg-background/70 px-3 py-1 text-small text-muted-foreground backdrop-blur">
            <Icon name="sparkles" className="size-4 text-primary" />
            {eyebrow}
          </p>
        ) : null}
        <h1 className="mt-6 font-display text-hero font-bold text-balance">{title}</h1>
        {lead ? (
          <p className="mx-auto mt-6 max-w-text text-lead text-pretty text-muted-foreground">{lead}</p>
        ) : null}
        <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
          <a href={action.href} className={primaryBtn} data-testid="wz-hero-primary">
            {action.label}
            <Icon name="arrow-right" className="size-4" />
          </a>
          {secondary ? (
            <a href={secondary.href} className={`${secondaryBtn} bg-background/70 backdrop-blur`}>
              {secondary.label}
            </a>
          ) : null}
        </div>
        {proof ? (
          <p className="mt-8 inline-flex flex-wrap items-center justify-center gap-2 text-small text-muted-foreground">
            <span className="inline-flex text-primary" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <Icon key={i} name="star" className="size-4 fill-current" />
              ))}
            </span>
            <span>
              <strong className="font-semibold text-foreground">{proof.rating}</strong> — {proof.label}
            </span>
          </p>
        ) : null}
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof HeroAurora>()({
  id: "hero-aurora",
  kind: "hero",
  title: "Светлый первый экран с цветными облаками",
  description:
    "Светлый центрированный первый экран: мягкие облака цвета бренда плывут за оффером, под кнопками — рейтинг. Лёгкий эффект. Для услуг, сервисов и студий с дружелюбным тоном; вариант «сетка» — для технологичных.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(90),
    lead: para(220).optional(),
    action: linkSlot,
    secondary: linkSlot.optional(),
    proof: z.object({ rating: line(12), label: line(60) }).optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "clouds", title: "Облака" },
    { id: "grid", title: "Облака и тонкая сетка" },
  ],
  effect: "light",
  origin: "magic-ui",
  example: {
    eyebrow: "Новое: сценарии для детской",
    title: "Умный свет без проводки заново и пыли",
    lead: "Ставим беспроводные выключатели и датчики за один день. Управление — с телефона, голосом или по расписанию.",
    action: { label: "Записаться на замер", href: "#form" },
    secondary: { label: "Как это работает", href: "#steps" },
    proof: { rating: "4,9", label: "312 отзывов на Яндекс Картах" },
  },
});
