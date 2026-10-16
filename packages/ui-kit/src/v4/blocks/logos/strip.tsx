// Trust strip: names of partners or clients as wordmarks (or their logos), static row; on desktop the «marquee»
// variant scrolls them slowly. Marquee idea after Magic UI «Marquee» (MIT, © Magic UI), rewritten in CSS + Motion.
import { domAnimation, LazyMotion, m } from "motion/react";
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { useStill } from "../kit/motion.js";
import { line, variantSlot } from "../kit/slots.js";
import { Section } from "../kit/ui.js";

const VARIANTS = ["row", "marquee"] as const;

export type LogosStripProps = {
  label?: string;
  names: string[];
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

function Names({ names, hidden }: { names: string[]; hidden?: boolean }) {
  return (
    <ul aria-hidden={hidden} className="flex shrink-0 items-center gap-12 pr-12">
      {names.map((n) => (
        <li key={n} className="font-display text-h3 font-bold whitespace-nowrap text-muted-foreground">
          {n}
        </li>
      ))}
    </ul>
  );
}

export default function LogosStrip({ label, names, variant = "row", wzId }: LogosStripProps) {
  const still = useStill();
  const moving = variant === "marquee" && !still;
  return (
    <Section
      block="LogosStrip"
      wzId={wzId}
      inner="py-12 md:py-16"
      className="border-y border-border bg-background text-foreground"
    >
      {label ? <p className="text-center text-small text-muted-foreground">{label}</p> : null}
      {moving ? (
        <LazyMotion features={domAnimation}>
          <div className="mt-8 flex overflow-hidden mask-[linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]">
            <m.div
              className="flex"
              animate={{ x: ["0%", "-50%"] }}
              transition={{ duration: 30, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
            >
              <Names names={names} />
              <Names names={names} hidden />
            </m.div>
          </div>
        </LazyMotion>
      ) : (
        <ul className="mt-8 flex flex-wrap items-center justify-center gap-x-12 gap-y-6">
          {names.map((n) => (
            <li key={n} className="font-display text-h3 font-bold text-muted-foreground">
              {n}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export const block = defineBlock<typeof LogosStrip>()({
  id: "logos-strip",
  kind: "logos",
  title: "Полоса доверия",
  description:
    "Названия партнёров, клиентов или СМИ строкой-словесными знаками. «Бегущая строка» — медленная прокрутка на десктопе. Только реальные имена из брифа.",
  slots: z.object({
    label: line(80).optional(),
    names: z.array(line(30)).min(3).max(10),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "row", title: "Строка" },
    { id: "marquee", title: "Бегущая строка" },
  ],
  effect: "light",
  origin: "magic-ui",
  example: {
    label: "Работаем с оборудованием проверенных производителей",
    names: ["Ниагара", "Свет-Про", "Гранит", "Altum", "Вектор", "Норд"],
  },
});
