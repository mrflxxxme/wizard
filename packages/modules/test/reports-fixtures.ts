// Fixture of the goal-panel tests: a ready module «Продажи» (fx_sales) declaring a metric of every kind — count, ratio,
// sum, avg, repeat_share over a date-time field with its own index, count over a date field (index) and over
// updated_at (no index — read newest first), and a function metric with its query — plus a plan with «Отчёты».
import type { ModuleManifest, SystemPlan } from "@wizard/appspec";
import type { ModuleDefinition } from "../src/index.js";
import { fx } from "./fixtures.js";

type Metric = ModuleManifest["metrics"][number];
const m = (
  id: string,
  label: string,
  unit: Metric["unit"],
  better: Metric["better"],
  compute: Metric["compute"],
) => ({ id, label, goal: "retention", unit, better, compute }) as Metric;
const sale = { entity: "sale", dateField: "sold_at" } as const;

export const SALES_METRICS: Metric[] = [
  m("sales_paid", "Оплаченных продаж", "count", "up", { kind: "count", ...sale, where: { status: "paid" } }),
  m("sales_refunds", "Доля возвратов", "percent", "down", {
    kind: "ratio",
    ...sale,
    numerator: { status: "refunded" },
    denominator: { status: ["paid", "refunded"] },
  }),
  m("sales_sum", "Выручка", "rub", "up", {
    kind: "sum",
    ...sale,
    field: "amount",
    where: { status: "paid" },
  }),
  m("sales_avg", "Средний чек", "rub", "up", {
    kind: "avg",
    ...sale,
    field: "amount",
    where: { status: "paid" },
  }),
  m("sales_repeat", "Повторные покупатели", "percent", "up", { kind: "repeat_share", ...sale, by: "client" }),
  m("sales_days", "Продаж по дням", "count", "up", { kind: "count", entity: "sale", dateField: "sold_on" }),
  m("sales_touched", "Изменённых продаж", "count", "up", {
    kind: "count",
    entity: "sale",
    dateField: "updated_at",
  }),
  m("sales_target", "Выполнение плана продаж", "percent", "up", { kind: "function", name: "fxSalesTarget" }),
];

/** The function metric's query: {period} → {value, previous} (the contract of compute.kind = function). */
export const SALES_TARGET_SOURCE = [
  'import { query, v } from "@wizard/sdk";',
  "",
  "export default query({",
  '  args: { period: v.enum("week", "month") },',
  '  handler: async (_ctx, args) => ({ value: args.period === "week" ? 40 : 75, previous: 50 }),',
  "});",
  "",
].join("\n");

export function salesManifest(opts: { functionFirst?: boolean } = {}): ModuleManifest {
  const target = SALES_METRICS.at(-1) as Metric;
  return fx({
    id: "fx_sales",
    name: "Продажи (фикстура)",
    goals: ["retention"],
    params: [],
    provides: { entities: ["sale"] },
    fragments: {
      entities: [
        {
          value: {
            name: "sale",
            label: "Продажа",
            fields: [
              { name: "amount", label: "Сумма", type: "money" },
              { name: "client", label: "Код покупателя", type: "string", maxLength: 40 },
              {
                name: "status",
                label: "Статус",
                type: "enum",
                required: true,
                default: "paid",
                enum: [
                  { value: "paid", label: "Оплачена" },
                  { value: "refunded", label: "Возврат" },
                ],
              },
              { name: "sold_at", label: "Время продажи", type: "datetime" },
              { name: "sold_on", label: "День продажи", type: "date" },
            ],
            indexes: [{ fields: ["sold_at"] }, { fields: ["sold_on"] }],
          },
        },
      ],
      permissions: [
        { value: { role: "$owner", entity: "sale", ops: ["read", "create", "update", "delete"] } },
      ],
    },
    functions: [
      {
        name: "fxSalesTarget",
        kind: "query",
        file: "functions/fxSalesTarget.ts",
        public: true,
        roles: ["$owner"],
        purpose: "Выполнение плана продаж (тестовая метрика-функция)",
      },
    ],
    screens: [
      {
        id: "items",
        audience: "cabinet",
        route: "/cabinet",
        title: "Продажи",
        roles: ["$owner"],
        components: ["DataTable"],
      },
    ],
    metrics: opts.functionFirst ? [target, ...SALES_METRICS.slice(0, -1)] : SALES_METRICS,
    goalScenarios: [
      {
        id: "GS-fx_sales-1",
        goal: "retention",
        title: "Владелец видит продажи",
        steps: [{ actor: "owner", text: "Открывает кабинет" }],
        expect: [{ kind: "record", text: "Продажи видны" }],
      },
    ],
  });
}

export function salesModule(opts: { functionFirst?: boolean } = {}): ModuleDefinition {
  return { manifest: salesManifest(opts), files: { "functions/fxSalesTarget.ts": SALES_TARGET_SOURCE } };
}

export function salesPlan(): SystemPlan {
  return {
    version: 1,
    niche: "магазин посуды",
    goals: [
      { id: "retention", statement: "Покупатели возвращаются за новыми покупками" },
      { id: "visibility", statement: "Видеть выручку и возвраты в цифрах" },
    ],
    modules: [{ id: "fx_sales" }, { id: "reports" }],
    design: {
      direction: { mood: ["спокойствие"] },
      theme: "calm",
      accent: "#2A7F9E",
      fontPair: { heading: "Manrope", body: "Inter Tight" },
      photoStyle: "светлые фото",
    },
    outOfScope: [],
    custom: [],
  };
}
