// V3-10: the base system extension operations are checked on — modules of a CRM with leads, clients, deals, packages,
// staff and notifications by e-mail and Telegram compiled in backend mode — and operations by kind: allowed ones and
// ones the rules reject. Data only, no models.
import type { SystemPlan } from "@wizard/appspec";
import type { CompileSuccess } from "../src/index.js";
import { compiled } from "./backend-fixtures.js";
import { allModulesPlan, testRegistry } from "./fixtures.js";

/** All modules but booking, resources and the visitor cabinet (their G2 probes collide on unique slots in v2 too). */
export function extendBasePlan(): SystemPlan {
  const plan = allModulesPlan();
  return {
    ...plan,
    modules: plan.modules
      .filter((m) => !["booking", "resources", "visitor_cabinet"].includes(m.id))
      .map((m) => (m.id === "packages" ? { id: m.id, params: { write_off_on_booking: false } } : m)),
  };
}

export function extendBase(): CompileSuccess {
  return compiled(extendBasePlan(), testRegistry(), { front: "backend" });
}

/** A query of an extension function: leads by status for the owner and the staff (ctx.db, index-free list ≤ 100). */
export const LEAD_STATS_SOURCE = `import { query, v } from "@wizard/sdk";

export default query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.lead.list({ limit: 100 });
    return { total: rows.filter((r) => args.status === undefined || r.status === args.status).length };
  },
});
`;

/** Allowed operations, one or more of each kind. */
export const ALLOWED = {
  field: {
    op: "add_field",
    entity: "deal",
    field: {
      name: "channel",
      label: "Канал",
      type: "enum",
      enum: [
        { value: "site", label: "Сайт" },
        { value: "call", label: "Звонок" },
      ],
    },
  },
  piiPhone: {
    op: "add_field",
    entity: "deal",
    field: { name: "contact_phone", label: "Телефон контактного лица", type: "phone" },
  },
  piiMessenger: {
    op: "add_field",
    entity: "deal",
    field: { name: "contact_messenger", label: "Мессенджер (Telegram/WhatsApp)", type: "string" },
  },
  entity: {
    op: "add_entity",
    entity: {
      name: "car",
      label: "Автомобиль",
      fields: [
        { name: "plate", label: "Госномер", type: "string", required: true },
        { name: "model", label: "Модель", type: "string" },
        { name: "client", label: "Клиент", type: "ref", ref: { entity: "client" } },
      ],
    },
    grants: [{ role: "staff", ops: ["read", "create", "update"] }],
  },
  role: {
    op: "add_role",
    role: { name: "manager", label: "Менеджер", access: "login", loginMethods: ["email_otp"] },
    permissions: [
      { entity: "lead", ops: ["read", "update"] },
      { entity: "deal", ops: ["read", "create", "update"] },
      { entity: "client_package", ops: ["read"], hiddenFields: ["ends_at"] },
    ],
  },
  ownRows: {
    op: "add_role",
    role: { name: "partner", label: "Партнёр", access: "login", loginMethods: ["email_otp"] },
    permissions: [
      {
        entity: "lead",
        ops: ["read", "create"],
        rowFilter: { created_by: "$user.id" },
        readonlyFields: ["status", "client"],
      },
    ],
  },
  fn: {
    op: "add_function",
    name: "leadStats",
    kind: "query",
    public: true,
    roles: ["owner", "staff"],
    source: LEAD_STATS_SOURCE,
  },
  automation: {
    op: "add_automation",
    name: "deal_won_tg",
    label: "Сделка выиграна — в Telegram",
    trigger: { type: "on_status", entity: "deal", field: "status", equals: "won" },
    steps: [
      { type: "notify", params: { integration: "tg", to: "$owner", text: "Сделка выиграна: {{link}}" } },
    ],
  },
} as const;

/** Operations the rules reject, with a word the Russian reason must contain. */
export const REJECTED: { name: string; op: Record<string, unknown>; reason: RegExp }[] = [
  {
    name: "add_field: a module field cannot change",
    op: { op: "add_field", entity: "lead", field: { name: "status", label: "Статус", type: "string" } },
    reason: /поля модулей не меняются/,
  },
  {
    name: "add_field: a required field without default would break the module's forms",
    op: {
      op: "add_field",
      entity: "lead",
      field: { name: "budget", label: "Бюджет", type: "money", required: true },
    },
    reason: /обязательное поле без значения по умолчанию/,
  },
  {
    name: "add_field: json is not an extension type",
    op: { op: "add_field", entity: "deal", field: { name: "raw", label: "Данные", type: "json" } },
    reason: /тип «json» расширению недоступен/,
  },
  {
    name: "add_field: special categories are not collected",
    op: {
      op: "add_field",
      entity: "client",
      field: { name: "diagnosis", label: "Диагноз", type: "string", pii: "special" },
    },
    reason: /особые категории/,
  },
  {
    name: "add_field: ПДн in an entity the visitors read",
    op: {
      op: "add_field",
      entity: "service",
      field: { name: "master_phone", label: "Телефон мастера", type: "phone" },
    },
    reason: /видны посетителям без входа/,
  },
  {
    name: "add_entity: a module entity cannot change",
    op: {
      op: "add_entity",
      entity: { name: "client", label: "Клиент", fields: [{ name: "x", label: "X", type: "string" }] },
    },
    reason: /сущности модулей не меняются/,
  },
  {
    name: "add_entity: visitors do not read personal data",
    op: {
      op: "add_entity",
      entity: {
        name: "courier",
        label: "Курьер",
        fields: [{ name: "phone", label: "Телефон", type: "phone" }],
      },
      grants: [{ role: "guest", ops: ["read"] }],
    },
    reason: /посетителю без входа их не показывают/,
  },
  {
    name: "add_role: create of leads is wider than the owner's matrix",
    op: {
      op: "add_role",
      role: { name: "agent", label: "Агент", access: "login", loginMethods: ["email_otp"] },
      permissions: [{ entity: "lead", ops: ["create"] }],
    },
    reason: /шире, чем у владельца.*только свои записи/,
  },
  {
    name: "add_role: the owner's hidden fields are hidden for the role too",
    op: {
      op: "add_role",
      role: { name: "auditor", label: "Аудитор", access: "login", loginMethods: ["email_otp"] },
      permissions: [{ entity: "client_package", ops: ["read"] }],
    },
    reason: /повторите его ограничения/,
  },
  {
    name: "add_role: no second administrator",
    op: {
      op: "add_role",
      role: { name: "boss", label: "Директор", access: "login", loginMethods: ["email_otp"], isAdmin: true },
      permissions: [{ entity: "deal", ops: ["read"] }],
    },
    reason: /Администратор у системы один/,
  },
  {
    name: "add_function: no egress yet",
    op: {
      op: "add_function",
      name: "syncCrm",
      kind: "action",
      roles: ["owner"],
      egress: ["api.example.ru"],
      source: LEAD_STATS_SOURCE,
    },
    reason: /egress/,
  },
  {
    name: "add_function: only functions/custom/**",
    op: {
      op: "add_function",
      name: "leadStats2",
      kind: "query",
      file: "functions/deals/leadStats2.ts",
      source: LEAD_STATS_SOURCE,
    },
    reason: /functions\/custom/,
  },
  {
    name: "add_function: no system access",
    op: {
      op: "add_function",
      name: "allLeads",
      kind: "query",
      roles: ["owner"],
      source: LEAD_STATS_SOURCE.replace("ctx.db.lead", "ctx.systemDb.lead"),
    },
    reason: /systemDb/,
  },
  {
    name: "add_function: a module function cannot change",
    op: { op: "add_function", name: "dealFunnel", kind: "query", source: LEAD_STATS_SOURCE },
    reason: /функции модулей не меняются/,
  },
  {
    name: "add_automation: no incoming webhooks yet",
    op: {
      op: "add_automation",
      name: "from_site",
      trigger: { type: "webhook", integration: "mail" },
      steps: [{ type: "wait", params: { minutes: 5 } }],
    },
    reason: /вебхуку/,
  },
  {
    name: "add_automation: no connector steps yet",
    op: {
      op: "add_automation",
      name: "push_crm",
      trigger: { type: "on_create", entity: "deal" },
      steps: [{ type: "connector", params: { integration: "tg", action: "sendToUser", input: {} } }],
    },
    reason: /внешних сервисов/,
  },
  {
    name: "add_automation: no AI steps",
    op: {
      op: "add_automation",
      name: "ai_title",
      trigger: { type: "on_create", entity: "deal" },
      steps: [{ type: "ai_generate", params: { action: "title" } }],
    },
    reason: /ИИ-действия/,
  },
  {
    name: "add_automation: no letters to visitors",
    op: {
      op: "add_automation",
      name: "lead_thanks",
      trigger: { type: "on_create", entity: "lead" },
      steps: [{ type: "notify", params: { integration: "mail", to: "$record.email", template: "new_lead" } }],
    },
    reason: /согласием на рассылку/,
  },
  {
    name: "add_automation: no ПДн in Telegram",
    op: {
      op: "add_automation",
      name: "lead_tg",
      trigger: { type: "on_create", entity: "lead" },
      steps: [{ type: "notify", params: { integration: "tg", to: "$owner", text: "Заявка от {{phone}}" } }],
    },
    reason: /в Telegram не отправляются персональные данные/,
  },
  {
    name: "add_automation: module functions run from their own automations",
    op: {
      op: "add_automation",
      name: "deal_again",
      trigger: { type: "on_status", entity: "lead", field: "status", equals: "in_work" },
      steps: [{ type: "function", params: { name: "dealFromLead", args: {} } }],
    },
    reason: /только свои функции/,
  },
  {
    name: "add_automation: a module automation cannot change",
    op: {
      op: "add_automation",
      name: "lead_notify",
      trigger: { type: "on_create", entity: "lead" },
      steps: [{ type: "wait", params: { minutes: 1 } }],
    },
    reason: /автоматизации модулей не меняются/,
  },
  {
    name: "not an extension operation",
    op: { op: "remove_field", entity: "lead", name: "phone" },
    reason: /не по схеме расширения/,
  },
];
