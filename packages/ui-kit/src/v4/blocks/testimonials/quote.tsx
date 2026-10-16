// One big quote: a single strong review set large, with the author and an optional photo. For the one review that
// sells best, between two dense sections.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { Reveal, useStill } from "../kit/motion.js";
import { imageSlot, line, para, variantSlot } from "../kit/slots.js";
import { type Image, Section } from "../kit/ui.js";

const VARIANTS = ["plain", "inverse"] as const;

export type TestimonialsQuoteProps = {
  quote: string;
  name: string;
  role?: string;
  photo?: Image;
  variant?: (typeof VARIANTS)[number];
  wzId?: string;
};

export default function TestimonialsQuote({
  quote,
  name,
  role,
  photo,
  variant = "plain",
  wzId,
}: TestimonialsQuoteProps) {
  const still = useStill();
  const inv = variant === "inverse";
  return (
    <Section
      block="TestimonialsQuote"
      wzId={wzId}
      className={inv ? "bg-inverse text-inverse-foreground" : "bg-background text-foreground"}
    >
      <Reveal still={still}>
        <figure className="mx-auto max-w-[56rem]">
          <Icon name="quote" className={`size-10 ${inv ? "opacity-60" : "text-primary"}`} />
          <blockquote className="mt-6 font-display text-h1 font-bold text-balance">{quote}</blockquote>
          <figcaption className="mt-10 flex items-center gap-4">
            {photo ? (
              <img
                src={photo.src}
                alt={photo.alt}
                loading="lazy"
                className="size-14 rounded-full bg-muted object-cover"
              />
            ) : null}
            <span>
              <span className="block text-body font-semibold">{name}</span>
              {role ? (
                <span className={`block text-small ${inv ? "opacity-80" : "text-muted-foreground"}`}>
                  {role}
                </span>
              ) : null}
            </span>
          </figcaption>
        </figure>
      </Reveal>
    </Section>
  );
}

export const block = defineBlock<typeof TestimonialsQuote>()({
  id: "testimonials-quote",
  kind: "testimonials",
  title: "Одна большая цитата",
  description:
    "Один сильный отзыв крупным шрифтом с автором и фото. Ставится между плотными секциями как пауза. «Контраст» — на тёмной полосе.",
  slots: z.object({
    quote: para(240),
    name: line(48),
    role: line(60).optional(),
    photo: imageSlot.optional(),
    variant: variantSlot(VARIANTS),
  }),
  variants: [
    { id: "plain", title: "На фоне страницы" },
    { id: "inverse", title: "На контрастной полосе" },
  ],
  effect: "light",
  origin: "own",
  example: {
    quote:
      "Мы боялись, что умный дом — это сложно. Теперь бабушка сама включает «вечер» голосом и просит такой же к себе.",
    name: "Наталья Белова",
    role: "квартира 96 м², Хамовники",
    photo: { src: "/_wizard/photos/example-face.webp", alt: "Портрет клиентки" },
  },
});
