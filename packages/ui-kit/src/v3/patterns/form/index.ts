// Form patterns (V3-08, needs lead | booking): lead forms over useLeadForm and booking forms over useBooking
// (@wizard/ui-kit/v3/headless, C4). The visual is the pattern, the logic stays in the module: fields come from the
// role's RoleSpec, validation, server errors, the personal data consent (G2-PII-04), free times and «sent» from the
// hook. Labels are always visible, errors sit under their field (aria-describedby), focus goes to the first error or to
// the answer.
import { z } from "zod";
import { definePattern } from "../define.js";
import { imageSlot, line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type BookingCompact from "./booking-compact.js";
import type BookingGrid from "./booking-grid.js";
import type BookingSteps from "./booking-steps.js";
import type BookingStrip from "./booking-strip.js";
import type Centered from "./centered.js";
import type Editorial from "./editorial.js";
import type Inline from "./inline.js";
import type PhotoCard from "./photo-card.js";
import type Split from "./split.js";
import type Stepper from "./stepper.js";

/** Entity and field names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности или поля латиницей");
const minutes = z.number().int().min(0).max(1440);

/** Texts of the answer after a successful write. */
const sentSlot = z.object({ title: line(80), text: para(220).optional() });

/** The texts every form has: heading, the action (a verb and an object, catalog K09), the answer. */
const common = {
  title: line(80),
  text: para(260).optional(),
  submit: line(40),
  sent: sentSlot,
  again: line(40).optional(),
  note: line(160).optional(),
};

/** Everything a lead form may show; each variant picks what it renders. */
export const leadSlots = z.object({
  /** Entity the form creates (publicFront.actions[].entity of useLeadForm). */
  entity: ident.optional(),
  /** Field names in order (default: what the role may fill); ≤ 4 visible fields keep a lead form short (catalog D1). */
  fields: z.array(ident).min(1).max(8).optional(),
  ...common,
  image: imageSlot.optional(),
  /** What happens after the request, 2–4 real steps. */
  points: z.array(line(120)).min(2).max(4).optional(),
  /** A direct channel instead of the form: phone or messenger. */
  contact: linkSlot.optional(),
  /** Names of the two steps of the stepper: the request and the contacts. */
  steps: z.array(line(40)).length(2).optional(),
});

/** The module's booking configuration: publicFront.actions[].booking of the backend compile (BookingFrontConfig). */
export const bookingBindingSlot = z.object({
  schedule: z.object({
    tz: z.string().min(1).max(64),
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    start: minutes,
    end: minutes,
    step: z.number().int().min(5).max(720),
    breakStart: minutes.nullable(),
    breakEnd: minutes.nullable(),
    capacity: z.number().int().min(1).max(500),
    leadMinutes: z.number().int().min(0).max(10_080),
  }),
  serviceEntity: ident,
  durationField: ident.optional(),
  specialistEntity: ident.optional(),
  busyFn: ident.optional(),
  packageCheckFn: ident.optional(),
});

/** Everything a booking form may show. */
export const bookingSlots = z.object({
  /** Entity of the bookings (publicFront.actions[].entity of useBooking). */
  entity: ident.optional(),
  booking: bookingBindingSlot,
  /** Contact field names (default: what the role may fill). */
  fields: z.array(ident).min(1).max(8).optional(),
  /** Service field with the price (default price). */
  priceField: ident.optional(),
  /** Working days offered from today (default 14). */
  daysAhead: z.number().int().min(1).max(60).optional(),
  ...common,
  /** A direct channel when online booking cannot start. */
  contact: linkSlot.optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const LEAD_EXAMPLE = {
  entity: "lead",
  fields: ["name", "phone", "comment"],
  title: "Оставьте заявку на пробное занятие",
  text: "Мастер позвонит, ответит на вопросы и подберёт удобное время. Глину и фартук дадим на месте.",
  submit: "Отправить заявку",
  sent: {
    title: "Заявка отправлена",
    text: "Мастер свяжется с вами в рабочие часы, чтобы подобрать время занятия.",
  },
  again: "Отправить ещё одну заявку",
  note: "Отвечаем со вторника по субботу, с десяти до восьми",
  image: {
    src: "/_wizard/photos/example-studio.webp",
    alt: "Светлый зал мастерской с гончарными кругами у окна",
  },
  points: [
    "Мастер перезвонит и расскажет, как проходит занятие",
    "Вместе выберете день и время в расписании",
    "Приходите за десять минут до начала",
  ],
  contact: { label: "+7 900 000-00-00", href: "tel:+79000000000" },
  steps: ["Что вас интересует", "Как с вами связаться"],
} satisfies z.input<typeof leadSlots>;

/** Preview content of the booking forms (D49): the schedule of the example «Запись по слотам». */
export const BOOKING_EXAMPLE = {
  entity: "booking",
  booking: {
    schedule: {
      tz: "Europe/Moscow",
      days: [1, 2, 3, 4, 5, 6],
      start: 600,
      end: 1200,
      step: 60,
      breakStart: 840,
      breakEnd: 900,
      capacity: 1,
      leadMinutes: 60,
    },
    serviceEntity: "service",
    durationField: "duration_min",
  },
  title: "Запишитесь на занятие",
  text: "Выберите занятие, день и свободное время. Перенести запись можно не позже чем за сутки.",
  submit: "Записаться",
  sent: {
    title: "Вы записаны",
    text: "Ждём вас в мастерской. Если планы изменятся, позвоните — перенесём запись.",
  },
  again: "Записаться ещё раз",
  contact: { label: "+7 900 000-00-00", href: "tel:+79000000000" },
} satisfies z.input<typeof bookingSlots>;

const at = import.meta.url;
const lead = leadSlots.pick({
  entity: true,
  fields: true,
  title: true,
  text: true,
  submit: true,
  sent: true,
  again: true,
  note: true,
});
const booking = bookingSlots;

export const FORM_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Inline>()(at, "form", {
    variant: "inline",
    layout: "bar",
    title: "Короткая форма в строку: поля и кнопка в один ряд, согласие под ними; на телефоне — столбиком",
    archetypes: ["*"],
    slots: lead,
    needs: "lead",
    license: "own",
    origin: "own",
    example: { ...LEAD_EXAMPLE, fields: ["name", "phone"] },
  }),
  definePattern<typeof Split>()(at, "form", {
    variant: "split",
    layout: "split",
    title: "Сплит: слева оффер, шаги после заявки и прямой контакт, справа форма в карточке",
    archetypes: ["*"],
    slots: lead.extend({ points: leadSlots.shape.points, contact: linkSlot.optional() }),
    needs: "lead",
    license: "MIT",
    origin: "hyperui",
    example: LEAD_EXAMPLE,
  }),
  definePattern<typeof PhotoCard>()(at, "form", {
    variant: "photo-card",
    layout: "full-bleed",
    title: "Карточка с формой на фото во всю секцию; на телефоне фото сверху, карточка заходит на него",
    archetypes: ["*"],
    slots: lead.extend({ image: imageSlot }),
    needs: "lead",
    license: "own",
    origin: "own",
    example: { ...LEAD_EXAMPLE, fields: ["name", "phone", "preferred_time"] },
  }),
  definePattern<typeof Stepper>()(at, "form", {
    variant: "stepper",
    layout: "panel",
    title: "Тонированная панель с двумя шагами: сначала запрос, затем контакты с согласием",
    archetypes: ["*"],
    slots: lead.extend({ steps: leadSlots.shape.steps }),
    needs: "lead",
    license: "own",
    origin: "own",
    example: { ...LEAD_EXAMPLE, fields: ["service", "preferred_time", "comment", "name", "phone"] },
  }),
  definePattern<typeof Centered>()(at, "form", {
    variant: "centered",
    layout: "centered",
    title:
      "Узкая колонка по центру тонированной полосы: заголовок, поля, кнопка во всю ширину, прямой контакт",
    archetypes: ["*"],
    slots: lead.extend({ contact: linkSlot.optional() }),
    needs: "lead",
    license: "MIT",
    origin: "shadcn-ui",
    example: { ...LEAD_EXAMPLE, fields: ["name", "phone", "email"] },
  }),
  definePattern<typeof Editorial>()(at, "form", {
    variant: "editorial",
    layout: "editorial",
    title:
      "Типографская: крупный заголовок под линейкой, поля в две колонки, согласие и кнопка в одной строке",
    archetypes: ["*"],
    slots: lead,
    needs: "lead",
    license: "own",
    origin: "own",
    example: { ...LEAD_EXAMPLE, fields: ["name", "phone", "email", "comment"] },
  }),
  definePattern<typeof BookingGrid>()(at, "form", {
    variant: "booking-grid",
    layout: "grid",
    title:
      "Запись: услуги сеткой карточек выбора, под ними панель — день, сетка свободного времени и контакты",
    archetypes: ["*"],
    slots: booking,
    needs: "booking",
    license: "own",
    origin: "own",
    example: BOOKING_EXAMPLE,
  }),
  definePattern<typeof BookingStrip>()(at, "form", {
    variant: "booking-strip",
    layout: "band",
    title: "Запись на тонированной полосе: услуга списком, лента дней, время чипами, затем контакты",
    archetypes: ["*"],
    slots: booking,
    needs: "booking",
    license: "own",
    origin: "own",
    example: BOOKING_EXAMPLE,
  }),
  definePattern<typeof BookingSteps>()(at, "form", {
    variant: "booking-steps",
    layout: "stacked",
    title: "Запись по шагам в одной колонке: услуга, время, контакты; «Назад» и «Далее»",
    archetypes: ["*"],
    slots: booking,
    needs: "booking",
    license: "own",
    origin: "own",
    example: BOOKING_EXAMPLE,
  }),
  definePattern<typeof BookingCompact>()(at, "form", {
    variant: "booking-compact",
    layout: "asymmetric",
    title:
      "Компактная запись: списки услуги, специалиста и дня, время сеткой, справа сводка «Ваша запись» с контактами",
    archetypes: ["*"],
    slots: booking,
    needs: "booking",
    license: "own",
    origin: "own",
    example: {
      ...BOOKING_EXAMPLE,
      booking: { ...BOOKING_EXAMPLE.booking, specialistEntity: "specialist" },
    },
  }),
];
