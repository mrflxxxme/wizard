// Numbers: 3–4 figures that count up once when scrolled into view (desktop), static on phones and reduced motion.
// Count-up idea after Magic UI «Number Ticker» (MIT, © Magic UI), rewritten with Motion's animate().
import { animate, useInView } from "motion/react";
import { useEffect, useRef } from "react";
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { useStill } from "../kit/motion.js";
import { line, variantSlot } from "../kit/slots.js";
import { Section } from "../kit/ui.js";

const VARIANTS = ["band", "plain"] as const;

export type StatsCountupProps = {
  title?: string;
  /** value: the figure as shown («120+», «4,9», «24/7»); its leading number counts up. */
  items: { value: string; label: string }[];
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

const NUM_RE = /^(\D*)(\d[\d\s]*)(?:([,.])(\d+))?(.*)$/;

function Figure({ value, still }: { value: string; still: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true, margin: "-15% 0px" });
  useEffect(() => {
    const m = NUM_RE.exec(value);
    const el = ref.current;
    if (still || !seen || !m || !el) return;
    const [, pre = "", int = "", sep, frac = "", post = ""] = m;
    const digits = frac.length;
    const target = Number(`${int.replace(/\s/g, "")}.${frac || 0}`);
    const fmt = new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    const ctl = animate(0, target, {
      duration: 1.4,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        const s = fmt.format(v);
        el.textContent = `${pre}${sep === "." ? s.replace(",", ".") : s}${post}`;
      },
      onComplete: () => {
        el.textContent = value;
      },
    });
    return () => ctl.stop();
  }, [seen, still, value]);
  return (
    <span ref={ref} className="tabular-nums">
      {value}
    </span>
  );
}

export default function StatsCountup({ title, items, variant = "band", wzId }: StatsCountupProps) {
  const still = useStill();
  const band = variant === "band";
  return (
    <Section
      block="StatsCountup"
      wzId={wzId}
      className={band ? "bg-inverse text-inverse-foreground" : "bg-background text-foreground"}
    >
      {title ? <h2 className="max-w-text font-display text-h2 font-bold text-balance">{title}</h2> : null}
      <dl
        className={`grid grid-cols-2 gap-x-6 gap-y-10 ${items.length === 3 ? "lg:grid-cols-3" : "lg:grid-cols-4"} ${title ? "mt-12" : ""}`}
      >
        {items.map((it) => (
          <div
            key={it.label}
            className={`border-l-2 pl-5 ${band ? "border-inverse-foreground/25" : "border-primary"}`}
          >
            <dd className="font-display text-hero leading-none font-bold">
              <Figure value={it.value} still={still} />
            </dd>
            <dt className={`mt-3 text-body ${band ? "opacity-80" : "text-muted-foreground"}`}>{it.label}</dt>
          </div>
        ))}
      </dl>
    </Section>
  );
}

export const block = defineBlock<typeof StatsCountup>()({
  id: "stats-countup",
  kind: "stats",
  title: "Цифры",
  description:
    "3–4 крупные цифры с подписями; на десктопе один раз досчитывают до значения при появлении. «Полоса» — на контрастном фоне, хороша между светлыми секциями. Только цифры из брифа.",
  slots: z.object({
    title: line(80).optional(),
    items: z
      .array(z.object({ value: line(10), label: line(60) }))
      .min(3)
      .max(4),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "band", title: "Контрастная полоса" },
    { id: "plain", title: "На фоне страницы" },
  ],
  effect: "light",
  origin: "magic-ui",
  example: {
    title: "Десять лет делаем свет в Москве и области",
    items: [
      { value: "120+", label: "квартир и домов сдано" },
      { value: "4,9", label: "средняя оценка на Картах" },
      { value: "3 года", label: "гарантии на работы" },
      { value: "24 ч", label: "на выезд по гарантии" },
    ],
  },
});
