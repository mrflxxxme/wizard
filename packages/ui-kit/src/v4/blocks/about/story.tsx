// About as a short story: a large statement, two paragraphs, a signature and facts; a photo beside it.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Reveal, useStill } from "../kit/motion.js";
import { imageSlot, line, para, variantSlot } from "../kit/slots.js";
import { Eyebrow, type Image, Section } from "../kit/ui.js";

const VARIANTS = ["photo-left", "no-photo"] as const;

export type AboutStoryProps = {
  eyebrow?: string;
  statement: string;
  paragraphs: string[];
  signature?: { name: string; role: string };
  facts?: { value: string; label: string }[];
  image?: Image;
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

export default function AboutStory({
  eyebrow,
  statement,
  paragraphs,
  signature,
  facts,
  image,
  variant = "photo-left",
  wzId,
}: AboutStoryProps) {
  const still = useStill();
  const photo = variant === "photo-left" && image;
  return (
    <Section block="AboutStory" wzId={wzId}>
      <div className={`grid gap-12 ${photo ? "lg:grid-cols-12 lg:gap-16" : ""}`}>
        {photo ? (
          <Reveal still={still} className="lg:col-span-5">
            <img
              src={image.src}
              alt={image.alt}
              loading="lazy"
              className="aspect-4/5 w-full rounded-lg bg-muted object-cover"
            />
          </Reveal>
        ) : null}
        <div className={photo ? "lg:col-span-7 lg:pt-8" : "mx-auto max-w-[54rem]"}>
          {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
          <p className="mt-4 font-display text-h1 font-bold text-balance">{statement}</p>
          <div className="mt-8 grid max-w-text gap-4 text-body text-muted-foreground">
            {paragraphs.map((t) => (
              <p key={t}>{t}</p>
            ))}
          </div>
          {signature ? (
            <p className="mt-8 text-body">
              <span className="font-semibold">{signature.name}</span>
              <span className="text-muted-foreground"> — {signature.role}</span>
            </p>
          ) : null}
          {facts?.length ? (
            <dl className="mt-12 grid grid-cols-2 gap-6 border-t border-border pt-8 sm:grid-cols-3">
              {facts.map((f) => (
                <div key={f.label}>
                  <dt className="sr-only">{f.label}</dt>
                  <dd className="font-display text-h2 font-bold">{f.value}</dd>
                  <dd className="mt-1 text-small text-muted-foreground">{f.label}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

export const block = defineBlock<typeof AboutStory>()({
  id: "about-story",
  kind: "about",
  title: "О нас — история",
  description:
    "Крупное утверждение, два абзаца истории, подпись основателя и 2–3 факта; рядом фото. Для семейного бизнеса, мастеров и студий с лицом.",
  slots: z.object({
    eyebrow: line(48).optional(),
    statement: line(140),
    paragraphs: z.array(para(360)).min(1).max(3),
    signature: z.object({ name: line(48), role: line(60) }).optional(),
    facts: z
      .array(z.object({ value: line(10), label: line(40) }))
      .max(3)
      .optional(),
    image: imageSlot.optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "photo-left", title: "С фото слева" },
    { id: "no-photo", title: "Только текст по центру" },
  ],
  effect: "light",
  origin: "own",
  example: {
    eyebrow: "О студии",
    statement: "Мы начинали как два электрика, которым надоело, что свет делают последним и наспех.",
    paragraphs: [
      "С 2014 года мы проектируем свет до того, как в квартиру зайдут штукатуры. Так появляются розетки там, где они нужны, и подсветка, которая не слепит.",
      "Сегодня нас двенадцать: проектировщики, монтажники и инженер по умному дому. Каждый объект ведёт один прораб от замера до сдачи.",
    ],
    signature: { name: "Андрей Котов", role: "основатель «Люмена»" },
    facts: [
      { value: "10 лет", label: "на рынке" },
      { value: "12", label: "человек в команде" },
      { value: "120+", label: "объектов" },
    ],
    image: { src: "/_wizard/photos/example-team.webp", alt: "Основатель студии у щита с автоматами" },
  },
});
