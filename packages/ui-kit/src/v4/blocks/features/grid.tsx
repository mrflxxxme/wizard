// Advantages grid: icon, title and a short text; 3 or 4 columns on desktop, one on phones. Variants: cards on the
// card colour, or open lines with a top rule.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon, type IconName } from "../kit/icons.js";
import { Reveal, useStill } from "../kit/motion.js";
import { iconSlot, line, para, variantSlot } from "../kit/slots.js";
import { Heading, Section } from "../kit/ui.js";

const VARIANTS = ["cards", "lines"] as const;

export type FeaturesGridProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  items: { icon: IconName; title: string; text: string }[];
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

export default function FeaturesGrid({
  eyebrow,
  title,
  lead,
  items,
  variant = "cards",
  wzId,
}: FeaturesGridProps) {
  const still = useStill();
  const cards = variant === "cards";
  const cols = items.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3";
  return (
    <Section block="FeaturesGrid" wzId={wzId}>
      <Heading eyebrow={eyebrow} title={title} lead={lead} />
      <ul className={`mt-12 grid gap-4 sm:grid-cols-2 ${cols} ${cards ? "" : "gap-y-10"}`}>
        {items.map((it, i) => (
          <li key={it.title}>
            <Reveal
              still={still}
              delay={i * 0.06}
              className={
                cards
                  ? "h-full rounded-lg border border-border bg-card p-6 text-card-foreground"
                  : "h-full border-t-2 border-foreground pt-6"
              }
            >
              <span
                className={`grid size-11 place-items-center rounded-md ${cards ? "bg-primary text-primary-foreground" : "text-primary"}`}
              >
                <Icon name={it.icon} className="size-6" />
              </span>
              <h3 className="mt-5 font-display text-h3 font-bold">{it.title}</h3>
              <p className="mt-2 text-body text-muted-foreground">{it.text}</p>
            </Reveal>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export const block = defineBlock<typeof FeaturesGrid>()({
  id: "features-grid",
  kind: "features",
  title: "Преимущества сеткой",
  description:
    "3–4 причины выбрать клиента: иконка Lucide, заголовок и одна-две фразы. «Карточки» — для мягких вайбов, «линии» — для строгих и редакционных.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    items: z
      .array(z.object({ icon: iconSlot, title: line(48), text: para(160) }))
      .min(3)
      .max(4),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "cards", title: "Карточки" },
    { id: "lines", title: "Открытые колонки с линией" },
  ],
  effect: "light",
  origin: "own",
  example: {
    eyebrow: "Почему мы",
    title: "Свет, который не придётся переделывать",
    items: [
      {
        icon: "shield-check",
        title: "Гарантия 3 года",
        text: "На монтаж и настройку. Приезжаем в течение суток, если что-то пошло не так.",
      },
      {
        icon: "clock",
        title: "Сроки в договоре",
        text: "Квартира — за 3–5 дней. За каждый день просрочки возвращаем 1 % сметы.",
      },
      {
        icon: "sparkles",
        title: "Проект света",
        text: "Считаем освещённость по комнатам, чтобы не было тёмных углов и бликов на экране.",
      },
      {
        icon: "wrench",
        title: "Свои мастера",
        text: "Не нанимаем субподрядчиков: электрики работают с нами от пяти лет.",
      },
    ],
  },
});
