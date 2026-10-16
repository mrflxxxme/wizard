// FAQ: questions as native disclosures (details/summary — works without JS, keyboard and screen readers included);
// «split» puts the heading and a contact line on the left.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { line, linkSlot, para, variantSlot } from "../kit/slots.js";
import { focusRing, Heading, type Link, Section } from "../kit/ui.js";

const VARIANTS = ["split", "center"] as const;

export type FaqAccordionProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  items: { q: string; a: string }[];
  contact?: Link;
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

export default function FaqAccordion({
  eyebrow,
  title,
  lead,
  items,
  contact,
  variant = "split",
  wzId,
}: FaqAccordionProps) {
  const split = variant === "split";
  return (
    <Section block="FaqAccordion" wzId={wzId}>
      <div className={split ? "grid gap-10 lg:grid-cols-12" : ""}>
        <div className={split ? "lg:col-span-4" : ""}>
          <Heading eyebrow={eyebrow} title={title} lead={lead} center={!split} />
          {contact ? (
            <a
              href={contact.href}
              className={`mt-6 inline-flex items-center gap-2 text-body font-semibold text-primary ${focusRing} ${split ? "" : "hidden"}`}
            >
              <Icon name="message-circle" className="size-5" />
              {contact.label}
            </a>
          ) : null}
        </div>
        <div className={split ? "lg:col-span-8" : "mx-auto mt-12 max-w-[48rem]"}>
          {items.map((it, i) => (
            <details key={it.q} open={i === 0} className="group border-b border-border first:border-t">
              <summary
                className={`flex cursor-pointer list-none items-center justify-between gap-6 py-6 font-display text-h3 font-bold [&::-webkit-details-marker]:hidden ${focusRing}`}
              >
                {it.q}
                <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border transition-transform duration-300 group-open:rotate-45">
                  <Icon name="plus" className="size-4" />
                </span>
              </summary>
              <p className="max-w-text pr-12 pb-6 text-body text-muted-foreground">{it.a}</p>
            </details>
          ))}
        </div>
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof FaqAccordion>()({
  id: "faq-accordion",
  kind: "faq",
  title: "Вопросы и ответы",
  description:
    "Раскрывающиеся вопросы (работают без JS); первый открыт. «Сбоку» — заголовок и ссылка «спросить» слева. Отвечает на возражения из интервью.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    items: z
      .array(z.object({ q: line(120), a: para(480) }))
      .min(3)
      .max(10),
    contact: linkSlot.optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "split", title: "Заголовок сбоку" },
    { id: "center", title: "По центру" },
  ],
  effect: "none",
  origin: "shadcn-ui",
  example: {
    eyebrow: "Вопросы",
    title: "Отвечаем до того, как вы спросите",
    contact: { label: "Не нашли ответ? Напишите нам", href: "#contacts" },
    items: [
      {
        q: "Нужно ли штробить стены?",
        a: "Для умного света без ремонта — нет: выключатели беспроводные, а реле ставятся в подрозетники и светильники. Штробим только при монтаже под ключ на этапе черновой отделки.",
      },
      {
        q: "Что будет, если пропадёт интернет?",
        a: "Свет продолжит работать от выключателей и датчиков: сценарии хранятся в контроллере дома, а не в облаке.",
      },
      {
        q: "Можно ли оплатить частями?",
        a: "Да: 30 % при подписании, 50 % после монтажа и 20 % после настройки.",
      },
      {
        q: "Какую гарантию даёте?",
        a: "Три года на работы и настройку, на оборудование — гарантия производителя. Выезд по гарантии — в течение суток.",
      },
    ],
  },
});
