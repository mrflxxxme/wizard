// Catalog cards: photo, optional badge, name, one line, price and the action; 2 columns on phones' landscape,
// 3–4 on desktop. The photo zooms a little on hover (desktop only via the hover media).
import { z } from "zod";
import { defineBlock } from "../kit/define.js";
import { Icon } from "../kit/icons.js";
import { imageSlot, line, linkSlot, para } from "../kit/slots.js";
import { focusRing, Heading, type Image, type Link, Section } from "../kit/ui.js";

export type CatalogCardsProps = {
  eyebrow?: string;
  title: string;
  lead?: string;
  items: { name: string; text?: string; price: string; image: Image; badge?: string; href: string }[];
  action?: Link;
  wzId?: string;
};

export default function CatalogCards({ eyebrow, title, lead, items, action, wzId }: CatalogCardsProps) {
  const cols = items.length % 4 === 0 ? "lg:grid-cols-4" : "lg:grid-cols-3";
  return (
    <Section block="CatalogCards" wzId={wzId}>
      <div className="flex flex-col justify-between gap-6 sm:flex-row sm:items-end">
        <Heading eyebrow={eyebrow} title={title} lead={lead} />
        {action ? (
          <a
            href={action.href}
            className={`inline-flex shrink-0 items-center gap-2 text-body font-semibold ${focusRing}`}
          >
            {action.label}
            <Icon name="arrow-right" className="size-4" />
          </a>
        ) : null}
      </div>
      <ul className={`mt-12 grid gap-x-4 gap-y-10 sm:grid-cols-2 ${cols}`}>
        {items.map((it) => (
          <li key={it.name}>
            <a href={it.href} className={`group block rounded-lg ${focusRing}`}>
              <div className="relative overflow-hidden rounded-lg bg-muted">
                <img
                  src={it.image.src}
                  alt={it.image.alt}
                  loading="lazy"
                  className="aspect-square w-full object-cover transition-transform duration-500 [@media(hover:hover)]:group-hover:scale-105"
                />
                {it.badge ? (
                  <span className="absolute top-3 left-3 rounded-control bg-background px-3 py-1 text-small font-semibold text-foreground">
                    {it.badge}
                  </span>
                ) : null}
              </div>
              <div className="mt-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="font-display text-h3 font-bold">{it.name}</h3>
                  {it.text ? <p className="mt-1 text-small text-muted-foreground">{it.text}</p> : null}
                </div>
                <p className="shrink-0 text-body font-semibold">{it.price}</p>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export const block = defineBlock<typeof CatalogCards>()({
  id: "catalog-cards",
  kind: "catalog",
  title: "Каталог карточками",
  description:
    "Карточки товаров или работ: квадратное фото, метка, название, строка описания и цена. Для магазинов, меню, каталогов мебели и букетов. Нужны фото клиента.",
  slots: z.object({
    eyebrow: line(48).optional(),
    title: line(80),
    lead: para(200).optional(),
    items: z
      .array(
        z.object({
          name: line(48),
          text: line(80).optional(),
          price: line(24),
          image: imageSlot,
          badge: line(20).optional(),
          href: linkSlot.shape.href,
        }),
      )
      .min(3)
      .max(8),
    action: linkSlot.optional(),
  }),
  variants: [{ id: "default", title: "Одна раскладка" }],
  effect: "none",
  origin: "own",
  example: {
    eyebrow: "Каталог",
    title: "Светильники, которые мы ставим чаще всего",
    items: [
      {
        name: "Трек «Линия»",
        text: "Магнитный, 48 В",
        price: "от 6 900 ₽",
        image: { src: "/_wizard/photos/example-1.webp", alt: "Чёрный трековый светильник на белом потолке" },
        badge: "Хит",
        href: "/catalog/track",
      },
      {
        name: "Бра «Шар»",
        text: "Опаловое стекло",
        price: "4 200 ₽",
        image: { src: "/_wizard/photos/example-2.webp", alt: "Настенный светильник-шар у зеркала" },
        href: "/catalog/ball",
      },
      {
        name: "Подвес «Капля»",
        text: "Латунь, тёплый свет",
        price: "11 500 ₽",
        image: { src: "/_wizard/photos/example-3.webp", alt: "Латунный подвес над обеденным столом" },
        href: "/catalog/drop",
      },
      {
        name: "Лента 2700K",
        text: "Для ниш и карнизов",
        price: "1 300 ₽/м",
        image: { src: "/_wizard/photos/example-4.webp", alt: "Подсветка ниши тёплой светодиодной лентой" },
        badge: "Новинка",
        href: "/catalog/strip",
      },
    ],
    action: { label: "Весь каталог", href: "/catalog" },
  },
});
