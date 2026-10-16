// Works gallery: 5–7 photos in a mosaic (one tall, one wide) with captions on hover/focus; on phones a 2-column grid
// with captions under each photo.
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { imageSlot, line, para } from "../kit/slots.js";
import { Heading, type Image, Section } from "../kit/ui.js";

export type GalleryMosaicProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  photos: (Image & { caption?: string })[];
  wzId?: string;
};

const CELLS = ["lg:col-span-2 lg:row-span-2", "", "lg:row-span-2", "", "lg:col-span-2", "", ""];

export default function GalleryMosaic({ eyebrow, title, lead, photos, wzId }: GalleryMosaicProps) {
  return (
    <Section block="GalleryMosaic" wzId={wzId}>
      <Heading eyebrow={eyebrow} title={title} lead={lead} />
      <ul className="mt-12 grid auto-rows-[11rem] grid-cols-2 gap-3 lg:auto-rows-[15rem] lg:grid-cols-4">
        {photos.map((ph, i) => (
          <li key={ph.src} className={`group relative overflow-hidden rounded-lg bg-muted ${CELLS[i] ?? ""}`}>
            <img
              src={ph.src}
              alt={ph.alt}
              loading="lazy"
              className="size-full object-cover transition-transform duration-700 [@media(hover:hover)]:group-hover:scale-105"
            />
            {ph.caption ? (
              <p className="absolute inset-x-0 bottom-0 bg-linear-to-t from-scrim to-transparent p-4 pt-10 text-small font-semibold text-scrim-foreground lg:translate-y-full lg:transition-transform lg:duration-300 lg:group-hover:translate-y-0 lg:group-focus-within:translate-y-0">
                {ph.caption}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export const block = defineBlock<typeof GalleryMosaic>()({
  id: "gallery-mosaic",
  kind: "gallery",
  title: "Галерея работ мозаикой",
  description:
    "5–7 фото работ в мозаике с подписями по наведению; на телефоне — сетка в две колонки с подписями. Для ремонта, интерьеров, кондитерских, салонов. Нужны фото клиента.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    photos: z
      .array(imageSlot.extend({ caption: line(60).optional() }))
      .min(5)
      .max(7),
  }),
  variants: [{ id: "default", title: "Одна раскладка" }],
  effect: "none",
  origin: "own",
  example: {
    eyebrow: "Работы",
    title: "Последние объекты",
    photos: [
      {
        src: "/_wizard/photos/example-g1.webp",
        alt: "Гостиная с подсветкой потолка",
        caption: "Квартира 96 м², Хамовники",
      },
      {
        src: "/_wizard/photos/example-g2.webp",
        alt: "Кухня с трековым светом",
        caption: "Кухня-гостиная, Сокол",
      },
      {
        src: "/_wizard/photos/example-g3.webp",
        alt: "Лестница с подсветкой ступеней",
        caption: "Дом, Истра",
      },
      { src: "/_wizard/photos/example-g4.webp", alt: "Спальня с бра у кровати", caption: "Спальня, Митино" },
      {
        src: "/_wizard/photos/example-g5.webp",
        alt: "Ванная с подсветкой зеркала",
        caption: "Ванная, Арбат",
      },
      { src: "/_wizard/photos/example-g6.webp", alt: "Фасад дома вечером", caption: "Фасад, Новая Рига" },
    ],
  },
});
