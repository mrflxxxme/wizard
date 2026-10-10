// compile.ts of «Запись по слотам» (manifest.hook): what substitution cannot express — the booking entity by the
// parameters (status default by confirm, the e-mail required by the links, the slot index with or without resources,
// the client link of «Клиенты с историей»), the rights of the public role and of the visitor cabinet, the release of
// the time on cancel, and the G1 scenarios of the goals. Messages (confirmation, reminders, cancel and reschedule
// links) belong to «Напоминания и уведомления»: it reads bookingLinks() for the links of the runtime (D69).
import type { Field, ModuleFragments, Workflow } from "@wizard/appspec";
import { CATALOG_NAMES } from "../catalog/compile.js";
import { type ClientContact, requiredExtra } from "../client_card/compile.js";
import type { ModuleContext } from "../types.js";

/** Booking status: canonical values (metrics count confirmed/done as visits, no_show and cancelled as losses). */
export const BOOKING_STATUSES = [
  { value: "new", label: "Ждёт подтверждения" },
  { value: "confirmed", label: "Подтверждена" },
  { value: "done", label: "Состоялась" },
  { value: "no_show", label: "Не пришёл" },
  { value: "cancelled", label: "Отменена" },
] as const;

/** Statuses that still hold the time (a link may move or cancel them). */
export const ACTIVE_STATUSES = ["new", "confirmed"] as const;

/**
 * What the module expects of «Каталог и прайс» (B2-13, CATALOG_NAMES): entity `service` with `name`, `active` (bool)
 * and, with with_duration (requires.expectParams), `duration_min` (int); the booking page lists active services, takes
 * the length of a booking from them and opens a service from the showcase by /booking?service=<id>.
 */
export const SERVICE_CONTRACT = {
  entity: CATALOG_NAMES.item,
  name: CATALOG_NAMES.title,
  active: CATALOG_NAMES.active,
  duration: CATALOG_NAMES.duration,
} as const;

/** Page of the booking (also the page of the reschedule link and the showcase's target). */
export const BOOKING_ROUTE = "/booking";

const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);

/** The module's link rules shared by the compile hook, notify, the page and tests. */
export function linkRules(params: Readonly<Record<string, unknown>>) {
  const cancel = bool(params.cancel_by_link, true);
  const reschedule = bool(params.reschedule_by_link, true);
  const hours = num(params.cancel_until_hours, 2);
  return { cancel, reschedule, untilMinutes: hours * 60, any: cancel || reschedule };
}

/**
 * The one-time links of the visitor's messages (runtime /_wizard/hooks/message/*, D69) by the booking's parameters,
 * for the notify steps to the visitor: `cancel` sets the status and releases the seat at once (the unique slot index
 * ignores null), `reschedule` opens /booking with the service (and resource) kept and moves the booking once; both
 * close `cancel_until_hours` before the start. `lines` — the text of the links for the visitor's templates.
 */
export function bookingLinks(params: Readonly<Record<string, unknown>>): {
  cancel?: Record<string, unknown>;
  reschedule?: Record<string, unknown>;
  lines: string;
} {
  const links = linkRules(params);
  const until =
    links.untilMinutes > 0 ? { until: { field: "starts_at", minutesBefore: links.untilMinutes } } : {};
  const capacity = num(params.capacity, 1);
  const lines: string[] = [];
  if (links.cancel) lines.push("Не сможете прийти — отмените запись по ссылке: {{cancel_link}}");
  if (links.reschedule) lines.push("Перенести на другое время: {{reschedule_link}}");
  if (links.any && links.untilMinutes > 0) {
    const what =
      links.cancel && links.reschedule ? "отменить или перенести" : links.cancel ? "отменить" : "перенести";
    lines.push(`По ссылке можно ${what} запись не позже чем за ${links.untilMinutes / 60} ч до начала.`);
  }
  return {
    ...(links.cancel ? { cancel: { set: { status: "cancelled", seat: null }, ...until } } : {}),
    ...(links.reschedule
      ? {
          reschedule: {
            page: BOOKING_ROUTE,
            fields: ["starts_at", "ends_at", ...(capacity > 1 ? ["seat"] : [])],
            keep: ["service", ...(params.with_specialists === true ? ["specialist"] : [])],
            when: { status: [...ACTIVE_STATUSES] },
            ...until,
          },
        }
      : {}),
    lines: lines.length ? `\n\n${lines.join("\n")}` : "",
  };
}

/** The visitor cabinet shows «Мои записи»: the contact the visitor logs in with, else null. */
export function visitorBookingContact(ctx: ModuleContext): "email" | "phone" | null {
  const vc = ctx.allParams.visitor_cabinet;
  if (!ctx.present.has("visitor_cabinet") || vc?.show_bookings !== true) return null;
  return vc.login === "phone_otp" ? "phone" : "email";
}

function bookingFields(ctx: ModuleContext): Field[] {
  const p = ctx.params;
  const links = linkRules(p);
  const manual = p.confirm === "manual";
  const capacity = num(p.capacity, 1);
  const fields: Field[] = [
    { name: "starts_at", label: "Начало", type: "datetime", required: true },
    {
      name: "service",
      label: "Услуга",
      type: "ref",
      required: true,
      ref: { entity: SERVICE_CONTRACT.entity, onDelete: "restrict" },
    },
  ];
  if (p.with_specialists === true)
    fields.push({
      name: "specialist",
      label: String(p.specialist_label ?? "Специалист"),
      type: "ref",
      required: true,
      ref: { entity: "specialist", onDelete: "restrict" },
    });
  fields.push(
    {
      name: "status",
      label: "Статус",
      type: "enum",
      required: true,
      default: manual ? "new" : "confirmed",
      enum: BOOKING_STATUSES.map((s) => ({ ...s })),
    },
    {
      name: "name",
      label: "Имя",
      type: "string",
      required: true,
      maxLength: 120,
      pii: "basic",
      piiKind: "fio",
    },
    { name: "phone", label: "Телефон", type: "phone", required: true, pii: "basic", piiKind: "phone" },
    {
      name: "email",
      label: "Почта",
      type: "email",
      ...(links.any || visitorBookingContact(ctx) === "email" ? { required: true } : {}),
      pii: "basic",
      piiKind: "email",
    },
    {
      name: "comment",
      label: "Комментарий",
      type: "text",
      maxLength: 1000,
      pii: "basic",
      piiKind: "free_text",
    },
    { name: "ends_at", label: "Окончание", type: "datetime", required: true },
    // Seat of the time (1…capacity); null — the time is released (cancelled). Part of the unique slot index.
    { name: "seat", label: "Место", type: "int", default: 1, min: 1, max: capacity },
  );
  if (ctx.present.has("client_card"))
    fields.push({
      name: "client",
      label: String(ctx.allParams.client_card?.client_label ?? "Клиент"),
      type: "ref",
      ref: { entity: "client", onDelete: "set_null" },
    });
  return fields;
}

// ---------------------------------------------------------------- G1 scenarios of the goals

/** Synthetic visitor of the scenarios (no real person). */
const SAMPLE = { name: "Анна Тестова", phone: "+79990003344", email: "anna.booking@example.ru" } as const;

/** A booking of the scenarios `minutes` from now (far from the seed's times, one step long). */
function sampleBooking(ctx: ModuleContext, minutes: number, contact: { email?: string } = {}) {
  const step = num(ctx.params.slot_minutes, 60);
  return {
    service: `$seed.${SERVICE_CONTRACT.entity}[0].id`,
    ...(ctx.params.with_specialists === true ? { specialist: "$seed.specialist[0].id" } : {}),
    starts_at: `$now+${minutes}m`,
    ends_at: `$now+${minutes + step}m`,
    ...SAMPLE,
    ...contact,
  };
}

/** The plan gave the booking a required extra field: scenarios cannot fill every field. */
const requiredExtras = (ctx: ModuleContext): boolean =>
  ((ctx.params.extra_fields ?? []) as { required?: boolean }[]).some((f) => f.required);

function scenarios(ctx: ModuleContext): NonNullable<ModuleFragments["acceptance"]> {
  if (requiredExtras(ctx)) return [];
  // Minutes ahead: a week and a few odd minutes, so the seed's bookings never hold the same time.
  const T1 = 7 * 24 * 60 + 7;
  const T2 = T1 + 2 * 24 * 60;
  const out: NonNullable<ModuleFragments["acceptance"]> = [
    {
      value: {
        text: "Второй посетитель на то же время получает отказ, на это время одна запись",
        check: {
          type: "scenario",
          steps: [
            { create: { entity: "booking", data: sampleBooking(ctx, T1), save: "first" }, consent: true },
            { expect: { status: "created" } },
            {
              create: {
                entity: "booking",
                data: sampleBooking(ctx, T1, { email: "boris.booking@example.ru" }),
              },
              consent: true,
            },
            { expect: { status: "conflict" } },
            { as: { role: "owner" } },
            { read: { entity: "booking", id: "$first.id" } },
            {
              expect: { fields: { status: ctx.params.confirm === "manual" ? "new" : "confirmed", seat: 1 } },
            },
          ],
        },
      },
    },
    {
      value: {
        text: "Отменённая запись сразу освобождает время для другого посетителя",
        check: {
          type: "scenario",
          steps: [
            { create: { entity: "booking", data: sampleBooking(ctx, T2), save: "first" }, consent: true },
            { expect: { status: "created" } },
            { as: { role: "owner" } },
            { update: { entity: "booking", id: "$first.id", data: { status: "cancelled" } } },
            { runWorkflows: {} },
            { read: { entity: "booking", id: "$first.id" } },
            { expect: { fields: { status: "cancelled", seat: null } } },
            { as: { role: "guest" } },
            {
              create: {
                entity: "booking",
                data: sampleBooking(ctx, T2, { email: "vera.booking@example.ru" }),
              },
              consent: true,
            },
            { expect: { status: "created" } },
          ],
        },
      },
    },
  ];
  const client = clientScenario(ctx, T2 + 2 * 24 * 60);
  if (client) out.push({ value: client });
  return out;
}

/** «Две записи с одним контактом — один клиент, обе записи в его истории» (GS-client_card-1 without a browser). */
function clientScenario(ctx: ModuleContext, at: number): Record<string, unknown> | null {
  if (!ctx.present.has("client_card") || requiredExtra({ ...ctx, params: ctx.allParams.client_card ?? {} }))
    return null;
  const key = (ctx.allParams.client_card?.match_by as ClientContact | undefined) ?? "phone";
  return {
    text: "Две записи с одним контактом дают одного клиента, и обе записи видны в его истории",
    check: {
      type: "scenario",
      steps: [
        { create: { entity: "booking", data: sampleBooking(ctx, at), save: "first" }, consent: true },
        { create: { entity: "booking", data: sampleBooking(ctx, at + 24 * 60) }, consent: true },
        { runWorkflows: {} },
        { as: { role: "owner" } },
        { read: { entity: "client", where: { [key]: SAMPLE[key] } } },
        { expect: { count: 1 } },
        { read: { entity: "booking", id: "$first.id", save: "visit" } },
        { read: { entity: "booking", where: { client: "$visit.client" } } },
        { expect: { count: 2 } },
      ],
    },
  };
}

// ---------------------------------------------------------------- hook

export function compileBooking(ctx: ModuleContext): ModuleFragments {
  const p = ctx.params;
  const spec = p.with_specialists === true;
  const clients = ctx.present.has("client_card");
  const fields = bookingFields(ctx);
  const mine = visitorBookingContact(ctx);
  const workflows: Workflow[] = [
    {
      // Cancelled in the cabinet (the link releases it at once): the seat leaves the unique slot index.
      name: "booking_release",
      label: "Отменённая запись освобождает время",
      trigger: { type: "on_status", entity: "booking", field: "status", equals: "cancelled" },
      steps: [{ type: "update", params: { set: { seat: null } } }],
    },
  ];
  if (clients) {
    const cc = ctx.allParams.client_card ?? {};
    workflows.push({
      name: "client_from_booking",
      label: "Найти или создать клиента по записи",
      trigger: { type: "on_create", entity: "booking" },
      steps: [
        {
          type: "function",
          params: {
            name: "clientFromBooking",
            args: {
              id: "$record.id",
              matchBy: (cc.match_by as ClientContact | undefined) ?? "phone",
              create: !requiredExtra({ ...ctx, params: cc }),
            },
          },
        },
      ],
    });
  }
  const out: ModuleFragments = {
    entities: [
      {
        value: {
          name: "booking",
          label: "Запись",
          fields,
          indexes: [
            // One time — one booking per resource and seat: the runtime answers CONFLICT (D75); a released seat is null.
            { fields: [...(spec ? ["specialist"] : []), "starts_at", "seat"], unique: true },
            // The goal panel and the reports read bookings by the visit time.
            { fields: ["starts_at"] },
            { fields: ["status"] },
            ...(clients ? [{ fields: ["client"] }] : []),
          ],
          retention: {
            deleteAfterDays: num(p.retention_days, 365),
            anchorField: "starts_at",
            mode: "anonymize",
          },
        },
      },
    ],
    permissions: [
      {
        value: {
          role: "$public",
          entity: "booking",
          ops: ["create"],
          readonlyFields: [
            "status",
            ...(num(p.capacity, 1) > 1 ? [] : ["seat"]),
            ...(clients ? ["client"] : []),
          ],
        },
      },
      // «Мои записи» of the visitor cabinet: his bookings by the login contact; he may only cancel (the status).
      ...(mine
        ? [
            {
              value: {
                role: "$visitor",
                entity: "booking",
                ops: ["read", "update"] as ("read" | "update")[],
                rowFilter: { [mine]: `$user.${mine}` },
                readonlyFields: fields.map((f) => f.name).filter((n) => n !== "status"),
                // V3-18: the status only to «cancelled» — not «confirmed» or «done» of his own booking via the API.
                allowedValues: { status: ["cancelled"] },
              },
            },
          ]
        : []),
    ],
    workflows: workflows.map((value) => ({ value })),
    acceptance: scenarios(ctx),
  };
  if (spec)
    out.entities?.push({
      value: {
        name: "specialist",
        label: String(p.specialist_label ?? "Специалист"),
        fields: [
          { name: "name", label: "Название", type: "string", required: true, maxLength: 120 },
          { name: "description", label: "Описание", type: "text", maxLength: 1000 },
          { name: "active", label: "Принимает записи", type: "bool", default: true },
        ],
      },
    });
  return out;
}
