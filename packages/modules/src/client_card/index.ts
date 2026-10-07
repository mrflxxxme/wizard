// Module «Клиенты с историей» (specs/modules/modules.yaml#catalog client_card, origin: the client of the D75 crm
// template, capabilities/crm.md): the client entity (personal data marked pii, retention from the plan), notes of the
// staff, the client list in the role cabinet and the «Клиенты» page with the card and the history of the client's
// records in other modules. Canonical names: entities client, client_note; the ref field to the client in other
// modules' entities is `client` — the history and the repeat-client metrics rely on it.
import type { ModuleFragments, ModuleManifest } from "@wizard/appspec";
import type { ModuleDefinition } from "../types.js";
import { compileClientCard, requiredExtra } from "./compile.js";
import { CLIENT_FROM_LEAD, CLIENT_FROM_LEAD_FILE } from "./functions.js";
import { clientHistoryPage } from "./history.js";

const fragments: ModuleFragments = {
  permissions: [
    { value: { role: "$owner", entity: "client", ops: ["read", "create", "update", "delete"] } },
    { value: { role: "$staff", entity: "client", ops: ["read", "create", "update"] } },
    {
      when: { param: "notes" },
      value: { role: "$owner", entity: "client_note", ops: ["read", "create", "update", "delete"] },
    },
    { when: { param: "notes" }, value: { role: "$staff", entity: "client_note", ops: ["read", "create"] } },
  ],
  acceptance: [
    {
      value: {
        text: "Посетитель без входа не видит клиентов и их контакты",
        check: { type: "permission", role: "$public", entity: "client", op: "read", expect: "deny" },
      },
    },
    {
      value: {
        text: "Владелец ведёт карточки клиентов",
        check: { type: "permission", role: "$owner", entity: "client", op: "update", expect: "allow" },
      },
    },
    {
      when: { param: "notes" },
      value: {
        text: "Сотрудник добавляет заметку в карточку клиента",
        check: { type: "permission", role: "$staff", entity: "client_note", op: "create", expect: "allow" },
      },
    },
  ],
};

/** Link to «Заявки»: the lead refers to its client (the workflow that fills it comes from compile.ts). */
const leadsLink: ModuleFragments = {
  fields: [
    {
      entity: "lead",
      value: {
        name: "client",
        label: "Клиент",
        type: "ref",
        ref: { entity: "client", onDelete: "set_null" },
      },
    },
  ],
  permissions: [
    // The visitor leaving a lead must not attach it to somebody else's card.
    { value: { role: "$public", entity: "lead", ops: ["create"], readonlyFields: ["client"] } },
  ],
};

export const clientCardManifest: ModuleManifest = {
  id: "client_card",
  version: 1,
  name: "Клиенты с историей",
  summary:
    "База клиентов с карточкой: контакты, заметки, метки и история записей, заявок, сделок и абонементов",
  status: "ready",
  order: 15,
  origin: {
    kind: "d75_template",
    ref: "сущность client шаблона crm, ui-kit RecordCard, DataTable, capabilities/crm.md",
  },
  goals: ["client_history"],
  params: [
    { name: "client_label", label: "Как называть клиента", type: "string", maxLength: 40, default: "Клиент" },
    {
      name: "match_by",
      label: "Узнавать клиента по",
      type: "enum",
      options: [
        { value: "phone", label: "Телефону" },
        { value: "email", label: "Почте" },
      ],
      default: "phone",
    },
    { name: "tags", label: "Метки клиентов", type: "string_list", maxItems: 10, maxLength: 30, default: [] },
    { name: "notes", label: "Заметки сотрудников", type: "bool", default: true },
    { name: "extra_fields", label: "Дополнительные поля клиента", type: "fields", maxItems: 8 },
    {
      name: "retention_days",
      label: "Срок хранения данных клиента, дней",
      type: "int",
      min: 180,
      max: 3650,
      default: 1095,
    },
  ],
  links: [
    { module: "booking", effect: "визиты клиента в карточке, клиент находится по контакту при записи" },
    { module: "deals", effect: "сделки клиента в карточке" },
    { module: "packages", effect: "абонементы и остаток визитов в карточке" },
    {
      module: "leads",
      effect: "заявка находит или создаёт клиента по контакту; заявки видны в истории клиента",
      fragments: leadsLink,
    },
  ],
  provides: { entities: ["client", "client_note"], routes: ["/clients"] },
  hook: true,
  fragments,
  functions: [
    {
      name: "clientFromLead",
      kind: "mutation",
      file: CLIENT_FROM_LEAD_FILE,
      roles: ["$owner"],
      when: { module: "leads" },
      purpose: "новая заявка находит клиента по телефону или почте или создаёт его",
    },
  ],
  screens: [
    {
      id: "clients",
      audience: "cabinet",
      route: "/cabinet",
      title: "Клиенты",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
    {
      id: "history",
      audience: "cabinet",
      route: "/clients",
      title: "Клиенты и история",
      roles: ["$owner", "$staff"],
      components: ["DataTable", "RecordCard", "RecordForm", "Button"],
      nav: true,
    },
  ],
  metrics: [
    {
      id: "new_clients",
      label: "Новых клиентов",
      goal: "client_history",
      unit: "count",
      better: "up",
      compute: { kind: "count", entity: "client", dateField: "created_at" },
    },
    {
      id: "returning_clients",
      label: "Вернувшихся клиентов",
      goal: "client_history",
      unit: "percent",
      better: "up",
      when: { module: "booking" },
      compute: { kind: "repeat_share", entity: "booking", by: "client", dateField: "starts_at" },
    },
    {
      id: "repeat_lead_clients",
      label: "Клиентов с повторными заявками",
      goal: "client_history",
      unit: "percent",
      better: "up",
      when: { module: "leads" },
      compute: { kind: "repeat_share", entity: "lead", by: "client", dateField: "created_at" },
    },
  ],
  goalScenarios: [
    {
      id: "GS-client_card-1",
      goal: "client_history",
      title: "Владелец открывает карточку клиента и видит все его визиты",
      withModules: ["booking", "catalog", "notify"],
      steps: [
        { actor: "visitor", text: "Дважды записывается с одним и тем же контактом" },
        { actor: "owner", text: "Открывает клиента в списке клиентов" },
      ],
      expect: [
        { kind: "record", text: "Клиент один, без дубля" },
        { kind: "page_text", text: "В карточке клиента обе записи с датами" },
      ],
    },
    {
      id: "GS-client_card-2",
      goal: "client_history",
      title: "Две заявки с одним телефоном — один клиент, обе заявки в его истории",
      withModules: ["leads"],
      steps: [
        { actor: "visitor", text: "Дважды оставляет заявку с одним и тем же телефоном" },
        { actor: "owner", text: "Открывает страницу «Клиенты и история» и выбирает клиента" },
      ],
      expect: [
        { kind: "record", text: "Клиент один, без дубля" },
        { kind: "page_text", text: "В разделе «Заявки» карточки обе заявки" },
      ],
    },
    {
      id: "GS-client_card-3",
      goal: "client_history",
      title: "Сделка клиента видна в его карточке",
      withModules: ["deals"],
      steps: [
        { actor: "owner", text: "Создаёт сделку и выбирает в ней клиента" },
        { actor: "owner", text: "Открывает карточку этого клиента" },
      ],
      expect: [{ kind: "page_text", text: "В разделе «Сделки» карточки есть эта сделка" }],
    },
    {
      id: "GS-client_card-4",
      goal: "client_history",
      title: "Посетитель без входа не видит базу клиентов",
      steps: [{ actor: "visitor", text: "Открывает адрес страницы клиентов без входа" }],
      expect: [{ kind: "denied", text: "Страница и данные клиентов недоступны без входа" }],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию", params: {} },
      {
        name: "по почте, метки и свои поля, без заметок",
        params: {
          client_label: "Пациент",
          match_by: "email",
          tags: ["Постоянный", "Новый", "Важный"],
          notes: false,
          extra_fields: [
            { name: "company", label: "Компания", type: "string" },
            {
              name: "source",
              label: "Откуда пришёл",
              type: "enum",
              required: true,
              options: [
                { value: "site", label: "Сайт" },
                { value: "friends", label: "Знакомые" },
              ],
            },
            { name: "discount", label: "Скидка, %", type: "int" },
          ],
          retention_days: 365,
        },
      },
      {
        name: "с заявками и сделками: история и один клиент на контакт",
        params: {},
        withModules: ["landing", "leads", "notify", "deals"],
      },
      {
        name: "по почте, а в заявке только телефон",
        params: { match_by: "email" },
        withModules: ["leads", "notify", "landing"],
      },
    ],
    gates: ["G0", "G1"],
  },
};

export const clientCardModule: ModuleDefinition = {
  manifest: clientCardManifest,
  compile: compileClientCard,
  screens: { history: clientHistoryPage },
  files: { [CLIENT_FROM_LEAD_FILE]: CLIENT_FROM_LEAD },
  warnings: (ctx) =>
    ctx.present.has("leads") && requiredExtra(ctx)
      ? [
          "У клиента есть обязательные дополнительные поля: заявка находит только уже заведённого клиента, новых клиентов владелец заводит сам",
        ]
      : [],
};
