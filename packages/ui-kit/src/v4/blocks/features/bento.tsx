// Bento of advantages: one large cell and smaller ones in an asymmetric grid; on desktop a soft spotlight follows the
// pointer over each cell. Spotlight idea after Magic UI «Magic Card» (MIT, © Magic UI), rewritten with CSS variables.
import type { PointerEvent } from "react";
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon, type IconName } from "../kit/icons.js";
import { useStill } from "../kit/motion.js";
import { iconSlot, line, para } from "../kit/slots.js";
import { Heading, Section } from "../kit/ui.js";

export type FeaturesBentoProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  /** First cell is the large one; 4 or 5 cells. */
  cells: { icon: IconName; title: string; text: string; value?: string }[];
  wzId?: string;
};

const SPANS = [
  "lg:col-span-4 lg:row-span-2",
  "lg:col-span-2",
  "lg:col-span-2",
  "lg:col-span-3",
  "lg:col-span-3",
];

function spot(e: PointerEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--x", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--y", `${e.clientY - r.top}px`);
}

export default function FeaturesBento({ eyebrow, title, lead, cells, wzId }: FeaturesBentoProps) {
  const still = useStill();
  return (
    <Section block="FeaturesBento" wzId={wzId} className="bg-muted text-foreground">
      <Heading eyebrow={eyebrow} title={title} lead={lead} />
      <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {cells.map((c, i) => (
          <li
            key={c.title}
            onPointerMove={still ? undefined : spot}
            className={`group relative flex flex-col overflow-hidden rounded-lg border border-border bg-card p-6 text-card-foreground ${SPANS[i] ?? "lg:col-span-2"} ${i === 0 ? "sm:col-span-2 lg:p-10" : ""}`}
          >
            {still ? null : (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                style={{
                  background:
                    "radial-gradient(320px circle at var(--x) var(--y), color-mix(in oklab, var(--color-primary) 14%, transparent), transparent 70%)",
                }}
              />
            )}
            <Icon name={c.icon} className="relative size-7 text-primary" />
            {c.value ? (
              <p
                className={`relative mt-auto pt-10 font-display font-bold ${i === 0 ? "text-hero" : "text-h1"}`}
              >
                {c.value}
              </p>
            ) : null}
            <h3 className={`relative font-display text-h3 font-bold ${c.value ? "mt-2" : "mt-auto pt-10"}`}>
              {c.title}
            </h3>
            <p className="relative mt-2 max-w-text text-body text-muted-foreground">{c.text}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export const block = defineBlock<typeof FeaturesBento>()({
  id: "features-bento",
  kind: "features",
  title: "Бенто преимуществ",
  description:
    "Асимметричная сетка из 4–5 ячеек: первая большая, в ячейках можно показать цифру. На десктопе мягкий световой блик идёт за курсором. Для технологичных и современных вайбов.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    cells: z
      .array(z.object({ icon: iconSlot, title: line(48), text: para(160), value: line(10).optional() }))
      .min(4)
      .max(5),
  }),
  variants: [{ id: "default", title: "Одна раскладка" }],
  effect: "light",
  origin: "magic-ui",
  example: {
    eyebrow: "Что вы получаете",
    title: "Одна система вместо десятка выключателей",
    cells: [
      {
        icon: "zap",
        title: "Экономия на счетах",
        text: "Датчики присутствия гасят свет в пустых комнатах, диммеры снижают мощность вечером.",
        value: "−38 %",
      },
      { icon: "smile", title: "Сценарии", text: "«Утро», «Кино», «Ночник» — одной кнопкой." },
      { icon: "message-circle", title: "Голос", text: "Алиса и Маруся из коробки." },
      {
        icon: "home",
        title: "Без ремонта",
        text: "Беспроводные выключатели клеятся на стену, штробить ничего не нужно.",
      },
      {
        icon: "calendar",
        title: "Расписание",
        text: "Свет включается к вашему приходу и выключается, когда все уснули.",
      },
    ],
  },
});
