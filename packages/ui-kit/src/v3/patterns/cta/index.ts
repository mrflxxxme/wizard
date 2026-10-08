// Call to action patterns (V3-08): eight compositions over one slot schema; one wording per intent (catalog D1 CTA).
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type Band from "./band.js";
import type Card from "./card.js";
import type Centered from "./centered.js";
import type InversePanel from "./inverse-panel.js";
import type PhotoOverlay from "./photo-overlay.js";
import type SplitImage from "./split-image.js";
import type Steps from "./steps.js";
import type Typographic from "./typographic.js";

/** Everything a call to action may show; each variant picks what it renders. */
export const ctaSlots = z.object({
  title: line(80),
  text: para(220).optional(),
  /** The one action: a verb and an object (catalog K09). */
  action: linkSlot,
  secondary: linkSlot.optional(),
  /** A direct channel instead of the form: phone or messenger. */
  contact: linkSlot.optional(),
  image: imageSlot.optional(),
  /** Real order of getting started, 2–4 steps. */
  steps: z.array(line(90)).min(2).max(4).optional(),
  note: line(120).optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const CTA_EXAMPLE = {
  title: "Приходите на пробное занятие в субботу",
  text: "Возьмите удобную одежду, фартук и глину дадим на месте. Мастер покажет всё с самого начала.",
  action: { label: "Выбрать время", href: "#form" },
  secondary: { label: "Задать вопрос в Telegram", href: "https://t.me/example" },
  contact: { label: "+7 900 000-00-00", href: "tel:+79000000000" },
  image: {
    src: "/_wizard/photos/example-studio.webp",
    alt: "Светлый зал мастерской с гончарными кругами у окна",
  },
  steps: [
    "Выберите удобное время в расписании",
    "Оплатите занятие онлайн или на месте",
    "Приходите за десять минут до начала",
  ],
  note: "Перенести запись можно не позже чем за сутки",
} satisfies z.input<typeof ctaSlots>;

const at = import.meta.url;
const base = ctaSlots.pick({ title: true, text: true, action: true });

export const CTA_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Band>()(at, "cta", {
    variant: "band",
    layout: "band",
    title: "Полоса фирменного цвета во всю ширину: текст слева, кнопки справа",
    archetypes: ["*"],
    slots: base.extend({ secondary: linkSlot.optional() }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: CTA_EXAMPLE,
  }),
  definePattern<typeof Centered>()(at, "cta", {
    variant: "centered",
    layout: "centered",
    title: "По центру на тонированном фоне: заголовок, текст, кнопки и примечание по оси",
    archetypes: ["*"],
    slots: base.extend({ secondary: linkSlot.optional(), note: line(120).optional() }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: CTA_EXAMPLE,
  }),
  definePattern<typeof SplitImage>()(at, "cta", {
    variant: "split-image",
    layout: "split",
    title: "Блок в рамке: фото на половину, текст и кнопки на другой половине",
    archetypes: ["*"],
    slots: base.extend({ secondary: linkSlot.optional(), note: line(120).optional(), image: imageSlot }),
    needs: null,
    license: "MIT",
    origin: "hyperui",
    example: CTA_EXAMPLE,
  }),
  definePattern<typeof Card>()(at, "cta", {
    variant: "card",
    layout: "card",
    title: "Карточка на странице: текст слева, кнопки у правого нижнего края",
    archetypes: ["*"],
    slots: base.extend({ secondary: linkSlot.optional(), note: line(120).optional() }),
    needs: null,
    license: "MIT",
    origin: "shadcn-ui",
    example: CTA_EXAMPLE,
  }),
  definePattern<typeof InversePanel>()(at, "cta", {
    variant: "inverse-panel",
    layout: "panel",
    title: "Контрастная панель: заголовок-плакат слева, справа текст, кнопка и крупный телефон",
    archetypes: ["*"],
    slots: base.extend({ contact: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: CTA_EXAMPLE,
  }),
  definePattern<typeof Typographic>()(at, "cta", {
    variant: "typographic",
    layout: "typographic",
    title: "Типографский: короткий вопрос и само действие крупной ссылкой со стрелкой",
    archetypes: ["*"],
    slots: base.extend({ secondary: linkSlot.optional() }),
    needs: null,
    license: "own",
    origin: "own",
    example: CTA_EXAMPLE,
  }),
  definePattern<typeof Steps>()(at, "cta", {
    variant: "steps",
    layout: "list",
    title: "Текст и кнопка слева, справа нумерованные шаги, как начать",
    archetypes: ["*"],
    slots: base.extend({ note: line(120).optional(), steps: z.array(line(90)).min(2).max(4) }),
    needs: null,
    license: "own",
    origin: "own",
    example: CTA_EXAMPLE,
  }),
  definePattern<typeof PhotoOverlay>()(at, "cta", {
    variant: "photo-overlay",
    layout: "full-bleed",
    title: "Фото на всю секцию, по центру затемнённая карточка с текстом, кнопкой и телефоном",
    archetypes: ["*"],
    slots: base.extend({ contact: linkSlot.optional(), image: imageSlot }),
    needs: null,
    license: "own",
    origin: "own",
    example: CTA_EXAMPLE,
  }),
];
