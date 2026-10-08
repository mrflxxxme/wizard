// Header patterns (V3-08): eight compositions of the site header over one slot schema.
import { z } from "zod";
import { definePattern } from "../define.js";
import { brandSlot, line, linkSlot } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type BrandBlock from "./brand-block.js";
import type Centered from "./centered.js";
import type Classic from "./classic.js";
import type Floating from "./floating.js";
import type Masthead from "./masthead.js";
import type MenuFirst from "./menu-first.js";
import type SplitNav from "./split-nav.js";
import type UtilityBar from "./utility-bar.js";

/** Everything a header may show; each variant picks what it renders. */
export const headerSlots = z.object({
  brand: brandSlot,
  /** Main sections, ≤ 6 so the desktop menu keeps one line (catalog L16). */
  nav: z.array(linkSlot).max(6),
  action: linkSlot.optional(),
  /** A second action (for example «Войти» for the team). */
  secondary: linkSlot.optional(),
  /** Phone or messenger: tel:, https://. */
  phone: linkSlot.optional(),
  /** One line of practical facts from the brief: address, hours. */
  note: line(90).optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const HEADER_EXAMPLE = {
  brand: { name: "Мастерская «Обжиг»", href: "/" },
  nav: [
    { label: "Занятия", href: "#classes" },
    { label: "Расписание", href: "#schedule" },
    { label: "Цены", href: "#prices" },
    { label: "Мастера", href: "#team" },
    { label: "Контакты", href: "#contacts" },
  ],
  action: { label: "Записаться", href: "#form" },
  secondary: { label: "Войти", href: "/login" },
  phone: { label: "+7 900 000-00-00", href: "tel:+79000000000" },
  note: "Москва, Гончарная, 12 · ежедневно 10:00–21:00",
} satisfies z.input<typeof headerSlots>;

const at = import.meta.url;

export const HEADER_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Classic>()(at, "header", {
    variant: "classic",
    layout: "bar",
    title: "Классическая: название слева, меню в строку, кнопка справа",
    archetypes: ["*"],
    slots: headerSlots.pick({ brand: true, nav: true, action: true }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: HEADER_EXAMPLE,
  }),
  definePattern<typeof Centered>()(at, "header", {
    variant: "centered",
    layout: "centered",
    title: "По центру: название в середине, меню отдельной строкой под линией, сбоку адрес и кнопка",
    archetypes: ["*"],
    slots: headerSlots.pick({ brand: true, nav: true, action: true, note: true }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: HEADER_EXAMPLE,
  }),
  definePattern<typeof SplitNav>()(at, "header", {
    variant: "split-nav",
    layout: "split",
    title: "Меню разделено надвое вокруг названия по центру, кнопка контуром справа",
    archetypes: ["*"],
    slots: headerSlots.pick({ brand: true, nav: true, action: true }),
    needs: null,
    license: "own",
    origin: "own",
    example: HEADER_EXAMPLE,
  }),
  definePattern<typeof UtilityBar>()(at, "header", {
    variant: "utility-bar",
    layout: "stacked",
    title: "Верхняя полоса с адресом, часами и телефоном, под ней название, меню и кнопка",
    archetypes: ["*"],
    slots: headerSlots.pick({ brand: true, nav: true, action: true, phone: true, note: true }),
    needs: null,
    license: "own",
    origin: "own",
    example: HEADER_EXAMPLE,
  }),
  definePattern<typeof Floating>()(at, "header", {
    variant: "floating",
    layout: "panel",
    title: "Плавающая панель со скруглением и рамкой, отступает от краёв; меню и две кнопки внутри",
    archetypes: ["*"],
    slots: headerSlots.pick({ brand: true, nav: true, action: true, secondary: true }),
    needs: null,
    license: "MIT",
    origin: "shadcn-ui",
    example: HEADER_EXAMPLE,
  }),
  definePattern<typeof MenuFirst>()(at, "header", {
    variant: "menu-first",
    layout: "bar",
    title: "Только название, кнопка и «Меню»; меню раскрывается панелью с крупными ссылками",
    archetypes: ["*"],
    slots: headerSlots.pick({ brand: true, nav: true, action: true, note: true }),
    needs: null,
    license: "own",
    origin: "own",
    example: HEADER_EXAMPLE,
  }),
  definePattern<typeof Masthead>()(at, "header", {
    variant: "masthead",
    layout: "editorial",
    title: "Редакционная шапка: строка фактов, крупное название во всю ширину, меню между линейками",
    archetypes: ["*"],
    slots: headerSlots.pick({ nav: true, action: true, note: true }).extend({
      brand: headerSlots.shape.brand.omit({ logo: true }),
    }),
    needs: null,
    license: "own",
    origin: "own",
    example: HEADER_EXAMPLE,
  }),
  definePattern<typeof BrandBlock>()(at, "header", {
    variant: "brand-block",
    layout: "band",
    title: "Название в блоке фирменного цвета у левого края, меню, телефон и кнопка в строке справа",
    archetypes: ["*"],
    slots: headerSlots.pick({ brand: true, nav: true, action: true, phone: true }),
    needs: null,
    license: "own",
    origin: "own",
    example: HEADER_EXAMPLE,
  }),
];
