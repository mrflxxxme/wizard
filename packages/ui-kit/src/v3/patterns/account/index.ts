// Client cabinet patterns (V3-18, needs content): the page /me of «Кабинет посетителя» on the client's design system —
// a section per kind of the visitor's own records («Мои записи», «Мои заявки», «Мои абонементы»), the rows the server
// gives him by the data modules' rowFilter (useMyRecords, C4), «Отменить» where the role may cancel, sign-in for a
// guest. The heading is the page's h1. DOM contract of the goal scenarios (GS-visitor_cabinet-*): rows
// wz-datatable-row, sections wz-cabinet-tab-<id>, empty wz-empty — as the v2 cabinet (CabinetLayout, DataTable).
import { z } from "zod";
import { definePattern } from "../define.js";
import { line, linkSlot, para } from "../slots.js";
import type { PatternMeta } from "../types.js";
import type List from "./list.js";
import type Tabs from "./tabs.js";

/** Entity and field names of the system (AppSpec identifiers). */
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "имя сущности или поля латиницей");

/** One kind of the visitor's records. */
export const accountSectionSlot = z.object({
  /** Anchor of the section (the entity name by default). */
  id: ident,
  entity: ident,
  /** «Мои записи». */
  label: line(40),
  /** Fields of a row in order (default: what the role reads, ≤ 6). */
  fields: z.array(ident).min(1).max(6).optional(),
  /** «Отменить» of a record: the status field, its cancelled value and the button label. */
  cancel: z.object({ field: ident, value: ident, label: line(40) }).optional(),
  /** What an empty section says, calmly («Записей пока нет»). */
  empty: line(120),
});

export const accountSlots = z.object({
  /** «Личный кабинет». */
  title: line(80),
  text: para(260).optional(),
  /** 1 — the heading of the page (default), 2 — under a first screen. */
  level: z.union([z.literal(1), z.literal(2)]).optional(),
  sections: z.array(accountSectionSlot).max(4),
  /** Sign-in of a guest: the login page with the way back to the cabinet. */
  signIn: linkSlot,
  /** The action of an empty cabinet (to book, to leave a request). */
  action: linkSlot.optional(),
  /** What a cabinet without sections says. */
  empty: line(120).optional(),
});

/** Preview content (tests, previews): an example business, never published as the client's text (D49). */
export const ACCOUNT_EXAMPLE = {
  title: "Личный кабинет",
  text: "Здесь ваши записи на занятия и заявки — видите только вы.",
  level: 2,
  sections: [
    {
      id: "booking",
      entity: "booking",
      label: "Мои записи",
      fields: ["starts_at", "service", "status", "name"],
      cancel: { field: "status", value: "done", label: "Отменить запись" },
      empty: "Записей пока нет",
    },
    {
      id: "lead",
      entity: "lead",
      label: "Мои заявки",
      fields: ["created_at", "comment", "status"],
      empty: "Заявок пока нет",
    },
  ],
  signIn: { label: "Войти по коду", href: "/login?next=%2Fme" },
  action: { label: "Записаться на занятие", href: "/booking" },
  empty: "Здесь появятся ваши записи и заявки",
} satisfies z.input<typeof accountSlots>;

const at = import.meta.url;

export const ACCOUNT_PATTERNS: readonly PatternMeta[] = [
  definePattern<typeof Tabs>()(at, "account", {
    variant: "tabs",
    layout: "panel",
    title:
      "Кабинет клиента: заголовок и имя, разделы вкладками («Мои записи», «Мои заявки»), записи строками с полями и статусом",
    archetypes: ["*"],
    slots: accountSlots,
    needs: "content",
    license: "own",
    origin: "own",
    example: ACCOUNT_EXAMPLE,
  }),
  definePattern<typeof List>()(at, "account", {
    variant: "list",
    layout: "stacked",
    title: "Кабинет клиента: разделы друг под другом, каждая запись — карточка с датой, полями и статусом",
    archetypes: ["*"],
    slots: accountSlots,
    needs: "content",
    license: "own",
    origin: "own",
    example: ACCOUNT_EXAMPLE,
  }),
];
