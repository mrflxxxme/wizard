// Pricing: 2–3 plans side by side, one highlighted with the primary colour and a label; each with a price, a line
// for whom it is, what is included and an action. Phones stack the plans, the highlighted one first.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { line, linkSlot, para } from "../kit/slots.js";
import { Heading, type Link, primaryBtn, Section, secondaryBtn } from "../kit/ui.js";

type Plan = {
  name: string;
  price: string;
  unit?: string;
  for?: string;
  points: string[];
  action: Link;
  label?: string;
};

export type PricingTiersProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  plans: Plan[];
  /** Index of the highlighted plan. */
  featured?: number;
  note?: string;
  wzId?: string;
};

export default function PricingTiers({
  eyebrow,
  title,
  lead,
  plans,
  featured = 1,
  note,
  wzId,
}: PricingTiersProps) {
  return (
    <Section block="PricingTiers" wzId={wzId}>
      <Heading eyebrow={eyebrow} title={title} lead={lead} center />
      <ul
        className={`mt-12 grid items-stretch gap-4 ${plans.length === 2 ? "mx-auto max-w-[52rem] md:grid-cols-2" : "lg:grid-cols-3"}`}
      >
        {plans.map((p, i) => {
          const hot = i === featured;
          return (
            <li
              key={p.name}
              className={`relative flex flex-col rounded-lg border p-8 ${hot ? "-order-1 border-primary bg-card text-card-foreground shadow-xl ring-1 ring-primary lg:order-none lg:-my-4 lg:py-12" : "border-border bg-card text-card-foreground"}`}
            >
              {hot && p.label ? (
                <span className="absolute -top-3 left-8 rounded-control bg-primary px-3 py-1 text-small font-semibold text-primary-foreground">
                  {p.label}
                </span>
              ) : null}
              <h3 className="font-display text-h3 font-bold">{p.name}</h3>
              {p.for ? <p className="mt-2 text-small text-muted-foreground">{p.for}</p> : null}
              <p className="mt-6 flex items-baseline gap-2">
                <span className="font-display text-h1 font-bold">{p.price}</span>
                {p.unit ? <span className="text-small text-muted-foreground">{p.unit}</span> : null}
              </p>
              <ul className="mt-6 grid flex-1 content-start gap-3 border-t border-border pt-6">
                {p.points.map((pt) => (
                  <li key={pt} className="flex gap-3 text-body">
                    <Icon name="check" className="mt-1 size-4 shrink-0 text-primary" />
                    {pt}
                  </li>
                ))}
              </ul>
              <a href={p.action.href} className={`${hot ? primaryBtn : secondaryBtn} mt-8 w-full`}>
                {p.action.label}
              </a>
            </li>
          );
        })}
      </ul>
      {note ? <p className="mt-10 text-center text-small text-muted-foreground">{note}</p> : null}
    </Section>
  );
}

export const block = defineBlock<typeof PricingTiers>()({
  id: "pricing-tiers",
  kind: "pricing",
  title: "Тарифы",
  description:
    "2–3 пакета рядом, один выделен цветом и меткой; цена, для кого, что входит, кнопка. Когда у клиента есть понятные пакеты. Цены — только из брифа.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    plans: z
      .array(
        z.object({
          name: line(32),
          price: line(20),
          unit: line(24).optional(),
          for: line(80).optional(),
          points: z.array(line(70)).min(2).max(6),
          action: linkSlot,
          label: line(20).optional(),
        }),
      )
      .min(2)
      .max(3),
    featured: z.number().int().min(0).max(2).optional(),
    note: line(140).optional(),
  }),
  variants: [{ id: "default", title: "Одна раскладка" }],
  effect: "none",
  origin: "shadcn-ui",
  example: {
    eyebrow: "Цены",
    title: "Три пакета на квартиру до 80 м²",
    plans: [
      {
        name: "Старт",
        price: "45 000 ₽",
        for: "Умный свет без ремонта",
        points: ["До 8 выключателей", "3 сценария", "Настройка голоса"],
        action: { label: "Выбрать", href: "#form" },
      },
      {
        name: "Квартира",
        price: "120 000 ₽",
        for: "Монтаж под ключ",
        points: ["Проект света", "Проводка и светильники", "До 12 сценариев", "Гарантия 3 года"],
        action: { label: "Выбрать «Квартиру»", href: "#form" },
        label: "Чаще всего",
      },
      {
        name: "Дом",
        price: "от 260 000 ₽",
        for: "Загородный дом",
        points: ["Проект и смета за 7 дней", "Фасад и участок", "Сценарии и датчики"],
        action: { label: "Обсудить", href: "#form" },
      },
    ],
    note: "Замер и выезд по Москве — бесплатно. Оборудование оплачивается отдельно по чеку.",
  },
});
