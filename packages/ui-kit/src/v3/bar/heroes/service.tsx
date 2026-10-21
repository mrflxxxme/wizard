// Бокс 14 as a full site (grill-11, round 4), assembled since V5-01 from the blocks of the direction «Ночной продукт»:
// the chosen first screen С5 «Опишите проблему», prices «от» for the car, booking, repair status, steps, reviews,
// the address.
import { BlockById } from "../../../v4/blocks/index.js";
import type { PhotoSlot } from "../photos.js";
import type { Photo } from "../still.js";
import { Box14Logo } from "./brand.js";
import { BOX14 as B } from "./data.js";

type Photos = Record<PhotoSlot, Photo>;
/** One section of a bar page: catalog block id, its content and variant. */
export type PageBlock = { id: string; content: unknown; variant?: string };
const CREDITED: PhotoSlot[] = ["service-mechanic", "service-under-car", "service-bay"];
const logo = <Box14Logo />;

/** Sections of the page in order: a catalog block id and its content. */
export function serviceBlocks(photos: Photos): PageBlock[] {
  const header = { name: B.name, logo, nav: B.nav, phone: B.phone, phoneHref: B.phoneHref };
  const rating = B.rating;
  return [
    {
      id: "nochnoy-produkt.hero",
      content: {
        header,
        photo: photos["service-mechanic"],
        title: B.ask.title,
        fieldLabel: "Опишите машину и проблему",
        placeholder: B.ask.placeholder,
        cta: B.ask.cta,
        lead: B.ask.lead,
        facts: [
          { value: rating.value, label: `в ${rating.source}` },
          { value: B.repairs, label: "ремонтов" },
          { value: "1 год", label: "гарантия" },
        ],
      },
    },
    {
      id: "nochnoy-produkt.prices",
      content: {
        anchor: "prices",
        ...B.prices,
        models: B.models,
        jobs: B.jobs,
        cta: "Записаться на время",
        ctaHref: "#book",
      },
    },
    {
      id: "nochnoy-produkt.booking",
      content: { anchor: "book", ...B.book, place: `${B.address}, бокс выдаём по номеру записи.` },
    },
    {
      id: "nochnoy-produkt.status",
      content: {
        anchor: "status",
        ...B.status,
        master: "Мастер Денис",
        chat: B.status.chat.map((m) => ({
          who: m.who,
          time: m.time,
          text: m.text,
          ...("photo" in m ? { photo: photos["service-under-car"] } : {}),
        })),
      },
    },
    { id: "nochnoy-produkt.steps", content: { title: "Как это работает", items: B.ask.steps } },
    {
      id: "nochnoy-produkt.reviews",
      content: { title: "Отзывы", rating, tally: `${B.repairs} ремонтов`, items: B.reviews },
    },
    {
      id: "nochnoy-produkt.contacts",
      content: {
        anchor: "contacts",
        address: B.address,
        hours: B.hours,
        photo: photos["service-bay"],
        cta: "Записаться",
        ctaHref: "#book",
        phone: B.phone,
        phoneHref: B.phoneHref,
      },
    },
    {
      id: "nochnoy-produkt.footer",
      content: {
        name: B.name,
        logo,
        warranty: "Гарантия 1 год",
        rating,
        address: B.address,
        credits: CREDITED.map((s) => photos[s].credit),
      },
    },
  ];
}

/** Site С5 «Опишите проблему»: the first screen, then prices for the car, booking, repair status, reviews, address. */
export function ServiceAsk({ photos }: { photos: Photos }) {
  return (
    <div className="overflow-x-clip bg-background text-foreground">
      {serviceBlocks(photos).map((b) => (
        <BlockById key={b.id} {...b} />
      ))}
    </div>
  );
}
