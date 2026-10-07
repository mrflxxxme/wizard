// compile.ts of «Абонементы и пакеты» (manifest.hook): the entities by what is sold (visits, a term or visits on a
// term), freezing and members' materials; the visitor's own packages (rowFilter by the login contact, as the bookings
// of «Кабинет посетителя»); the link to «Запись по слотам»: a booking writes a visit off a valid package of the same
// phone (and e-mail) and is cancelled without one, a cancelled booking gives the visit back; the G1 scenarios.
// Messages (the expiry reminder, the refusal letter) belong to «Напоминания и уведомления» (notifyPlan).
import type { Field, ModuleFragments, Workflow } from "@wizard/appspec";
import { visitorBookingContact } from "../booking/compile.js";
import { requiredExtra } from "../client_card/compile.js";
import type { ModuleContext } from "../types.js";

/** Canonical names of the module (notify, the goal programs and the tests rely on them). */
export const PACKAGE_NAMES = {
  plan: "package_plan",
  item: "client_package",
  usage: "package_usage",
  material: "package_material",
} as const;

/** What a package counts (parameter kind). */
export interface PackageKind {
  visits: boolean;
  period: boolean;
}

export function packageKind(params: Readonly<Record<string, unknown>>): PackageKind {
  const kind = typeof params.kind === "string" ? params.kind : "both";
  return { visits: kind !== "period", period: kind !== "visits" };
}

/** Status of a client's package: canonical values (`active` — the only one a booking may use). */
export function packageStatuses(
  params: Readonly<Record<string, unknown>>,
): { value: string; label: string }[] {
  const k = packageKind(params);
  return [
    { value: "active", label: "Действует" },
    ...(params.freeze === true && k.period ? [{ value: "frozen", label: "Заморожен" }] : []),
    ...(k.visits ? [{ value: "used_up", label: "Визиты закончились" }] : []),
    ...(k.period ? [{ value: "expired", label: "Срок закончился" }] : []),
  ];
}

/** The booking's mark of the package (field `package_status` the link adds to the booking). */
export const BOOKING_PACKAGE_STATUSES = [
  { value: "written_off", label: "Списан с абонемента" },
  { value: "returned", label: "Возвращён на абонемент" },
  { value: "no_package", label: "Нет действующего абонемента" },
] as const;

/** Usage kinds: a visit written off or given back. */
export const USAGE_KINDS = [
  { value: "write_off", label: "Списан визит" },
  { value: "return", label: "Возвращён визит" },
] as const;

/** Bookings write visits off packages: the parameter is on and «Запись по слотам» is in the plan. */
export const writesOff = (ctx: Pick<ModuleContext, "params" | "present">): boolean =>
  ctx.params.write_off_on_booking !== false && ctx.present.has("booking");

/**
 * The visitor reads his own packages — «Мои абонементы» of the cabinet, or the members' materials, which open by a
 * valid package of his own: the contact the visitor logs in with, else null.
 */
export function visitorPackageContact(ctx: ModuleContext): "email" | "phone" | null {
  const vc = ctx.allParams.visitor_cabinet;
  if (!ctx.present.has("visitor_cabinet") || (vc?.show_packages !== true && ctx.params.materials !== true))
    return null;
  return vc?.login === "phone_otp" ? "phone" : "email";
}

const label = (ctx: ModuleContext) => String(ctx.params.package_label ?? "Абонемент");
const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);

function planFields(ctx: ModuleContext): Field[] {
  const k = packageKind(ctx.params);
  return [
    { name: "name", label: "Название", type: "string", required: true, maxLength: 120 },
    ...(k.visits
      ? [{ name: "visits", label: "Визитов", type: "int", required: true, min: 1, max: 500 } as Field]
      : []),
    ...(k.period
      ? [
          {
            name: "days",
            label: "Срок, дней",
            type: "int",
            required: true,
            min: 1,
            max: 730,
            default: num(ctx.params.validity_days, 30),
          } as Field,
        ]
      : []),
    { name: "price", label: "Цена", type: "money", min: 0 },
    { name: "description", label: "Описание", type: "text", maxLength: 1000 },
    { name: "active", label: "Продаётся", type: "bool", default: true },
  ];
}

function itemFields(ctx: ModuleContext): Field[] {
  const k = packageKind(ctx.params);
  const fields: Field[] = [
    {
      name: "client",
      label: String(ctx.allParams.client_card?.client_label ?? "Клиент"),
      type: "ref",
      required: true,
      ref: { entity: "client", onDelete: "cascade" },
    },
    {
      name: "plan",
      label: "Тариф",
      type: "ref",
      required: true,
      ref: { entity: PACKAGE_NAMES.plan, onDelete: "restrict" },
    },
    {
      name: "status",
      label: "Статус",
      type: "enum",
      required: true,
      default: "active",
      enum: packageStatuses(ctx.params),
    },
  ];
  if (k.visits)
    fields.push({ name: "visits_left", label: "Осталось визитов", type: "int", min: 0, max: 500 });
  if (k.period) fields.push({ name: "expires_on", label: "Действует до", type: "date" });
  fields.push({ name: "starts_on", label: "Начало", type: "date" });
  if (k.visits) fields.push({ name: "visits_total", label: "Визитов всего", type: "int", min: 0, max: 500 });
  fields.push(
    { name: "price", label: "Цена", type: "money", min: 0 },
    // Copies of the client's contacts: a booking finds its package by them, the visitor sees his own by his login.
    { name: "phone", label: "Телефон клиента", type: "phone", pii: "basic", piiKind: "phone" },
    { name: "email", label: "Почта клиента", type: "email", pii: "basic", piiKind: "email" },
  );
  if (ctx.present.has("notify"))
    fields.push({
      name: "consent_messages",
      label: "Клиент согласен на письма об абонементе",
      type: "bool",
      default: false,
    });
  if (ctx.params.freeze === true && k.period)
    fields.push({ name: "frozen_at", label: "Заморожен с", type: "datetime" });
  // The moment the package ends (the end of «Действует до» in Moscow time), kept by packageSold: the expiry and the
  // reminder are scheduled by it — a time, unlike a calendar date, does not depend on the database's time zone.
  if (k.period) fields.push({ name: "ends_at", label: "Окончание действия", type: "datetime" });
  fields.push({
    name: "note",
    label: "Заметка",
    type: "text",
    maxLength: 1000,
    pii: "basic",
    piiKind: "free_text",
  });
  return fields;
}

function usageFields(ctx: ModuleContext): Field[] {
  return [
    {
      name: "client_package",
      label: label(ctx),
      type: "ref",
      required: true,
      ref: { entity: PACKAGE_NAMES.item, onDelete: "cascade" },
    },
    {
      name: "kind",
      label: "Что произошло",
      type: "enum",
      required: true,
      default: "write_off",
      enum: USAGE_KINDS.map((x) => ({ ...x })),
    },
    { name: "used_at", label: "Когда", type: "datetime" },
    ...(writesOff(ctx)
      ? [
          {
            name: "booking",
            label: "Запись",
            type: "ref",
            ref: { entity: "booking", onDelete: "set_null" },
          } as Field,
        ]
      : []),
    { name: "note", label: "Комментарий", type: "text", maxLength: 500 },
    // Set by the module's functions once the visit is counted (protection against a double write-off).
    { name: "applied", label: "Учтено в остатке", type: "bool", default: false },
  ];
}

function materialFields(ctx: ModuleContext): Field[] {
  return [
    { name: "title", label: "Название", type: "string", required: true, maxLength: 200 },
    { name: "description", label: "Описание", type: "text", maxLength: 2000 },
    { name: "link", label: "Ссылка на видео или файл", type: "url", required: true },
    { name: "sort_order", label: "Порядок", type: "int", min: 0, max: 10000, default: 100 },
    {
      name: "active",
      label: `Показывать (${String(ctx.params.material_label ?? "Материал")})`,
      type: "bool",
      default: true,
    },
  ];
}

// ---------------------------------------------------------------- G1 scenarios

/** Synthetic client of the scenarios (no real person). */
export const PACKAGE_SAMPLE = {
  name: "Пример клиента",
  phone: "+79990005566",
  email: "package.client@example.com",
} as const;

type Contact = { phone: string; email: string };
/** The second scenario's client: another phone, so the packages of the scenarios never match each other. */
const OTHER: Contact = { phone: "+79990005577", email: "package.expired@example.com" };

/** A booking of the scenarios `minutes` from now with a sample client's contacts (booking parameters as compiled). */
function sampleBooking(ctx: ModuleContext, minutes: number, contact: Contact = PACKAGE_SAMPLE) {
  const b = ctx.allParams.booking ?? {};
  const step = num(b.slot_minutes, 60);
  return {
    service: "$seed.service[0].id",
    ...(b.with_specialists === true ? { specialist: "$seed.specialist[0].id" } : {}),
    starts_at: `$now+${minutes}m`,
    ends_at: `$now+${minutes + step}m`,
    name: PACKAGE_SAMPLE.name,
    phone: contact.phone,
    email: contact.email,
  };
}

/** Steps of «the owner sells a package to the sample client» (saved as $pkg). */
function saleSteps(ctx: ModuleContext, contact: Contact = PACKAGE_SAMPLE): Record<string, unknown>[] {
  const k = packageKind(ctx.params);
  return [
    { as: { role: "owner" } },
    {
      create: {
        entity: PACKAGE_NAMES.plan,
        data: {
          name: "Пример тарифа",
          ...(k.visits ? { visits: 4 } : {}),
          ...(k.period ? { days: 30 } : {}),
        },
        save: "plan",
      },
    },
    { create: { entity: "client", data: { name: PACKAGE_SAMPLE.name, ...contact }, save: "client" } },
    { create: { entity: PACKAGE_NAMES.item, data: { client: "$client.id", plan: "$plan.id" }, save: "pkg" } },
    { runWorkflows: {} },
  ];
}

function scenarios(ctx: ModuleContext): NonNullable<ModuleFragments["acceptance"]> {
  // The plan gave the client required extra fields: a scenario cannot create one.
  if (requiredExtra({ ...ctx, params: ctx.allParams.client_card ?? {} })) return [];
  const k = packageKind(ctx.params);
  const out: NonNullable<ModuleFragments["acceptance"]> = [
    {
      value: {
        text: `После продажи «${label(ctx)}» сразу действует: остаток, срок и контакты клиента заполнены`,
        check: {
          type: "scenario",
          steps: [
            ...saleSteps(ctx),
            { read: { entity: PACKAGE_NAMES.item, id: "$pkg.id" } },
            {
              expect: {
                fields: {
                  status: "active",
                  phone: PACKAGE_SAMPLE.phone,
                  ...(k.visits ? { visits_left: 4, visits_total: 4 } : {}),
                },
              },
            },
          ],
        },
      },
    },
  ];
  if (k.period) {
    // The reminder goes to the client with consent N days before the end (notify), the package expires after it.
    const n = ctx.present.has("notify") ? num(ctx.params.expiry_reminder_days, 3) : 0;
    const letters = n > 0 && ctx.allParams.notify?.visitor_emails !== false;
    const ending: Contact = { phone: "+79990005588", email: "package.ending@example.com" };
    const steps = saleSteps(ctx, ending);
    if (letters) {
      // The client agreed to letters about the package.
      const sale = steps.find(
        (s) => (s.create as { entity?: string } | undefined)?.entity === PACKAGE_NAMES.item,
      );
      if (sale) (sale.create as { data: Record<string, unknown> }).data.consent_messages = true;
    }
    out.push({
      value: {
        text: `Срок закончился — «${label(ctx)}» больше не действует${letters ? ", а клиент заранее получил напоминание" : ""}`,
        check: {
          type: "scenario",
          steps: [
            ...steps,
            { advanceTime: { minutes: 31 * 1440 } },
            ...(letters ? [{ expect: { outbox: { connector: "email" } } }] : []),
            { read: { entity: PACKAGE_NAMES.item, id: "$pkg.id" } },
            { expect: { fields: { status: "expired" } } },
          ],
        },
      },
    });
  }
  const booking = ctx.allParams.booking ?? {};
  const bookingExtras = ((booking.extra_fields ?? []) as { required?: boolean }[]).some((f) => f.required);
  if (!writesOff(ctx) || bookingExtras) return out;
  // A week and a few odd minutes ahead: far from the seed's bookings and from the booking module's scenarios.
  const T1 = 7 * 24 * 60 + 23;
  const T2 = T1 + 3 * 24 * 60;
  out.push(
    {
      value: {
        text: "Запись по абонементу списывает визит, отмена записи возвращает его",
        check: {
          type: "scenario",
          steps: [
            ...saleSteps(ctx),
            { as: { role: "guest" } },
            { create: { entity: "booking", data: sampleBooking(ctx, T1), save: "visit" }, consent: true },
            { expect: { status: "created" } },
            { runWorkflows: {} },
            { as: { role: "owner" } },
            { read: { entity: "booking", id: "$visit.id" } },
            { expect: { fields: { package_status: "written_off", client_package: "$pkg.id" } } },
            ...(k.visits
              ? [
                  { read: { entity: PACKAGE_NAMES.item, id: "$pkg.id" } },
                  { expect: { fields: { visits_left: 3 } } },
                ]
              : []),
            { update: { entity: "booking", id: "$visit.id", data: { status: "cancelled" } } },
            { runWorkflows: {} },
            { read: { entity: "booking", id: "$visit.id" } },
            { expect: { fields: { package_status: "returned" } } },
            ...(k.visits
              ? [
                  { read: { entity: PACKAGE_NAMES.item, id: "$pkg.id" } },
                  { expect: { fields: { visits_left: 4 } } },
                ]
              : []),
          ],
        },
      },
    },
    {
      value: {
        text: `С закончившимся абонементом записаться нельзя: проверка отказывает, запись без абонемента отменяется`,
        check: {
          type: "scenario",
          steps: [
            ...saleSteps(ctx, OTHER),
            {
              update: {
                entity: PACKAGE_NAMES.item,
                id: "$pkg.id",
                data: { status: k.period ? "expired" : "used_up" },
              },
            },
            { as: { role: "guest" } },
            {
              callFn: {
                name: "packageCheck",
                args: { phone: OTHER.phone, email: OTHER.email, starts_at: `$now+${T2}m` },
              },
            },
            { expect: { status: "ok", fields: { ok: false } } },
            {
              create: { entity: "booking", data: sampleBooking(ctx, T2, OTHER), save: "visit" },
              consent: true,
            },
            { expect: { status: "created" } },
            { runWorkflows: {} },
            { as: { role: "owner" } },
            { read: { entity: "booking", id: "$visit.id" } },
            { expect: { fields: { status: "cancelled", package_status: "no_package", seat: null } } },
          ],
        },
      },
    },
  );
  return out;
}

// ---------------------------------------------------------------- hook

export function compilePackages(ctx: ModuleContext): ModuleFragments {
  const k = packageKind(ctx.params);
  const lbl = label(ctx);
  const mine = visitorPackageContact(ctx);
  const hide = k.period ? { hiddenFields: ["ends_at"] } : {};
  const workflows: Workflow[] = [
    {
      name: "package_sold",
      label: `Заполнить остаток и срок проданного: ${lbl}`.slice(0, 80),
      trigger: { type: "on_create", entity: PACKAGE_NAMES.item },
      steps: [{ type: "function", params: { name: "packageSold", args: { id: "$record.id" } } }],
    },
    {
      name: "package_usage_apply",
      label: "Учесть визит в остатке",
      trigger: { type: "on_create", entity: PACKAGE_NAMES.usage },
      steps: [{ type: "function", params: { name: "applyUsage", args: { id: "$record.id" } } }],
    },
  ];
  if (k.period)
    workflows.push(
      {
        // «Действует до» changed by hand (or by the unfreeze): the moment of the end follows it.
        name: "package_dates",
        label: "Пересчитать окончание абонемента",
        trigger: { type: "on_update", entity: PACKAGE_NAMES.item, field: "expires_on" },
        steps: [{ type: "function", params: { name: "packageSold", args: { id: "$record.id" } } }],
      },
      {
        // After the last day of «Действует до» the package expires (a frozen one waits for the unfreeze).
        name: "package_expire",
        label: "Срок абонемента закончился",
        trigger: {
          type: "schedule",
          entity: PACKAGE_NAMES.item,
          relative: { field: "ends_at", offsetMinutes: 0 },
        },
        steps: [{ type: "update", params: { if: { status: ["active"] }, set: { status: "expired" } } }],
      },
    );
  if (ctx.params.freeze === true && k.period)
    workflows.push(
      {
        name: "package_frozen",
        label: "Заморозка абонемента",
        trigger: { type: "on_status", entity: PACKAGE_NAMES.item, field: "status", equals: "frozen" },
        steps: [{ type: "update", params: { set: { frozen_at: "$now" } } }],
      },
      {
        name: "package_unfrozen",
        label: "Разморозка продлевает срок",
        trigger: { type: "on_status", entity: PACKAGE_NAMES.item, field: "status", equals: "active" },
        steps: [{ type: "function", params: { name: "unfreezePackage", args: { id: "$record.id" } } }],
      },
    );
  if (writesOff(ctx))
    workflows.push(
      {
        name: "package_write_off",
        label: "Списать визит с абонемента по записи",
        trigger: { type: "on_create", entity: "booking" },
        steps: [{ type: "function", params: { name: "writeOffVisit", args: { id: "$record.id" } } }],
      },
      {
        name: "package_return",
        label: "Вернуть визит на абонемент при отмене записи",
        trigger: { type: "on_status", entity: "booking", field: "status", equals: "cancelled" },
        steps: [{ type: "function", params: { name: "returnVisit", args: { id: "$record.id" } } }],
      },
    );

  const out: ModuleFragments = {
    entities: [
      {
        value: {
          name: PACKAGE_NAMES.item,
          label: lbl,
          fields: itemFields(ctx),
          indexes: [
            { fields: ["phone"] },
            { fields: ["email"] },
            { fields: ["status"] },
            ...(k.period ? [{ fields: ["ends_at"] }] : []),
          ],
        },
      },
      { value: { name: PACKAGE_NAMES.plan, label: "Тариф", fields: planFields(ctx) } },
      {
        value: {
          name: PACKAGE_NAMES.usage,
          label: "Списание",
          fields: usageFields(ctx),
          indexes: [{ fields: ["used_at"] }],
        },
      },
    ],
    permissions: [
      // The moment of the end is the module's (packageSold keeps it by «Действует до»).
      {
        value: {
          role: "$owner",
          entity: PACKAGE_NAMES.item,
          ops: ["read", "create", "update", "delete"],
          ...hide,
        },
      },
      { value: { role: "$staff", entity: PACKAGE_NAMES.item, ops: ["read", "create", "update"], ...hide } },
      { value: { role: "$owner", entity: PACKAGE_NAMES.plan, ops: ["read", "create", "update", "delete"] } },
      { value: { role: "$staff", entity: PACKAGE_NAMES.plan, ops: ["read"] } },
      // The flag of the module's functions is not set by hand.
      {
        value: {
          role: "$owner",
          entity: PACKAGE_NAMES.usage,
          ops: ["read", "create", "update", "delete"],
          readonlyFields: ["applied"],
        },
      },
      {
        value: {
          role: "$staff",
          entity: PACKAGE_NAMES.usage,
          ops: ["read", "create"],
          readonlyFields: ["applied"],
        },
      },
      // «Мои абонементы»: the visitor's own packages by the login contact, read only, without the card's notes.
      ...(mine
        ? [
            {
              value: {
                role: "$visitor",
                entity: PACKAGE_NAMES.item,
                ops: ["read"] as "read"[],
                rowFilter: { [mine]: `$user.${mine}` },
                hiddenFields: ["client", "note", ...(k.period ? ["ends_at"] : [])],
              },
            },
          ]
        : []),
    ],
    workflows: workflows.map((value) => ({ value })),
    acceptance: scenarios(ctx),
  };
  if (ctx.params.materials === true) {
    out.entities?.push({
      value: {
        name: PACKAGE_NAMES.material,
        label: String(ctx.params.material_label ?? "Материал"),
        fields: materialFields(ctx),
        indexes: [{ fields: ["sort_order"] }],
      },
    });
    out.permissions?.push(
      {
        value: {
          role: "$owner",
          entity: PACKAGE_NAMES.material,
          ops: ["read", "create", "update", "delete"],
        },
      },
      { value: { role: "$staff", entity: PACKAGE_NAMES.material, ops: ["read"] } },
    );
  }
  if (writesOff(ctx)) {
    // The link to «Запись по слотам»: the package a booking used and its mark; the visitor sets neither.
    out.fields = [
      {
        entity: "booking",
        value: {
          name: "client_package",
          label: lbl,
          type: "ref",
          ref: { entity: PACKAGE_NAMES.item, onDelete: "set_null" },
        },
      },
      {
        entity: "booking",
        value: {
          name: "package_status",
          label: "Абонемент",
          type: "enum",
          enum: BOOKING_PACKAGE_STATUSES.map((x) => ({ ...x })),
        },
      },
    ];
    out.permissions?.push({
      value: {
        role: "$public",
        entity: "booking",
        ops: ["create"],
        readonlyFields: ["client_package", "package_status"],
      },
    });
    const visitor = visitorBookingContact(ctx);
    if (visitor)
      out.permissions?.push({
        value: {
          role: "$visitor",
          entity: "booking",
          ops: ["read", "update"],
          rowFilter: { [visitor]: `$user.${visitor}` },
          readonlyFields: ["client_package", "package_status"],
        },
      });
  }
  return out;
}

/** Notes for the plan screen. */
export function packagesWarnings(ctx: ModuleContext): string[] {
  const out: string[] = [];
  if (ctx.params.write_off_on_booking !== false && !ctx.present.has("booking"))
    out.push(
      "Визиты списываются по записи только вместе с модулем «Запись по слотам»; без него сотрудник отмечает визит в кабинете.",
    );
  if (ctx.params.materials === true && !ctx.present.has("visitor_cabinet"))
    out.push(
      "Материалы для клиентов с абонементом видны клиентам только с модулем «Кабинет посетителя»; сейчас — только владельцу и сотрудникам.",
    );
  if (ctx.params.freeze === true && !packageKind(ctx.params).period)
    out.push(
      "Заморозка продлевает срок абонемента, а у абонемента на число визитов срока нет — заморозка не включена.",
    );
  return out;
}
