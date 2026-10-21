// Булочная Терехова as a full site (grill-11, round 4), assembled since V5-01 from the blocks of the direction
// «Мастерская»: the chosen first screen П5 «Один хлеб», sorts and prices, the oven hour, pre-order, shops, reviews.
import { BlockById } from "../../../v4/blocks/index.js";
import type { PhotoSlot } from "../photos.js";
import type { Photo } from "../still.js";
import { TerekhovLogo } from "./brand.js";
import { TEREKHOV as T } from "./data.js";

type Photos = Record<PhotoSlot, Photo>;
/** One section of a bar page: catalog block id, its content and variant. */
export type PageBlock = { id: string; content: unknown; variant?: string };
const CREDITED: PhotoSlot[] = ["bakery-loaf", "bakery-crumb", "bakery-peel", "bakery-shelves"];
const logo = <TerekhovLogo />;

/** Sections of the page in order: a catalog block id and its content. */
export function bakeryBlocks(photos: Photos): PageBlock[] {
  const header = { name: T.name, logo, nav: T.nav, phone: T.phone, phoneHref: T.phoneHref };
  return [
    {
      id: "masterskaya.hero",
      content: {
        header,
        photo: photos["bakery-loaf"],
        ...T.loaf,
        ctaHref: "#order",
        rating: T.rating,
        points: T.points,
      },
    },
    { id: "masterskaya.menu", content: { anchor: "sorts", ...T.sorts, photo: photos["bakery-crumb"] } },
    { id: "masterskaya.moment", content: { label: "Печь", ...T.oven, photo: photos["bakery-peel"] } },
    {
      id: "masterskaya.order",
      content: {
        anchor: "order",
        ...T.order,
        items: T.sorts.items,
        preset: "wheat",
        points: T.points,
        submit: "Оформить предзаказ",
      },
    },
    {
      id: "masterskaya.locations",
      content: {
        anchor: "points",
        title: "Две точки",
        lead: `${T.city}. Печь на Ильинской, хлеб на обеих полках к открытию.`,
        points: T.points,
        photo: photos["bakery-shelves"],
        cta: `Позвонить ${T.phone}`,
        ctaHref: T.phoneHref,
      },
    },
    {
      id: "masterskaya.reviews",
      content: { anchor: "reviews", title: "Отзывы", rating: T.rating, items: T.reviews },
    },
    {
      id: "masterskaya.footer",
      content: {
        name: T.name,
        logo,
        line: `${T.address}, ${T.city}, ${T.hours}`,
        credits: CREDITED.map((s) => photos[s].credit),
      },
    },
  ];
}

/** Site П5 «Один хлеб»: the first screen, then sorts and prices, oven, pre-order, shops and hours, reviews. */
export function BakeryLoaf({ photos }: { photos: Photos }) {
  return (
    <div className="overflow-x-clip bg-background text-foreground">
      {bakeryBlocks(photos).map((b) => (
        <BlockById key={b.id} {...b} />
      ))}
    </div>
  );
}
