// Footer patterns (V3-08): eight compositions over one slot schema; each shows the personal data operator and the
// policy (catalog D1 Footer, R02), requisites when the site takes payments.
import { z } from "zod";
import { definePattern } from "../define.js";
import { brandSlot, HREF_RE, line, linkSlot } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Centered from "./centered.js";
import type Columns from "./columns.js";
import type ContactFirst from "./contact-first.js";
import type CtaTop from "./cta-top.js";
import type LegalFull from "./legal-full.js";
import type Minimal from "./minimal.js";
import type Panels from "./panels.js";
import type Wordmark from "./wordmark.js";

const columnSlot = z.object({ title: line(40), links: z.array(linkSlot).min(1).max(6) });
const contactSlot = z.object({
  label: line(30),
  value: line(90),
  href: z.string().regex(HREF_RE).optional(),
});

/** Everything a footer may show; each variant picks what it renders. */
export const footerSlots = z.object({
  brand: brandSlot,
  tagline: line(140).optional(),
  columns: z.array(columnSlot).min(1).max(4).optional(),
  /** Phone first: variants that set one contact large take the first. */
  contacts: z.array(contactSlot).min(1).max(4).optional(),
  social: z.array(linkSlot).max(5).optional(),
  action: linkSlot.optional(),
  legal: z.object({
    /** The personal data operator: the owner's legal name (catalog R02). */
    operator: line(120),
    /** Requisites (ИНН, ОГРН/ОГРНИП) when the site takes payments. */
    details: line(160).optional(),
    policy: linkSlot,
    links: z.array(linkSlot).max(3).optional(),
  }),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const FOOTER_EXAMPLE = {
  brand: { name: "Мастерская «Обжиг»", href: "/" },
  tagline: "Гончарная мастерская для взрослых: занятия на круге, лепка руками и обжиг своих работ.",
  columns: [
    {
      title: "Занятия",
      links: [
        { label: "Пробное занятие", href: "#trial" },
        { label: "Курс на круге", href: "#course" },
        { label: "Лепка руками", href: "#handbuilding" },
      ],
    },
    {
      title: "Мастерская",
      links: [
        { label: "Мастера", href: "#team" },
        { label: "Расписание", href: "#schedule" },
        { label: "Цены", href: "#prices" },
      ],
    },
    {
      title: "Помощь",
      links: [
        { label: "Частые вопросы", href: "#faq" },
        { label: "Подарочные сертификаты", href: "/gift" },
        { label: "Источники фото", href: "/photos" },
      ],
    },
  ],
  contacts: [
    { label: "Телефон", value: "+7 900 000-00-00", href: "tel:+79000000000" },
    { label: "Почта", value: "hello@example.ru", href: "mailto:hello@example.ru" },
    { label: "Адрес", value: "Москва, Гончарная, 12, второй этаж" },
    { label: "Часы", value: "Ежедневно с 10:00 до 21:00" },
  ],
  social: [
    { label: "Telegram", href: "https://t.me/example" },
    { label: "ВКонтакте", href: "https://vk.com/example" },
  ],
  action: { label: "Записаться на занятие", href: "#form" },
  legal: {
    operator: "ИП Глинова Анна Сергеевна",
    details: "ИНН 770000000000, ОГРНИП 300000000000000",
    policy: { label: "Политика обработки персональных данных", href: "/privacy" },
    links: [{ label: "Договор оферты", href: "/offer" }],
  },
} satisfies z.input<typeof footerSlots>;

const at = import.meta.url;
const legal = footerSlots.pick({ brand: true, legal: true });
const columns = z.array(columnSlot).min(1).max(4);
const contacts = z.array(contactSlot).min(1).max(4);

export const FOOTER_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Columns>()(at, "footer", {
    variant: "columns",
    layout: "columns",
    title: "Название с описанием и соцсетями слева, колонки ссылок справа, юридическая строка под линией",
    archetypes: ["*"],
    slots: legal.extend({ tagline: line(140).optional(), columns, social: footerSlots.shape.social }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: FOOTER_EXAMPLE,
  }),
  definePattern<typeof Centered>()(at, "footer", {
    variant: "centered",
    layout: "centered",
    title: "По центру: название, все ссылки одной строкой с переносом, соцсети и юридические строки",
    archetypes: ["*"],
    slots: legal.extend({ tagline: line(140).optional(), columns, social: footerSlots.shape.social }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: FOOTER_EXAMPLE,
  }),
  definePattern<typeof ContactFirst>()(at, "footer", {
    variant: "contact-first",
    layout: "asymmetric",
    title: "Главный контакт крупно, остальные списком, ссылки компактно справа",
    archetypes: ["*"],
    slots: legal.extend({
      brand: brandSlot.omit({ logo: true }),
      contacts,
      columns: columns.optional(),
      action: linkSlot.optional(),
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: FOOTER_EXAMPLE,
  }),
  definePattern<typeof Wordmark>()(at, "footer", {
    variant: "wordmark",
    layout: "typographic",
    title: "Колонки и контакты сверху, название крупным словом во всю ширину внизу",
    archetypes: ["*"],
    slots: legal.extend({ brand: brandSlot.omit({ logo: true }), columns, contacts: contacts.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: FOOTER_EXAMPLE,
  }),
  definePattern<typeof CtaTop>()(at, "footer", {
    variant: "cta-top",
    layout: "band",
    title: "Подвал начинается полосой фирменного цвета с фразой и кнопкой, ниже колонки и контакты",
    archetypes: ["*"],
    slots: legal.extend({
      brand: brandSlot.omit({ logo: true }),
      tagline: line(140),
      action: linkSlot,
      columns,
      contacts: contacts.optional(),
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: FOOTER_EXAMPLE,
  }),
  definePattern<typeof Minimal>()(at, "footer", {
    variant: "minimal",
    layout: "bar",
    title: "Одна строка: название, оператор данных и ссылка на политику",
    archetypes: ["*"],
    slots: legal.extend({ brand: brandSlot.omit({ logo: true }) }),
    needs: null,
    license: "own",
    origin: "own",
    example: FOOTER_EXAMPLE,
  }),
  definePattern<typeof LegalFull>()(at, "footer", {
    variant: "legal-full",
    layout: "list",
    title: "Юридический блок списком: оператор данных, реквизиты, документы; контакты слева",
    archetypes: ["*"],
    slots: legal.extend({
      brand: brandSlot.omit({ logo: true }),
      tagline: line(140).optional(),
      contacts: contacts.optional(),
      columns: columns.optional(),
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: FOOTER_EXAMPLE,
  }),
  definePattern<typeof Panels>()(at, "footer", {
    variant: "panels",
    layout: "panel",
    title: "Две карточки на тонированном фоне: контакты с названием и колонки ссылок",
    archetypes: ["*"],
    slots: legal.extend({
      brand: brandSlot.omit({ logo: true }),
      tagline: line(140).optional(),
      contacts,
      columns,
      social: footerSlots.shape.social,
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: FOOTER_EXAMPLE,
  }),
];
