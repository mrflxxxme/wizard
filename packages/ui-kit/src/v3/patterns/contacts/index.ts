// Contacts patterns (V3-08): nine compositions over one slot schema. The phone is a tel: link, the hours are always
// visible, the map is a link to Яндекс Карты (no third-party iframes or scripts: the runtime CSP and egress forbid
// them); a static map or a photo of the entrance may come from the system's storage (catalog D1 Contacts).
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type BigPhone from "./big-phone.js";
import type Branches from "./branches.js";
import type Cards from "./cards.js";
import type Centered from "./centered.js";
import type Columns from "./columns.js";
import type HoursFirst from "./hours-first.js";
import type InversePanel from "./inverse-panel.js";
import type MapSplit from "./map-split.js";
import type PhotoOverlay from "./photo-overlay.js";

/** A place on Яндекс Картах: the organisation or point page (short links /maps/-/… too). */
export const YANDEX_MAPS_RE = /^https:\/\/yandex\.(?:ru|com|by|kz|uz)\/maps\/[^\s"'<>]*$/;
const EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/;

const mapSlot = z.string().regex(YANDEX_MAPS_RE, "карта: ссылка на Яндекс Карты (https://yandex.ru/maps/…)");

/** A phone as people dial it, with the number for the tel: link. */
export const phoneSlot = z.object({
  /** «+7 900 000-00-00». */
  number: line(30),
  href: z.string().regex(/^tel:\+?[\d-]{5,20}$/, "телефон: tel:+7…"),
  /** Whose line it is: «запись на занятия», «администратор». */
  note: line(40).optional(),
});

/** Opening hours as the client writes them: «Будни» — «12:00–21:00», «Воскресенье» — «выходной». */
export const hoursSlot = z.object({ days: line(40), time: line(40) });

/** One place of a business with several. */
export const branchSlot = z.object({
  name: line(60),
  address: line(140),
  phone: phoneSlot.optional(),
  hours: line(90),
  map: mapSlot,
});

/** Everything a contacts section may show; each variant picks what it renders. */
export const contactsSlots = z.object({
  title: line(80),
  lead: para(240).optional(),
  address: z.object({
    text: line(140),
    /** How to get there: the metro, the entrance, parking. */
    note: para(260).optional(),
  }),
  map: mapSlot,
  phones: z.array(phoneSlot).min(1).max(3),
  /** Messengers and social pages: https links. */
  messengers: z.array(linkSlot).max(4).optional(),
  email: z.string().regex(EMAIL_RE, "почта: name@domain").max(80).optional(),
  hours: z.array(hoursSlot).min(1).max(7),
  /** A static map or a photo of the entrance from the system's storage (same origin). */
  image: imageSlot.optional(),
  action: linkSlot.optional(),
  branches: z.array(branchSlot).min(2).max(8).optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const CONTACTS_EXAMPLE = {
  title: "Как нас найти",
  lead: "Мастерская во дворе, вход через арку со стороны Гончарной улицы. Перед первым занятием позвоните, встретим у ворот.",
  address: {
    text: "Москва, Гончарная улица, 12, строение 3, второй этаж",
    note: "От метро «Таганская» восемь минут пешком. Во дворе можно оставить машину на час.",
  },
  map: "https://yandex.ru/maps/org/example/",
  phones: [
    { number: "+7 900 000-00-00", href: "tel:+79000000000", note: "запись на занятия" },
    { number: "+7 900 000-00-01", href: "tel:+79000000001", note: "сертификаты и группы" },
  ],
  messengers: [
    { label: "Telegram", href: "https://t.me/example" },
    { label: "ВКонтакте", href: "https://vk.com/example" },
  ],
  email: "hello@example.ru",
  hours: [
    { days: "Будни", time: "12:00–21:00" },
    { days: "Суббота", time: "10:00–20:00" },
    { days: "Воскресенье", time: "выходной" },
  ],
  image: {
    src: "/_wizard/photos/example-map.webp",
    alt: "Схема проезда от метро «Таганская» к дому 12 на Гончарной улице",
  },
  action: { label: "Записаться на занятие", href: "#form" },
  branches: [
    {
      name: "Мастерская на Гончарной",
      address: "Москва, Гончарная улица, 12, строение 3",
      phone: { number: "+7 900 000-00-00", href: "tel:+79000000000" },
      hours: "Будни 12:00–21:00, суббота 10:00–20:00",
      map: "https://yandex.ru/maps/org/example/",
    },
    {
      name: "Мастерская на Соколе",
      address: "Москва, Ленинградский проспект, 74, вход со двора",
      phone: { number: "+7 900 000-00-02", href: "tel:+79000000002" },
      hours: "Ежедневно 11:00–21:00",
      map: "https://yandex.ru/maps/org/example-2/",
    },
    {
      name: "Детская студия в Хамовниках",
      address: "Москва, Плющиха, 31, первый этаж",
      hours: "Суббота и воскресенье 10:00–18:00",
      map: "https://yandex.ru/maps/org/example-3/",
    },
  ],
} satisfies z.input<typeof contactsSlots>;

const at = import.meta.url;
const base = contactsSlots.pick({
  title: true,
  lead: true,
  address: true,
  map: true,
  phones: true,
  messengers: true,
  email: true,
  hours: true,
});

/**
 * The contacts the owner gave (V3-18): a phone, an e-mail or an address with its map link — the hours and the rest
 * when he gave them. The variants that lay each part out on its own (centered, cards) take it.
 */
const partial = base
  .partial({ address: true, map: true, phones: true, hours: true })
  .refine((c) => !!(c.address || c.phones?.length || c.email), "контакты: телефон, почта или адрес");

export const CONTACTS_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof MapSplit>()(at, "contacts", {
    variant: "map-split",
    layout: "split",
    title:
      "Схема проезда или фото входа на половину со ссылкой на Яндекс Карты, рядом адрес, телефоны и часы",
    archetypes: ["*"],
    slots: base.extend({ image: imageSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: CONTACTS_EXAMPLE,
  }),
  definePattern<typeof Cards>()(at, "contacts", {
    variant: "cards",
    layout: "card",
    title: "Четыре карточки разной ширины: адрес с картой, телефоны, часы работы, мессенджеры",
    archetypes: ["*"],
    slots: partial,
    needs: null,
    license: "own",
    origin: "own",
    example: CONTACTS_EXAMPLE,
  }),
  definePattern<typeof BigPhone>()(at, "contacts", {
    variant: "big-phone",
    layout: "typographic",
    title: "Телефон крупным кеглем как главный элемент, под линейкой адрес, часы и мессенджеры в три колонки",
    archetypes: ["*"],
    slots: base,
    needs: null,
    license: "own",
    origin: "own",
    example: CONTACTS_EXAMPLE,
  }),
  definePattern<typeof InversePanel>()(at, "contacts", {
    variant: "inverse-panel",
    layout: "panel",
    title: "Контрастная панель-справка: строки «что — где» между линейками и кнопка карты",
    archetypes: ["*"],
    slots: base.extend({ action: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: CONTACTS_EXAMPLE,
  }),
  definePattern<typeof Columns>()(at, "contacts", {
    variant: "columns",
    layout: "columns",
    title: "Полоса из четырёх колонок между вертикальными линейками: адрес, телефон, часы, написать",
    archetypes: ["*"],
    slots: base,
    needs: null,
    license: "own",
    origin: "own",
    example: CONTACTS_EXAMPLE,
  }),
  definePattern<typeof Branches>()(at, "contacts", {
    variant: "branches",
    layout: "list",
    title: "Несколько адресов списком: название, адрес, часы, телефон и карта у каждого",
    archetypes: ["*"],
    slots: contactsSlots
      .pick({ title: true, lead: true })
      .extend({ branches: z.array(branchSlot).min(2).max(8) }),
    needs: null,
    license: "own",
    origin: "own",
    example: CONTACTS_EXAMPLE,
  }),
  definePattern<typeof PhotoOverlay>()(at, "contacts", {
    variant: "photo-overlay",
    layout: "full-bleed",
    title: "Фото входа или фасада на всю ширину, карточка с адресом, часами и телефоном поверх",
    archetypes: ["*"],
    slots: base.extend({ image: imageSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: {
      ...CONTACTS_EXAMPLE,
      image: {
        src: "/_wizard/photos/example-entrance.webp",
        alt: "Арка во двор дома 12 на Гончарной улице и вывеска мастерской",
      },
    },
  }),
  definePattern<typeof Centered>()(at, "contacts", {
    variant: "centered",
    layout: "centered",
    title: "Всё по центральной оси: адрес крупно, телефоны, часы строкой, мессенджеры и карта",
    archetypes: ["*"],
    slots: partial,
    needs: null,
    license: "own",
    origin: "own",
    example: CONTACTS_EXAMPLE,
  }),
  definePattern<typeof HoursFirst>()(at, "contacts", {
    variant: "hours-first",
    layout: "asymmetric",
    title: "Расписание по дням крупной таблицей справа, адрес, телефоны и запись слева",
    archetypes: ["*"],
    slots: base.extend({ action: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: CONTACTS_EXAMPLE,
  }),
];
