// How it works: 3–5 numbered steps joined by a line — horizontal on desktop, vertical on phones; each step can say
// how long it takes.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Reveal, useStill } from "../kit/motion.js";
import { line, linkSlot, para } from "../kit/slots.js";
import { Heading, type Link, primaryBtn, Section } from "../kit/ui.js";

export type StepsTimelineProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  steps: { title: string; text: string; time?: string }[];
  action?: Link;
  wzId?: string;
};

export default function StepsTimeline({ eyebrow, title, lead, steps, action, wzId }: StepsTimelineProps) {
  const still = useStill();
  const cols =
    steps.length === 3 ? "lg:grid-cols-3" : steps.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4";
  return (
    <Section block="StepsTimeline" wzId={wzId}>
      <Heading eyebrow={eyebrow} title={title} lead={lead} />
      <ol className={`relative mt-14 grid gap-10 ${cols} lg:gap-6`}>
        <span
          aria-hidden="true"
          className="absolute top-5 bottom-5 left-5 w-px bg-border lg:top-5 lg:right-0 lg:bottom-auto lg:left-0 lg:h-px lg:w-full"
        />
        {steps.map((s, i) => (
          <li key={s.title} className="relative pl-16 lg:pl-0">
            <Reveal still={still} delay={i * 0.08}>
              <span className="absolute top-0 left-0 grid size-10 place-items-center rounded-full border border-border bg-background font-display text-body font-bold lg:relative">
                {i + 1}
              </span>
              <h3 className="font-display text-h3 font-bold lg:mt-6">{s.title}</h3>
              <p className="mt-2 text-body text-muted-foreground">{s.text}</p>
              {s.time ? <p className="mt-3 text-small font-semibold text-primary">{s.time}</p> : null}
            </Reveal>
          </li>
        ))}
      </ol>
      {action ? (
        <a href={action.href} className={`${primaryBtn} mt-14`}>
          {action.label}
        </a>
      ) : null}
    </Section>
  );
}

export const block = defineBlock<typeof StepsTimeline>()({
  id: "steps-timeline",
  kind: "steps",
  title: "Как мы работаем",
  description:
    "3–5 шагов от заявки до результата, соединённых линией; у шага может быть срок. Снимает страх «а что дальше» — для услуг с несколькими этапами.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    steps: z
      .array(z.object({ title: line(48), text: para(160), time: line(24).optional() }))
      .min(3)
      .max(5),
    action: linkSlot.optional(),
  }),
  variants: [{ id: "default", title: "Одна раскладка" }],
  effect: "light",
  origin: "own",
  example: {
    eyebrow: "Как это происходит",
    title: "От звонка до света — четыре шага",
    steps: [
      {
        title: "Замер",
        text: "Приезжаем, смотрим стены и проводку, обсуждаем, как вы живёте.",
        time: "Бесплатно, 1 час",
      },
      {
        title: "Проект и смета",
        text: "Схема света по комнатам и цена, которая не изменится.",
        time: "5 дней",
      },
      { title: "Монтаж", text: "Одна бригада, уборка каждый вечер, фотоотчёт в чат.", time: "3–5 дней" },
      { title: "Настройка", text: "Создаём сценарии и учим ими пользоваться всю семью.", time: "2 часа" },
    ],
    action: { label: "Записаться на замер", href: "#form" },
  },
});
