// Services as a numbered price list: name, one line of what is included, duration and price, a row link with an
// arrow that slides on hover. Reads well on phones (rows stack) and suits any vibe.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { line, linkSlot, para, variantSlot } from "../kit/slots.js";
import { focusRing, Heading, type Link, Section } from "../kit/ui.js";

const VARIANTS = ["numbered", "plain"] as const;

export type ServicesListProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  items: { name: string; text?: string; price?: string; duration?: string; href?: string }[];
  action?: Link;
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

export default function ServicesList({
  eyebrow,
  title,
  lead,
  items,
  action,
  variant = "numbered",
  wzId,
}: ServicesListProps) {
  return (
    <Section block="ServicesList" wzId={wzId}>
      <div className="grid gap-10 lg:grid-cols-12">
        <div className="lg:col-span-4">
          <div className="lg:sticky lg:top-24">
            <Heading eyebrow={eyebrow} title={title} lead={lead} />
            {action ? (
              <a
                href={action.href}
                className={`mt-8 inline-flex items-center gap-2 text-body font-semibold underline-offset-4 hover:underline ${focusRing}`}
              >
                {action.label}
                <Icon name="arrow-right" className="size-4" />
              </a>
            ) : null}
          </div>
        </div>
        <ol className="border-t border-border lg:col-span-8">
          {items.map((it, i) => {
            const body = (
              <>
                {variant === "numbered" ? (
                  <span className="w-10 shrink-0 font-display text-body font-bold text-muted-foreground tabular-nums">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-h3 font-bold">{it.name}</span>
                  {it.text ? (
                    <span className="mt-1 block text-body text-muted-foreground">{it.text}</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 items-baseline gap-4 sm:flex-col sm:items-end sm:gap-1">
                  {it.price ? <span className="text-body font-semibold">{it.price}</span> : null}
                  {it.duration ? (
                    <span className="text-small text-muted-foreground">{it.duration}</span>
                  ) : null}
                </span>
                {it.href ? (
                  <Icon
                    name="arrow-up-right"
                    className="hidden size-5 shrink-0 text-primary transition-transform duration-200 group-hover:translate-x-1 group-hover:-translate-y-1 sm:block"
                  />
                ) : null}
              </>
            );
            const row =
              "group flex flex-col gap-3 border-b border-border py-6 sm:flex-row sm:items-center sm:gap-6";
            return (
              <li key={it.name}>
                {it.href ? (
                  <a href={it.href} className={`${row} transition-colors hover:bg-muted/50 ${focusRing}`}>
                    {body}
                  </a>
                ) : (
                  <div className={row}>{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof ServicesList>()({
  id: "services-list",
  kind: "services",
  title: "Услуги прайс-листом",
  description:
    "Нумерованный список услуг: название, что входит, цена и срок; заголовок слева липнет при прокрутке. Для любых услуг с понятными ценами «от».",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    items: z
      .array(
        z.object({
          name: line(60),
          text: line(140).optional(),
          price: line(24).optional(),
          duration: line(24).optional(),
          href: linkSlot.shape.href.optional(),
        }),
      )
      .min(3)
      .max(8),
    action: linkSlot.optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "numbered", title: "С номерами" },
    { id: "plain", title: "Без номеров" },
  ],
  effect: "none",
  origin: "own",
  example: {
    eyebrow: "Услуги",
    title: "Что делаем",
    lead: "Цены — за квартиру до 80 м². Точную сумму называем после замера, и она не меняется.",
    items: [
      {
        name: "Проект освещения",
        text: "Расчёт света, схема групп, подбор светильников",
        price: "от 18 000 ₽",
        duration: "5 дней",
        href: "#form",
      },
      {
        name: "Умный свет без ремонта",
        text: "Беспроводные выключатели, датчики, сценарии",
        price: "от 45 000 ₽",
        duration: "1 день",
        href: "#form",
      },
      {
        name: "Монтаж под ключ",
        text: "Проводка, светильники, настройка и уборка",
        price: "от 120 000 ₽",
        duration: "3–5 дней",
        href: "#form",
      },
      {
        name: "Подсветка ниш и лестниц",
        text: "Профиль, лента, блоки питания",
        price: "от 2 400 ₽/м",
        duration: "1 день",
        href: "#form",
      },
    ],
    action: { label: "Все услуги и цены", href: "/services" },
  },
});
