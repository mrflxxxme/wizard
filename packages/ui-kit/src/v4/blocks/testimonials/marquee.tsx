// Reviews wall: cards with rating, text, name and source in two rows that drift in opposite directions on desktop;
// a static grid on phones and under reduced motion. Marquee idea after Magic UI «Marquee» (MIT, © Magic UI).
import { domAnimation, LazyMotion, m } from "motion/react";
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { useStill } from "../kit/motion.js";
import { line, para } from "../kit/slots.js";
import { Heading, Section } from "../kit/ui.js";

const STARS = ["s1", "s2", "s3", "s4", "s5"];

type Review = { text: string; name: string; source?: string; rating?: number };

export type TestimonialsMarqueeProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  reviews: Review[];
  wzId?: string;
};

function Card({ r, hidden }: { r: Review; hidden?: boolean }) {
  return (
    <figure
      aria-hidden={hidden}
      className="w-[22rem] max-w-full shrink-0 rounded-lg border border-border bg-card p-6 text-card-foreground"
    >
      {r.rating ? (
        <span className="flex text-primary" role="img" aria-label={`Оценка ${r.rating} из 5`}>
          {STARS.slice(0, r.rating).map((k) => (
            <Icon key={k} name="star" className="size-4 fill-current" />
          ))}
        </span>
      ) : null}
      <blockquote className="mt-4 text-body">{r.text}</blockquote>
      <figcaption className="mt-5 text-small">
        <span className="font-semibold">{r.name}</span>
        {r.source ? <span className="text-muted-foreground"> · {r.source}</span> : null}
      </figcaption>
    </figure>
  );
}

function Row({ items, reverse }: { items: Review[]; reverse?: boolean }) {
  return (
    <div className="flex overflow-hidden mask-[linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
      <m.div
        className="flex gap-4 pr-4"
        animate={{ x: reverse ? ["-50%", "0%"] : ["0%", "-50%"] }}
        transition={{ duration: 50, repeat: Number.POSITIVE_INFINITY, ease: "linear" }}
      >
        {items.map((r) => (
          <Card key={r.name} r={r} />
        ))}
        {items.map((r) => (
          <Card key={`${r.name}-copy`} r={r} hidden />
        ))}
      </m.div>
    </div>
  );
}

export default function TestimonialsMarquee({
  eyebrow,
  title,
  lead,
  reviews,
  wzId,
}: TestimonialsMarqueeProps) {
  const still = useStill();
  const half = Math.ceil(reviews.length / 2);
  return (
    <Section block="TestimonialsMarquee" wzId={wzId} className="bg-muted text-foreground">
      <Heading eyebrow={eyebrow} title={title} lead={lead} center />
      {still ? (
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {reviews.slice(0, 6).map((r) => (
            <Card key={r.name} r={r} />
          ))}
        </div>
      ) : (
        <LazyMotion features={domAnimation}>
          <div className="mt-12 grid gap-4">
            <Row items={reviews.slice(0, half)} />
            <Row items={reviews.slice(half)} reverse />
          </div>
        </LazyMotion>
      )}
    </Section>
  );
}

export const block = defineBlock<typeof TestimonialsMarquee>()({
  id: "testimonials-marquee",
  kind: "testimonials",
  title: "Стена отзывов",
  description:
    "Карточки отзывов с оценкой и источником; на десктопе два ряда медленно плывут навстречу. Когда отзывов много (6+). Только реальные отзывы клиента.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    reviews: z
      .array(
        z.object({
          text: para(280),
          name: line(40),
          source: line(40).optional(),
          rating: z.number().int().min(1).max(5).optional(),
        }),
      )
      .min(4)
      .max(12),
  }),
  variants: [{ id: "default", title: "Одна раскладка" }],
  effect: "light",
  origin: "magic-ui",
  example: {
    eyebrow: "Отзывы",
    title: "Что говорят те, у кого уже светло",
    reviews: [
      {
        text: "Сделали свет в трёшке за четыре дня. Прораб каждый вечер присылал фото, мусора не было вообще.",
        name: "Ольга",
        source: "Яндекс Карты",
        rating: 5,
      },
      {
        text: "Наконец-то нет тёмного угла в кухне. Сценарий «ужин» — лучшее, что с нами случилось в ремонте.",
        name: "Игорь и Маша",
        source: "Авито",
        rating: 5,
      },
      {
        text: "Смета совпала до рубля. Редкость, честно.",
        name: "Дмитрий",
        source: "Яндекс Карты",
        rating: 5,
      },
      {
        text: "Поставили беспроводные выключатели в съёмной квартире — хозяин даже не заметил, а нам удобно.",
        name: "Алина",
        source: "2ГИС",
        rating: 5,
      },
      {
        text: "Приехали по гарантии на следующий день, заменили блок питания без вопросов.",
        name: "Сергей",
        source: "Яндекс Карты",
        rating: 5,
      },
      {
        text: "Подсветка лестницы по датчику — дети больше не спотыкаются ночью.",
        name: "Екатерина",
        source: "2ГИС",
        rating: 4,
      },
    ],
  },
});
