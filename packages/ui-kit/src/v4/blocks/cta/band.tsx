// Closing call to action: a contrasting band with a large line, one action and a contact; on desktop a thin light
// runs around the band's border. Border-light idea after Magic UI «Shine Border» (MIT, © Magic UI), rewritten in CSS.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { useStill } from "../kit/motion.js";
import { line, linkSlot, para, variantSlot } from "../kit/slots.js";
import { Grain, inverseBtn, type Link, Section } from "../kit/ui.js";

const VARIANTS = ["card", "full"] as const;

export type CtaBandProps = {
  title: string;
  lead?: string;
  action: Link;
  phone?: string;
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

const SHINE = {
  background:
    "conic-gradient(from var(--wz-a, 0deg), transparent 0 75%, color-mix(in oklab, var(--color-primary) 90%, white) 88%, transparent 100%)",
} as const;

export default function CtaBand({ title, lead, action, phone, variant = "card", wzId }: CtaBandProps) {
  const still = useStill();
  const card = variant === "card";
  const body = (
    <div
      className={`relative overflow-hidden bg-inverse text-inverse-foreground ${card ? "rounded-lg px-6 py-14 sm:px-14 lg:py-20" : "px-0 py-6"}`}
    >
      <Grain opacity={0.12} />
      <div
        aria-hidden="true"
        className="absolute -top-1/2 right-0 size-[36rem] rounded-full bg-primary/35 blur-3xl"
      />
      <div className="relative grid items-end gap-10 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <h2 className="font-display text-h1 font-bold text-balance">{title}</h2>
          {lead ? <p className="mt-5 max-w-text text-lead text-pretty opacity-85">{lead}</p> : null}
        </div>
        <div className="flex flex-col gap-4 lg:col-span-4 lg:items-end">
          <a href={action.href} className={inverseBtn}>
            {action.label}
            <Icon name="arrow-right" className="size-4" />
          </a>
          {phone ? (
            <a
              href={`tel:${phone.replace(/[^\d+]/g, "")}`}
              className="inline-flex items-center gap-2 text-body font-semibold"
            >
              <Icon name="phone" className="size-4" />
              {phone}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
  if (!card)
    return (
      <Section block="CtaBand" wzId={wzId} className="bg-inverse text-inverse-foreground">
        {body}
      </Section>
    );
  return (
    <Section block="CtaBand" wzId={wzId}>
      <div className="relative rounded-lg p-px">
        {still ? null : (
          <>
            <style>
              {
                "@property --wz-a{syntax:'<angle>';inherits:false;initial-value:0deg}@keyframes wz-shine{to{--wz-a:360deg}}"
              }
            </style>
            <span
              aria-hidden="true"
              className="absolute inset-0 animate-[wz-shine_6s_linear_infinite] rounded-lg"
              style={SHINE}
            />
          </>
        )}
        {body}
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof CtaBand>()({
  id: "cta-band",
  kind: "cta",
  title: "Финальный призыв",
  description:
    "Контрастная карточка с крупной фразой, одной кнопкой и телефоном; на десктопе по краю бежит тонкий свет. Ставится перед контактами или футером.",
  slots: z.object({
    title: line(90),
    lead: para(200).optional(),
    action: linkSlot,
    phone: line(24).optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "card", title: "Карточка со светом по краю" },
    { id: "full", title: "Полоса во всю ширину" },
  ],
  effect: "light",
  origin: "magic-ui",
  example: {
    title: "Приедем на замер в удобный день — бесплатно",
    lead: "Оставьте телефон: перезвоним за 15 минут в рабочее время и подберём время визита.",
    action: { label: "Записаться на замер", href: "#form" },
    phone: "+7 495 120-45-67",
  },
});
