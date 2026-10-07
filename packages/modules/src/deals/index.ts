// Module «Воронка сделок» (specs/modules/modules.yaml#catalog deals, origin: deal and task of the D75 crm template,
// capabilities/crm.md): deals by stage on the StatusBoard, amount, the person in charge (with «Сотрудники и роли» —
// the staff member sees only own deals), tasks with a due date. Canonical names: entities deal, deal_task; deal status
// stage_1…stage_N, won, lost; links add deal.client (client_card) and deal.lead (leads).
import type { ModuleFragments, ModuleManifest } from "@wizard/appspec";
import type { ModuleDefinition } from "../types.js";
import { dealsBoardPage } from "./board.js";
import { compileDeals } from "./compile.js";
import { DEAL_FROM_LEAD, DEAL_FROM_LEAD_FILE, DEAL_FUNNEL, DEAL_FUNNEL_FILE } from "./functions.js";

const own = { assignee: "$user.id" };

const fragments: ModuleFragments = {
  permissions: [
    { value: { role: "$owner", entity: "deal", ops: ["read", "create", "update", "delete"] } },
    {
      when: { param: "with_tasks" },
      value: { role: "$owner", entity: "deal_task", ops: ["read", "create", "update", "delete"] },
    },
    // Without the person in charge the team shares the board; with it a staff member sees and moves only own deals.
    {
      when: { param: "assignees", equals: false },
      value: { role: "$staff", entity: "deal", ops: ["read", "create", "update"] },
    },
    {
      when: { param: "assignees" },
      value: {
        role: "$staff",
        entity: "deal",
        ops: ["read", "create", "update"],
        rowFilter: own,
        rowFilterOps: ["read", "update"],
      },
    },
    {
      when: { param: "with_tasks" },
      value: { role: "$staff", entity: "deal_task", ops: ["read", "create", "update"] },
    },
  ],
  acceptance: [
    {
      value: {
        text: "Посетитель без входа не видит сделки",
        check: { type: "permission", role: "$public", entity: "deal", op: "read", expect: "deny" },
      },
    },
    {
      value: {
        text: "Владелец переносит сделки по этапам",
        check: { type: "permission", role: "$owner", entity: "deal", op: "update", expect: "allow" },
      },
    },
  ],
};

export const dealsManifest: ModuleManifest = {
  id: "deals",
  version: 1,
  name: "Воронка сделок",
  summary: "Сделки по этапам на доске, суммы, задачи с напоминаниями, ответственные",
  status: "ready",
  order: 50,
  origin: { kind: "d75_template", ref: "шаблон crm (StatusBoard, deal, task), capabilities/crm.md" },
  goals: ["deal_pipeline"],
  params: [
    { name: "deal_label", label: "Как называть сделку", type: "string", maxLength: 40, default: "Сделка" },
    {
      name: "stages",
      label: "Этапы до результата",
      type: "string_list",
      maxItems: 8,
      maxLength: 40,
      default: ["Новая", "В работе", "Предложение"],
      description:
        "Этапы «Успешно» и «Отказ» модуль добавляет сам; значения enum — stage_1…stage_N, won, lost",
    },
    { name: "with_amount", label: "Сумма сделки", type: "bool", default: true },
    { name: "with_tasks", label: "Задачи со сроком", type: "bool", default: true },
    { name: "assignees", label: "Ответственные сотрудники", type: "bool", default: false },
  ],
  requires: [
    { module: "staff", reason: "ответственный — сотрудник со входом", when: { param: "assignees" } },
  ],
  links: [
    {
      module: "client_card",
      effect: "сделка ссылается на клиента",
      fragments: {
        fields: [
          {
            entity: "deal",
            value: {
              name: "client",
              label: "Клиент",
              type: "ref",
              ref: { entity: "client", onDelete: "set_null" },
            },
          },
        ],
      },
    },
    {
      module: "leads",
      effect: "сделка создаётся из заявки",
      fragments: {
        fields: [
          {
            entity: "deal",
            value: {
              name: "lead",
              label: "Заявка",
              type: "ref",
              ref: { entity: "lead", onDelete: "set_null" },
            },
          },
        ],
        workflows: [
          {
            value: {
              name: "deal_from_lead",
              label: "Заявка в работе — сделка на первом этапе",
              trigger: { type: "on_status", entity: "lead", field: "status", equals: "in_work" },
              steps: [{ type: "function", params: { name: "dealFromLead", args: { id: "$record.id" } } }],
            },
          },
        ],
      },
    },
    { module: "notify", effect: "напоминание ответственному о сроке задачи" },
  ],
  provides: { entities: ["deal", "deal_task"], routes: ["/deals"] },
  hook: true,
  fragments,
  functions: [
    {
      name: "dealFunnel",
      kind: "query",
      file: DEAL_FUNNEL_FILE,
      roles: ["$owner", "$staff"],
      purpose: "конверсия по этапам воронки за период для панели цели",
    },
    {
      name: "dealFromLead",
      kind: "mutation",
      file: DEAL_FROM_LEAD_FILE,
      roles: ["$owner"],
      when: { module: "leads" },
      purpose: "заявка, взятая в работу, становится сделкой на первом этапе",
    },
  ],
  screens: [
    {
      id: "board",
      audience: "cabinet",
      route: "/deals",
      title: "Воронка сделок",
      roles: ["$owner", "$staff"],
      components: ["StatusBoard", "RecordCard", "RecordForm", "DataTable", "Button"],
      nav: true,
    },
    {
      id: "deals",
      audience: "cabinet",
      route: "/cabinet",
      title: "Сделки и задачи",
      roles: ["$owner", "$staff"],
      components: ["CabinetLayout", "DataTable", "RecordCard", "RecordForm"],
    },
  ],
  metrics: [
    {
      id: "deals_new",
      label: "Новых сделок",
      goal: "deal_pipeline",
      unit: "count",
      better: "up",
      compute: { kind: "count", entity: "deal", dateField: "created_at" },
    },
    {
      id: "deals_stage_conversion",
      label: "Конверсия по этапам",
      goal: "deal_pipeline",
      unit: "percent",
      better: "up",
      description: "Доля сделок периода, дошедших до каждого этапа и до успеха (функция dealFunnel)",
      compute: { kind: "function", name: "dealFunnel" },
    },
    {
      id: "deals_won_share",
      label: "Конверсия в успешные",
      goal: "deal_pipeline",
      unit: "percent",
      better: "up",
      compute: {
        kind: "ratio",
        entity: "deal",
        dateField: "updated_at",
        numerator: { status: "won" },
        denominator: { status: ["won", "lost"] },
      },
    },
    {
      id: "deals_won_amount",
      label: "Сумма успешных сделок",
      goal: "deal_pipeline",
      unit: "rub",
      better: "up",
      when: { param: "with_amount" },
      compute: {
        kind: "sum",
        entity: "deal",
        field: "amount",
        dateField: "updated_at",
        where: { status: "won" },
      },
    },
    {
      id: "deals_repeat_clients",
      label: "Клиентов с повторными сделками",
      goal: "deal_pipeline",
      unit: "percent",
      better: "up",
      when: { module: "client_card" },
      compute: { kind: "repeat_share", entity: "deal", by: "client", dateField: "created_at" },
    },
  ],
  goalScenarios: [
    {
      id: "GS-deals-1",
      goal: "deal_pipeline",
      title: "Сделка переходит на следующий этап на доске",
      steps: [
        { actor: "owner", text: "Создаёт сделку на первом этапе" },
        { actor: "owner", text: "Переносит её на следующий этап" },
      ],
      expect: [{ kind: "status", text: "Сделка в колонке следующего этапа" }],
    },
    {
      id: "GS-deals-2",
      goal: "deal_pipeline",
      title: "Сотрудник видит только свои сделки",
      when: { param: "assignees" },
      withModules: ["staff"],
      steps: [
        { actor: "owner", text: "Назначает две сделки двум разным сотрудникам" },
        { actor: "staff", text: "Входит и открывает доску" },
      ],
      expect: [{ kind: "denied", text: "Чужой сделки на доске нет" }],
    },
    {
      id: "GS-deals-3",
      goal: "deal_pipeline",
      title: "Заявка, взятая в работу, появляется на доске сделок",
      withModules: ["leads"],
      steps: [
        { actor: "visitor", text: "Оставляет заявку на сайте" },
        { actor: "owner", text: "Переводит заявку в работу и открывает доску сделок" },
      ],
      expect: [{ kind: "status", text: "Сделка из заявки в колонке первого этапа" }],
    },
    {
      id: "GS-deals-4",
      goal: "deal_pipeline",
      title: "Сделка проходит все этапы до успеха, панель цели это видит",
      steps: [
        { actor: "owner", text: "Переносит сделку по всем этапам до «Успешно»" },
        { actor: "owner", text: "Открывает панель цели" },
      ],
      expect: [
        { kind: "status", text: "Сделка в колонке «Успешно»" },
        { kind: "metric", text: "Конверсия в успешные выросла" },
      ],
    },
  ],
  tests: {
    matrix: [
      { name: "по умолчанию", params: {} },
      {
        name: "свои этапы, без суммы и задач",
        params: {
          deal_label: "Проект",
          stages: ["Бриф", "Смета", "Договор", "Работа", "Сдача"],
          with_amount: false,
          with_tasks: false,
        },
      },
      { name: "один этап", params: { stages: ["Обсуждение"] } },
      { name: "ответственные сотрудники", params: { assignees: true }, withModules: ["staff"] },
      {
        name: "из заявок, с клиентами",
        params: {},
        withModules: ["landing", "leads", "notify", "client_card"],
      },
    ],
    gates: ["G0", "G1"],
  },
};

export const dealsModule: ModuleDefinition = {
  manifest: dealsManifest,
  compile: compileDeals,
  screens: { board: dealsBoardPage },
  files: { [DEAL_FROM_LEAD_FILE]: DEAL_FROM_LEAD, [DEAL_FUNNEL_FILE]: DEAL_FUNNEL },
};
