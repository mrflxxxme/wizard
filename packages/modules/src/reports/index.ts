// Module «Отчёты и панель цели» (specs/modules/modules.yaml#catalog reports, origin: ui-kit StatsReport). It owns no
// entities: it aggregates the metrics the plan's modules declare (#manifest.metrics). The goal panel /cabinet/goals
// shows 3–6 tiles by the plan's goals (value for a week or a month, the plan's wording of the goal, the change against
// the period before) and reports by entity; the numbers come from the goalMetrics query (functions/goalMetrics.ts) —
// server-side, because sums and shares need every row of the period, which the paged data API does not give a page.
import type { ModuleFragments, ModuleManifest } from "@wizard/appspec";
import { NOTIFY_MAIL } from "../notify/compile.js";
import type { ModuleDefinition } from "../types.js";
import { GOAL_PANEL_LIB } from "./lib-source.js";
import { goalPanelPage } from "./page.js";
import {
  GOAL_METRICS_FILE,
  GOAL_METRICS_FN,
  goalMetricsFile,
  LIB_FUNCTIONS_FILE,
  LIB_UI_FILE,
} from "./query.js";

/** The weekly digest to the owner: Mondays 09:00 in the system's time zone (Europe/Moscow by default). */
export const DIGEST_CRON = "0 9 * * 1";

const digest = { param: "digest", equals: "weekly" };

const fragments: ModuleFragments = {
  integrations: [
    {
      when: digest,
      value: {
        name: NOTIFY_MAIL,
        connector: "email",
        config: {
          templates: {
            goal_digest: {
              subject: "Итоги недели по целям",
              body: "Неделя закончилась. Показатели по целям вашей системы — в кабинете, раздел «Панель цели»: {{link}}",
            },
          },
        },
      },
    },
  ],
  workflows: [
    {
      when: digest,
      value: {
        name: "goal_digest",
        label: "Сводка владельцу по целям",
        trigger: { type: "schedule", cron: DIGEST_CRON },
        steps: [
          {
            type: "notify",
            params: {
              integration: NOTIFY_MAIL,
              to: "$owner",
              template: "goal_digest",
              link: "/cabinet/goals",
            },
          },
        ],
      },
    },
  ],
};

export const reportsManifest: ModuleManifest = {
  id: "reports",
  version: 1,
  name: "Отчёты и панель цели",
  summary: "Панель цели с метриками модулей плана, отчёты по периодам, выгрузка CSV",
  status: "ready",
  order: 90,
  origin: { kind: "v1_code", ref: "ui-kit StatsReport" },
  goals: ["visibility"],
  params: [
    {
      name: "period",
      label: "Период по умолчанию",
      type: "enum",
      options: [
        { value: "week", label: "Неделя" },
        { value: "month", label: "Месяц" },
      ],
      default: "month",
    },
    { name: "export_csv", label: "Выгрузка в CSV", type: "bool", default: true },
    {
      name: "digest",
      label: "Сводка владельцу",
      type: "enum",
      options: [
        { value: "none", label: "Нет" },
        { value: "weekly", label: "Раз в неделю письмом" },
      ],
      default: "none",
    },
  ],
  requires: [
    { module: "notify", reason: "сводка уходит письмом", when: { param: "digest", equals: "weekly" } },
  ],
  provides: { routes: ["/cabinet/goals"] },
  fragments,
  functions: [
    {
      name: GOAL_METRICS_FN,
      kind: "query",
      file: GOAL_METRICS_FILE,
      public: true,
      roles: ["$owner"],
      purpose: "Метрики целей плана и отчёты по разделам за неделю или месяц и за период до него",
    },
  ],
  screens: [
    {
      id: "goals",
      audience: "cabinet",
      route: "/cabinet/goals",
      title: "Панель цели",
      roles: ["$owner"],
      components: ["CabinetLayout", "StatsReport", "Button", "EmptyState", "Loading"],
      nav: true,
    },
  ],
  metrics: [],
  goalScenarios: [
    {
      id: "GS-reports-1",
      goal: "visibility",
      title: "Владелец видит метрику по каждой цели плана",
      steps: [
        { actor: "system", text: "В систему загружены данные seed за месяц" },
        { actor: "owner", text: "Открывает панель цели" },
      ],
      expect: [{ kind: "metric", text: "По каждой цели плана есть метрика, числа совпадают с данными seed" }],
    },
    {
      id: "GS-reports-2",
      goal: "visibility",
      title: "Владелец переключает период и видит изменение к прошлому периоду",
      steps: [
        { actor: "owner", text: "Открывает панель цели и выбирает «Неделя»" },
        { actor: "owner", text: "Открывает раздел «Отчёты»" },
      ],
      expect: [
        { kind: "page_text", text: "У каждой плитки подписан прошлый период и рост или снижение" },
        { kind: "page_text", text: "У каждого раздела число новых записей и разбивка по статусам" },
      ],
    },
    {
      id: "GS-reports-3",
      goal: "visibility",
      title: "Без входа панель цели недоступна",
      steps: [{ actor: "visitor", text: "Открывает адрес панели цели без входа" }],
      expect: [{ kind: "denied", text: "Панель и её данные недоступны без входа владельца" }],
    },
    {
      id: "GS-reports-4",
      goal: "visibility",
      title: "Раз в неделю владельцу приходит письмо со сводкой",
      when: { param: "digest", equals: "weekly" },
      withModules: ["notify"],
      steps: [{ actor: "system", text: "Время сдвигается на понедельник, 9:00" }],
      expect: [{ kind: "outbox_email", text: "Владельцу ушло письмо «Итоги недели по целям»" }],
    },
  ],
  tests: {
    matrix: [
      {
        name: "по умолчанию: с лендингом и заявками",
        params: {},
        withModules: ["landing", "leads", "notify"],
      },
      {
        name: "неделя, без выгрузки CSV",
        params: { period: "week", export_csv: false },
        withModules: ["leads", "notify", "landing"],
      },
      {
        name: "сводка письмом раз в неделю",
        params: { digest: "weekly" },
        withModules: ["leads", "notify", "landing"],
      },
      { name: "без других модулей", params: {} },
    ],
    gates: ["G0", "G1"],
  },
};

export const reportsModule: ModuleDefinition = {
  manifest: reportsManifest,
  screens: { goals: goalPanelPage },
  files: {
    [GOAL_METRICS_FILE]: goalMetricsFile,
    [LIB_FUNCTIONS_FILE]: GOAL_PANEL_LIB,
    [LIB_UI_FILE]: GOAL_PANEL_LIB,
  },
  warnings: (ctx) =>
    ctx.plan.modules.length === 1
      ? [
          "В плане нет других модулей: панели цели нечего показывать — добавьте модули, которые закрывают цели плана",
        ]
      : [],
};
