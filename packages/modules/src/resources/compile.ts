// compile.ts of «Учёт выдачи и ресурсов» (manifest.hook): the item (`resource`: in stock / issued / unavailable, or a
// count with «в наличии, шт.») and the issue (`resource_issue`: to whom, until when, returned, overdue, deposit) by
// the parameters; one open issue per item without quantities (a unique index (resource, open) answers CONFLICT, as
// the booking's time slot); the overdue mark at the due time; the G1 scenarios. Messages (the reminder before the due
// date and the overdue notice) belong to «Напоминания и уведомления» (notifyPlan).
import type { Field, ModuleFragments, Workflow } from "@wizard/appspec";
import { requiredExtra } from "../client_card/compile.js";
import type { ModuleContext } from "../types.js";

/** Canonical names of the module (notify, the goal programs and the tests rely on them). */
export const RESOURCE_NAMES = { item: "resource", issue: "resource_issue" } as const;

/** Status of an item. */
export function resourceStatuses(withQuantity: boolean): { value: string; label: string }[] {
  return [
    { value: "available", label: "В наличии" },
    { value: "issued", label: withQuantity ? "Всё выдано" : "Выдан" },
    { value: "unavailable", label: "Недоступен" },
  ];
}

/** Status of an issue: canonical values (the metrics count was_overdue, the reminders look at issued). */
export const ISSUE_STATUSES = [
  { value: "issued", label: "Выдано" },
  { value: "overdue", label: "Просрочено" },
  { value: "returned", label: "Возвращено" },
] as const;

const quantity = (ctx: Pick<ModuleContext, "params">) => ctx.params.with_quantity === true;
const label = (ctx: ModuleContext) => String(ctx.params.resource_label ?? "Инвентарь");

/** The issue carries the borrower's consent to reminder letters (notify sends to him only with it). */
export const borrowerLetters = (ctx: Pick<ModuleContext, "params" | "present">): boolean =>
  ctx.present.has("notify") && ctx.params.overdue_reminder !== false;

function itemFields(ctx: ModuleContext): Field[] {
  const q = quantity(ctx);
  return [
    { name: "name", label: "Название", type: "string", required: true, maxLength: 200 },
    {
      name: "status",
      label: "Состояние",
      type: "enum",
      required: true,
      default: "available",
      enum: resourceStatuses(q),
    },
    ...(q
      ? [
          {
            name: "quantity",
            label: "Всего, шт.",
            type: "int",
            required: true,
            min: 0,
            max: 100000,
            default: 1,
          } as Field,
          { name: "in_stock", label: "В наличии, шт.", type: "int", min: 0, max: 100000 } as Field,
        ]
      : []),
    { name: "inventory_no", label: "Инвентарный номер", type: "string", maxLength: 60 },
    ...(ctx.params.deposit === true
      ? [{ name: "deposit", label: "Залог", type: "money", min: 0 } as Field]
      : []),
    { name: "description", label: "Описание", type: "text", maxLength: 1000 },
  ];
}

function issueFields(ctx: ModuleContext): Field[] {
  const q = quantity(ctx);
  const fields: Field[] = [
    {
      name: "resource",
      label: label(ctx),
      type: "ref",
      required: true,
      ref: { entity: RESOURCE_NAMES.item, onDelete: "restrict" },
    },
    {
      name: "holder",
      label: "Кому выдано",
      type: "string",
      required: true,
      maxLength: 120,
      pii: "basic",
      piiKind: "fio",
    },
    {
      name: "status",
      label: "Статус",
      type: "enum",
      required: true,
      default: "issued",
      enum: ISSUE_STATUSES.map((s) => ({ ...s })),
    },
    { name: "due_at", label: "Вернуть до", type: "datetime" },
    { name: "issued_at", label: "Выдано", type: "datetime" },
    { name: "returned_at", label: "Возвращено", type: "datetime" },
  ];
  if (q)
    fields.push({
      name: "quantity",
      label: "Количество, шт.",
      type: "int",
      required: true,
      min: 1,
      max: 100000,
      default: 1,
    });
  if (ctx.present.has("client_card"))
    fields.push({
      name: "client",
      label: String(ctx.allParams.client_card?.client_label ?? "Клиент"),
      type: "ref",
      ref: { entity: "client", onDelete: "set_null" },
    });
  fields.push(
    { name: "phone", label: "Телефон", type: "phone", pii: "basic", piiKind: "phone" },
    { name: "email", label: "Почта для напоминаний", type: "email", pii: "basic", piiKind: "email" },
  );
  if (borrowerLetters(ctx))
    fields.push({
      name: "consent_messages",
      label: "Согласен получать письма о сроке возврата",
      type: "bool",
      default: false,
    });
  if (ctx.params.deposit === true)
    fields.push(
      { name: "deposit", label: "Залог", type: "money", min: 0 },
      { name: "deposit_returned", label: "Залог возвращён", type: "bool", default: false },
    );
  fields.push(
    { name: "was_overdue", label: "Была просрочка", type: "bool", default: false },
    { name: "note", label: "Заметка", type: "text", maxLength: 1000, pii: "basic", piiKind: "free_text" },
  );
  // One open issue per item (1 while issued — the default, hidden from the forms; null once returned): part of the
  // unique index (resource, open), so a second issue of an item on hand answers CONFLICT.
  if (!q) fields.push({ name: "open", label: "Открыта", type: "int", default: 1 });
  return fields;
}

// ---------------------------------------------------------------- G1 scenarios

/** Synthetic borrower of the scenarios (no real person). */
export const RESOURCE_SAMPLE = { holder: "Пример получателя", email: "borrower@example.com" } as const;

function scenarios(ctx: ModuleContext): NonNullable<ModuleFragments["acceptance"]> {
  const extras = ((ctx.params.extra_fields ?? []) as { required?: boolean }[]).some((f) => f.required);
  if (extras) return [];
  const q = quantity(ctx);
  // E-mails of notify: the borrower (with consent) a day before and when overdue, the owner when overdue.
  const notify = ctx.allParams.notify ?? {};
  const remind = borrowerLetters(ctx);
  const owner = remind && Array.isArray(notify.channels) && notify.channels.includes("email");
  const borrower = remind && notify.visitor_emails !== false;
  const notices = { borrower, any: owner };
  const item = (save: string) => ({
    create: {
      entity: RESOURCE_NAMES.item,
      data: { name: "Пример предмета", ...(q ? { quantity: 2 } : {}) },
      save,
    },
  });
  const issue = (save: string, extra: Record<string, unknown> = {}) => ({
    create: {
      entity: RESOURCE_NAMES.issue,
      data: { resource: "$item.id", holder: RESOURCE_SAMPLE.holder, ...extra },
      save,
    },
  });
  const out: NonNullable<ModuleFragments["acceptance"]> = [
    {
      value: {
        text: `Выдача делает предмет «${q ? "в наличии на 1 меньше" : "Выдан"}» со сроком возврата, возврат возвращает его в наличие`,
        check: {
          type: "scenario",
          steps: [
            { as: { role: "owner" } },
            item("item"),
            issue("loan"),
            { runWorkflows: {} },
            { read: { entity: RESOURCE_NAMES.issue, id: "$loan.id" } },
            { expect: { fields: { status: "issued" } } },
            { read: { entity: RESOURCE_NAMES.item, id: "$item.id" } },
            { expect: { fields: q ? { in_stock: 1 } : { status: "issued" } } },
            { update: { entity: RESOURCE_NAMES.issue, id: "$loan.id", data: { status: "returned" } } },
            { runWorkflows: {} },
            { read: { entity: RESOURCE_NAMES.item, id: "$item.id" } },
            { expect: { fields: q ? { in_stock: 2, status: "available" } : { status: "available" } } },
          ],
        },
      },
    },
    {
      value: {
        text: `Срок возврата прошёл — выдача становится просроченной${notices.any ? ", владельцу ушло письмо" : ""}`,
        check: {
          type: "scenario",
          steps: [
            { as: { role: "owner" } },
            item("item"),
            issue("loan", { due_at: "$now+60m" }),
            { runWorkflows: {} },
            ...(notices.any ? [{ expect: { outbox: { connector: "email", count: 0 } } }] : []),
            { advanceTime: { minutes: 61 } },
            { read: { entity: RESOURCE_NAMES.issue, id: "$loan.id" } },
            { expect: { fields: { status: "overdue", was_overdue: true } } },
            ...(notices.any ? [{ expect: { outbox: { connector: "email" } } }] : []),
          ],
        },
      },
    },
  ];
  if (notices.borrower)
    out.push({
      value: {
        text: "За сутки до срока получатель, согласившийся на письма, получает напоминание",
        check: {
          type: "scenario",
          steps: [
            { as: { role: "owner" } },
            item("item"),
            // Due in a day and a minute: the reminder a day before is a minute away.
            issue("loan", { due_at: "$now+1441m", email: RESOURCE_SAMPLE.email, consent_messages: true }),
            { runWorkflows: {} },
            { expect: { outbox: { connector: "email", count: 0 } } },
            { advanceTime: { minutes: 2 } },
            { expect: { outbox: { connector: "email", count: 1 } } },
          ],
        },
      },
    });
  if (!q)
    out.push({
      value: {
        text: "Пока предмет не вернули, второй раз его не выдать",
        check: {
          type: "scenario",
          steps: [
            { as: { role: "owner" } },
            item("item"),
            issue("first"),
            { expect: { status: "created" } },
            issue("second"),
            { expect: { status: "conflict" } },
          ],
        },
      },
    });
  if (ctx.present.has("client_card") && !requiredExtra({ ...ctx, params: ctx.allParams.client_card ?? {} }))
    out.push({
      value: {
        text: "Выдача клиенту видна в его истории и берёт его почту для напоминаний",
        check: {
          type: "scenario",
          steps: [
            { as: { role: "owner" } },
            item("item"),
            {
              create: {
                entity: "client",
                data: { name: RESOURCE_SAMPLE.holder, email: RESOURCE_SAMPLE.email },
                save: "client",
              },
            },
            issue("loan", { client: "$client.id" }),
            { runWorkflows: {} },
            { read: { entity: RESOURCE_NAMES.issue, where: { client: "$client.id" } } },
            { expect: { count: 1, fields: { email: RESOURCE_SAMPLE.email } } },
          ],
        },
      },
    });
  return out;
}

// ---------------------------------------------------------------- hook

export function compileResources(ctx: ModuleContext): ModuleFragments {
  const q = quantity(ctx);
  const workflows: Workflow[] = [
    {
      name: "resource_issued",
      label: "Выдача: срок возврата и наличие",
      trigger: { type: "on_create", entity: RESOURCE_NAMES.issue },
      steps: [{ type: "function", params: { name: "issueResource", args: { id: "$record.id" } } }],
    },
    {
      name: "resource_returned",
      label: "Возврат: предмет снова в наличии",
      trigger: { type: "on_status", entity: RESOURCE_NAMES.issue, field: "status", equals: "returned" },
      steps: [{ type: "function", params: { name: "returnResource", args: { id: "$record.id" } } }],
    },
    {
      name: "resource_overdue",
      label: "Срок возврата прошёл",
      trigger: {
        type: "schedule",
        entity: RESOURCE_NAMES.issue,
        relative: { field: "due_at", offsetMinutes: 0 },
      },
      steps: [
        {
          type: "update",
          params: { if: { status: ["issued"] }, set: { status: "overdue", was_overdue: true } },
        },
      ],
    },
  ];
  return {
    entities: [
      {
        value: {
          name: RESOURCE_NAMES.item,
          label: label(ctx),
          fields: itemFields(ctx),
          indexes: [{ fields: ["status"] }],
        },
      },
      {
        value: {
          name: RESOURCE_NAMES.issue,
          label: "Выдача",
          fields: issueFields(ctx),
          // The holder's name is personal data (G2-PII-05, mvp-09 of D76): a loan is kept three years after its last
          // change — as the client card by default.
          retention: { deleteAfterDays: 1095, anchorField: "updated_at" },
          indexes: [
            ...(q ? [] : [{ fields: ["resource", "open"], unique: true }]),
            { fields: ["status"] },
            { fields: ["due_at"] },
          ],
        },
      },
    ],
    permissions: [
      {
        value: {
          role: "$owner",
          entity: RESOURCE_NAMES.item,
          ops: ["read", "create", "update", "delete"],
          ...(q ? { readonlyFields: ["in_stock"] } : {}),
        },
      },
      {
        value: {
          role: "$staff",
          entity: RESOURCE_NAMES.item,
          ops: ["read", "create", "update"],
          ...(q ? { readonlyFields: ["in_stock"] } : {}),
        },
      },
      {
        value: {
          role: "$owner",
          entity: RESOURCE_NAMES.issue,
          ops: ["read", "create", "update", "delete"],
          readonlyFields: ["was_overdue"],
          ...(q ? {} : { hiddenFields: ["open"] }),
        },
      },
      {
        value: {
          role: "$staff",
          entity: RESOURCE_NAMES.issue,
          ops: ["read", "create", "update"],
          readonlyFields: ["was_overdue"],
          ...(q ? {} : { hiddenFields: ["open"] }),
        },
      },
    ],
    workflows: workflows.map((value) => ({ value })),
    acceptance: scenarios(ctx),
  };
}

/** Notes for the plan screen. */
export function resourcesWarnings(ctx: ModuleContext): string[] {
  const out: string[] = [];
  if (ctx.params.overdue_reminder !== false && !ctx.present.has("notify"))
    out.push(
      "Напоминания о возврате уходят с модулем «Напоминания и уведомления»; без него просрочка только отмечается в кабинете.",
    );
  return out;
}
