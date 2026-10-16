// First screen «split media»: offer with three checks on the left, a tall photo on the right with a floating rating
// card. No effect beyond the reveal; the photo is the LCP and loads with high priority.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { Reveal, useStill } from "../kit/motion.js";
import { imageSlot, line, linkSlot, para, variantSlot } from "../kit/slots.js";
import { type Image, type Link, primaryBtn, Section, secondaryBtn } from "../kit/ui.js";

const VARIANTS = ["photo-right", "photo-left"] as const;

export type HeroSplitMediaProps = {
  title: string;
  lead?: string;
  checks?: string[];
  action: Link;
  secondary?: Link;
  image: Image;
  badge?: { value: string; label: string };
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

export default function HeroSplitMedia({
  title,
  lead,
  checks,
  action,
  secondary,
  image,
  badge,
  variant = "photo-right",
  wzId,
}: HeroSplitMediaProps) {
  const still = useStill();
  const left = variant === "photo-left";
  return (
    <Section block="HeroSplitMedia" wzId={wzId}>
      <div className="grid items-center gap-12 lg:grid-cols-12 lg:gap-16">
        <div className={`min-w-0 lg:col-span-6 ${left ? "lg:order-2" : ""}`}>
          <h1 className="font-display text-hero font-bold text-balance">{title}</h1>
          {lead ? (
            <p className="mt-6 max-w-text text-lead text-pretty text-muted-foreground">{lead}</p>
          ) : null}
          {checks?.length ? (
            <ul className="mt-8 grid gap-3">
              {checks.map((c) => (
                <li key={c} className="flex gap-3 text-body">
                  <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                    <Icon name="check" className="size-3.5" />
                  </span>
                  {c}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <a href={action.href} className={primaryBtn} data-testid="wz-hero-primary">
              {action.label}
            </a>
            {secondary ? (
              <a href={secondary.href} className={secondaryBtn}>
                {secondary.label}
              </a>
            ) : null}
          </div>
        </div>
        <Reveal
          still={still}
          delay={0.1}
          className={`relative min-w-0 lg:col-span-6 ${left ? "lg:order-1" : ""}`}
        >
          <img
            src={image.src}
            alt={image.alt}
            fetchPriority="high"
            className="aspect-4/3 w-full rounded-lg bg-muted object-cover lg:aspect-4/5"
          />
          {badge ? (
            <div
              className={`absolute -bottom-6 ${left ? "right-4 lg:-right-6" : "left-4 lg:-left-6"} rounded-lg border border-border bg-card px-5 py-4 text-card-foreground shadow-lg`}
            >
              <p className="font-display text-h3 font-bold">{badge.value}</p>
              <p className="text-small text-muted-foreground">{badge.label}</p>
            </div>
          ) : null}
        </Reveal>
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof HeroSplitMedia>()({
  id: "hero-split-media",
  kind: "hero",
  title: "Первый экран: оффер и большое фото",
  description:
    "Оффер с тремя галочками слева, высокое фото справа с карточкой-цифрой. Без тяжёлых эффектов. Когда у клиента есть сильное фото: мастерские, клиники, кафе, ремонт.",
  slots: z.object({
    title: line(90),
    lead: para(220).optional(),
    checks: z.array(line(70)).max(3).optional(),
    action: linkSlot,
    secondary: linkSlot.optional(),
    image: imageSlot,
    badge: z.object({ value: line(12), label: line(40) }).optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "photo-right", title: "Фото справа" },
    { id: "photo-left", title: "Фото слева" },
  ],
  effect: "none",
  origin: "own",
  example: {
    title: "Монтаж освещения под ключ — от проекта до последней лампы",
    lead: "Электрик, дизайнер света и прораб в одной команде. Вы утверждаете проект — мы делаем всё остальное.",
    checks: [
      "Смета не меняется после подписания",
      "Чистота: убираем за собой каждый день",
      "Гарантия на работы 3 года",
    ],
    action: { label: "Получить смету", href: "#form" },
    secondary: { label: "Наши объекты", href: "#gallery" },
    image: {
      src: "/_wizard/photos/example-hero.webp",
      alt: "Гостиная с тёплой подсветкой потолка и стеллажа",
    },
    badge: { value: "120+", label: "объектов сдано" },
  },
});
