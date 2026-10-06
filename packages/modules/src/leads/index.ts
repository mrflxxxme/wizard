// Module «Заявки» (specs/modules/modules.yaml#catalog leads, origin: the D75 site template): the lead entity with
// consent-guarded contact fields, the visitor creates leads through the landing's LeadForm (data API, no functions),
// the owner and staff work with them in the cabinet (status new → in_work → done). Canonical names: entity `lead`,
// status values new | in_work | done — the goal-panel metrics rely on them.
import type { ModuleFragments, ModuleManifest } from "@wizard/appspec";
import type { ModuleContext, ModuleDefinition } from "../types.js";
import { compileLeads } from "./compile.js";

const FORM_FIELD_OPTIONS = [
  { value: "name", label: "Имя" },
  { value: "phone", label: "Телефон" },
  { value: "email", label: "Почта" },
  { value: "comment", label: "Комментарий" },
  { value: "preferred_time", label: "Удобное время" },
];

// The service choice (with_service) is added by compile.ts: field fragments apply before the hook creates `lead`.
const fragments: ModuleFragments = {
  permissions: [
    { value: { role: "$public", entity: "lead", ops: ["create"], readonlyFields: ["status"] } },
    { value: { role: "$owner", entity: "lead", ops: ["read", "update", "delete"] } },
    { value: { role: "$staff", entity: "lead", ops: ["read", "update"] } },
  ],
  acceptance: [
    {
      value: {
        text: "Посетитель без входа оставляет заявку",
        check: { type: "permission", role: "$public", entity: "lead", op: "create", expect: "allow" },
      },
    },
    {
      value: {
        text: "Посетитель без входа не читает заявки",
        check: { type: "permission", role: "$public", entity: "lead", op: "read", expect: "deny" },
      },
    },
    {
      value: {
        text: "Владелец видит заявки и меняет их статус",
        check: { type: "permission", role: "$owner", entity: "lead", op: "update", expect: "allow" },
      },
    },
  ],
};

export const leadsManifest: ModuleManifest = {
  id: "leads",
  version: 1,
  name: "Заявки",
  summary:
    "Форма заявки с согласием на сайте, список и статусы заявок у владельца, уведомление о новой заявке",
  status: "ready",
  order: 30,
  origin: {
    kind: "d75_template",
    ref: "шаблон site (LeadForm, кабинет DataTable/RecordCard), capabilities/site.md",
  },
  goals: ["leads"],
  params: [
    {
      name: "form_fields",
      label: "Поля формы",
      type: "enum_list",
      options: FORM_FIELD_OPTIONS,
      minItems: 1,
      default: ["name", "phone", "comment"],
    },
    {
      name: "contact",
      label: "Обязательный контакт",
      type: "enum",
      options: [
        { value: "phone", label: "Телефон" },
        { value: "email", label: "Почта" },
        { value: "any", label: "Телефон или почта" },
      ],
      default: "any",
    },
    { name: "with_service", label: "Выбор услуги в форме", type: "bool", default: false },
    { name: "extra_fields", label: "Дополнительные поля заявки", type: "fields", maxItems: 5 },
    {
      name: "retention_days",
      label: "Срок хранения заявок, дней",
      type: "int",
      min: 30,
      max: 1095,
      default: 365,
    },
  ],
  requires: [
    { module: "notify", reason: "владелец узнаёт о новой заявке письмом или в Telegram" },
    { module: "catalog", reason: "услуга в форме выбирается из каталога", when: { param: "with_service" } },
  ],
  links: [
    { module: "client_card", effect: "заявка создаёт или находит клиента; заявки видны в истории клиента" },
    { module: "deals", effect: "из заявки одной кнопкой создаётся сделка" },
  ],
  provides: { entities: ["lead"] },
  hook: true,
  fragments,
  screens: [
    {
      id: "leads",
      audience: "cabinet",
      route: "/cabinet",
      title: "Заявки",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
  ],
  metrics: [
    {
      id: "leads_count",
      label: "Новых заявок",
      goal: "leads",
      unit: "count",
      better: "up",
      compute: { kind: "count", entity: "lead", dateField: "created_at" },
    },
    {
      id: "leads_handled",
      label: "Заявок в работе или закрыто",
      goal: "leads",
      unit: "percent",
      better: "up",
      compute: {
        kind: "ratio",
        entity: "lead",
        dateField: "created_at",
        numerator: { status: ["in_work", "done"] },
      },
    },
  ],
  goalScenarios: [
    {
      id: "GS-leads-1",
      goal: "leads",
      title: "Посетитель оставил заявку, владелец увидел её и получил письмо",
      withModules: ["notify"],
      steps: [
        { actor: "visitor", text: "Заполняет форму заявки, отмечает согласие и отправляет" },
        { actor: "owner", text: "Открывает список заявок в кабинете" },
      ],
      expect: [
        { kind: "page_text", text: "Посетитель видит «Заявка отправлена»" },
        { kind: "record", text: "Заявка в списке владельца со статусом «новая»" },
        { kind: "outbox_email", text: "Владельцу ушло письмо о новой заявке" },
      ],
    },
    {
      id: "GS-leads-2",
      goal: "leads",
      title: "Посетитель не может читать чужие заявки",
      steps: [{ actor: "visitor", text: "Открывает адрес списка заявок без входа" }],
      expect: [{ kind: "denied", text: "Список заявок недоступен без входа" }],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию", params: {}, withModules: ["landing", "notify"] },
      {
        name: "только почта и свои поля",
        params: {
          form_fields: ["name", "email"],
          contact: "email",
          extra_fields: [
            { name: "budget", label: "Бюджет", type: "money" },
            {
              name: "source",
              label: "Откуда узнали",
              type: "enum",
              options: [
                { value: "search", label: "Поиск" },
                { value: "friends", label: "Знакомые" },
              ],
            },
          ],
        },
        withModules: ["landing", "notify"],
      },
      {
        name: "телефон обязателен, хотя его нет в списке полей",
        params: { form_fields: ["comment", "preferred_time"], contact: "phone", retention_days: 30 },
        withModules: ["landing", "notify"],
      },
      {
        name: "выбор услуги из каталога",
        params: { with_service: true },
        withModules: ["landing", "notify", "catalog"],
      },
    ],
    gates: ["G0", "G1"],
  },
};

const hasLeadForm = (ctx: ModuleContext) =>
  (ctx.plan.landing?.sections ?? []).some((s) => s.type === "lead_form");

export const leadsModule: ModuleDefinition = {
  manifest: leadsManifest,
  compile: compileLeads,
  warnings: (ctx) =>
    hasLeadForm(ctx)
      ? []
      : [
          "Форма заявки не стоит на лендинге: посетителю негде оставить заявку — добавьте секцию «Форма заявки»",
        ],
};
