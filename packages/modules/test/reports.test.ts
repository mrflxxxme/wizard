// B2-17 «Отчёты и панель цели»: the goal-panel library on fixture rows (every metric kind, both periods, trends,
// entity reports, the row budget, CSV), the panel model (tiles by the plan's goals, sources) and the generated query
// and page. The same numbers through a real runtime — reports.gates.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type CompiledMetric,
  type CompileSuccess,
  compilePlan,
  GOAL_PANEL_LIB,
  type MetricCompute,
  type ModuleDefinition,
  NOTIFY_MAIL,
  PANEL_VIEW,
  pickTiles,
} from "../src/index.js";
import {
  collect,
  computeValue,
  csvOf,
  entityReport,
  formatValue,
  isoDate,
  metricValues,
  periodWindows,
  type Row,
  rowTime,
  trendOf,
  trendText,
} from "../src/reports/lib/goalPanel.js";
import { landingLeadsPlan, testRegistry } from "./fixtures.js";
import { salesModule, salesPlan } from "./reports-fixtures.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW - days * DAY).toISOString();
const w = periodWindows("week", NOW);

/** Sales of the fixture: the current week (days 0–6 back) and the previous one (7–13 back). */
const SALES: Row[] = [
  { status: "paid", amount: 1000, client: "c1", sold_at: at(0.04), sold_on: isoDate(NOW - DAY) },
  { status: "paid", amount: 3000, client: "c1", sold_at: at(1), sold_on: isoDate(NOW - 3 * DAY) },
  { status: "refunded", amount: 500, client: "c2", sold_at: at(2), sold_on: isoDate(NOW - 3 * DAY) },
  { status: "paid", amount: "2000", client: "c3", sold_at: at(3), sold_on: null },
  { status: "paid", amount: null, client: null, sold_at: at(6.9), sold_on: isoDate(NOW - 6 * DAY) },
  { status: "paid", amount: 4000, client: "c1", sold_at: at(10), sold_on: isoDate(NOW - 10 * DAY) },
  { status: "refunded", amount: 100, client: "c4", sold_at: at(9), sold_on: isoDate(NOW - 9 * DAY) },
  { status: "paid", amount: 9999, client: "c9", sold_at: at(14.5), sold_on: isoDate(NOW - 20 * DAY) },
  { status: "paid", amount: 7777, client: "c9", sold_at: at(-1), sold_on: isoDate(NOW + DAY) },
];
const sale = { entity: "sale", dateField: "sold_at" } as const;
const values = (c: MetricCompute) => metricValues(c, SALES, w);

describe("metric kinds on fixture rows (current week / the week before)", () => {
  test("count, with and without where; a list in where is membership", () => {
    expect(values({ kind: "count", ...sale })).toEqual({ value: 5, previous: 2, base: 5 });
    expect(values({ kind: "count", ...sale, where: { status: "paid" } })).toEqual({
      value: 4,
      previous: 1,
      base: 4,
    });
    expect(values({ kind: "count", ...sale, where: { status: ["paid", "refunded"], client: "c1" } })).toEqual(
      {
        value: 2,
        previous: 1,
        base: 2,
      },
    );
  });

  test("ratio: % of the denominator that matches the numerator; without denominator — of all rows; empty → null", () => {
    expect(
      values({
        kind: "ratio",
        ...sale,
        numerator: { status: "refunded" },
        denominator: { status: ["paid", "refunded"] },
      }),
    ).toEqual({ value: 20, previous: 50, base: 5 });
    expect(values({ kind: "ratio", ...sale, numerator: { client: "c1" } })).toEqual({
      value: 40,
      previous: 50,
      base: 5,
    });
    expect(computeValue({ kind: "ratio", ...sale, numerator: { status: "paid" } }, [])).toBeNull();
  });

  test("sum and avg of the field's numbers (strings of digits count, empty values are skipped)", () => {
    expect(values({ kind: "sum", ...sale, field: "amount", where: { status: "paid" } })).toEqual({
      value: 6000,
      previous: 4000,
      base: 4,
    });
    expect(values({ kind: "avg", ...sale, field: "amount", where: { status: "paid" } })).toEqual({
      value: 2000,
      previous: 4000,
      base: 4,
    });
    expect(computeValue({ kind: "avg", ...sale, field: "amount" }, [{ amount: null }])).toBeNull();
    expect(computeValue({ kind: "sum", ...sale, field: "amount" }, [])).toBe(0);
    expect(computeValue({ kind: "avg", ...sale, field: "amount" }, [{ amount: 1 }, { amount: 2 }])).toBe(1.5);
  });

  test("repeat_share: % of distinct values met at least twice (empty values skipped)", () => {
    expect(values({ kind: "repeat_share", ...sale, by: "client" })).toEqual({
      value: 33.3,
      previous: 0,
      base: 4,
    });
    expect(computeValue({ kind: "repeat_share", ...sale, by: "client" }, [{ client: null }])).toBeNull();
  });

  test("a date field without time: days in Moscow time; the 7 days up to today belong to the week", () => {
    expect(values({ kind: "count", entity: "sale", dateField: "sold_on" })).toEqual({
      value: 4,
      previous: 2,
      base: 4,
    });
    expect(rowTime("2026-10-06")).toBe(Date.parse("2026-10-05T21:00:00Z"));
    expect(isoDate(Date.parse("2026-10-05T21:30:00Z"))).toBe("2026-10-06");
    expect(rowTime("")).toBeNull();
    expect(rowTime("не дата")).toBeNull();
  });

  test("function metrics are computed by their module's query, not from rows", () => {
    expect(values({ kind: "function", name: "scheduleLoad" })).toEqual({
      value: null,
      previous: null,
      base: null,
    });
  });

  test("periods: rolling 7 and 30 days, compared with the span right before", () => {
    expect(periodWindows("month", NOW)).toEqual({
      current: { from: NOW - 30 * DAY, to: NOW },
      previous: { from: NOW - 60 * DAY, to: NOW - 30 * DAY },
    });
    expect(metricValues({ kind: "count", ...sale }, SALES, periodWindows("month", NOW))).toEqual({
      value: 8,
      previous: 0,
      base: 8,
    });
  });
});

describe("trends, entity reports, the row budget, texts", () => {
  test("trend: direction and whether it goes the better way", () => {
    expect(trendOf(12, 10, "up")).toEqual({ delta: 2, direction: "up", good: true });
    expect(trendOf(20, 50, "down")).toEqual({ delta: -30, direction: "down", good: true });
    expect(trendOf(5, 5, "up")).toEqual({ delta: 0, direction: "flat", good: null });
    expect(trendOf(null, 5, "up")).toEqual({ delta: null, direction: null, good: null });
  });

  test("entity report: records created per period and the current one by status", () => {
    const rows = SALES.map((r) => ({ ...r, created_at: r.sold_at }));
    expect(entityReport(rows, "status", ["paid", "refunded", "void"], w)).toEqual({
      total: 5,
      previous: 2,
      byStatus: [
        { value: "paid", count: 4 },
        { value: "refunded", count: 1 },
        { value: "void", count: 0 },
      ],
    });
    expect(entityReport(rows, null, [], w).byStatus).toEqual([]);
  });

  test("collect reads pages while the shared budget lasts and says when it stopped early", async () => {
    const pages = (n: number) => async (cursor: string | null, numItems: number) => {
      const from = Number(cursor ?? 0);
      const items = Array.from({ length: Math.min(numItems, n - from) }, (_, i) => ({ i: from + i }));
      const next = from + items.length;
      return { items, continueCursor: next < n ? String(next) : null, isDone: next >= n };
    };
    const budget = { left: 450 };
    const a = await collect(pages(300), budget);
    expect([a.rows.length, a.capped, budget.left]).toEqual([300, false, 150]);
    const b = await collect(pages(1000), budget);
    expect([b.rows.length, b.capped, budget.left]).toEqual([150, true, 0]);
    expect((await collect(pages(5), budget)).capped).toBe(true);
  });

  test("texts for people: values with units, the line under a tile, CSV for spreadsheets", () => {
    expect(formatValue(12, "count")).toBe("12");
    expect(formatValue(38.5, "percent")).toBe("38,5 %");
    expect(formatValue(9900, "rub")).toBe("9 900 ₽");
    expect(formatValue(null, "minutes")).toBe("—");
    expect(trendText(12, 10, "count", "up")).toBe("Прошлый период: 10 · рост на 2 — хорошо");
    expect(trendText(20, 50, "percent", "down")).toBe(
      "Прошлый период: 50 % · снижение на 30 пунктов — хорошо",
    );
    expect(trendText(52, 50, "percent", "down")).toBe(
      "Прошлый период: 50 % · рост на 2 пункта — хуже, чем было",
    );
    expect(trendText(8, 10, "count", "up")).toBe("Прошлый период: 10 · снижение на 2 — хуже, чем было");
    expect(trendText(5, 5, "rub", "up")).toBe("Прошлый период: 5 ₽ · без изменений");
    expect(trendText(5, null, "count", "up")).toBe("Прошлый период: —");
    expect(csvOf([["Показатель", "Значение"], ['Выручка; "чистая"', 100], [null]])).toBe(
      '﻿Показатель;Значение\r\n"Выручка; ""чистая""";100\r\n\r\n',
    );
  });

  test("lib-source.ts is up to date (node packages/modules/scripts/gen-reports-lib.mjs)", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    expect(GOAL_PANEL_LIB).toBe(readFileSync(join(here, "../src/reports/lib/goalPanel.ts"), "utf8"));
  });
});

const metric = (id: string, goal: string, planGoal: boolean): CompiledMetric => ({
  id,
  label: id,
  goal: goal as CompiledMetric["goal"],
  unit: "count",
  better: "up",
  compute: { kind: "count", entity: "x", dateField: "created_at" },
  module: "m",
  planGoal,
});

describe("goal panel: tiles by the plan's goals", () => {
  test("round-robin over the plan's goals, at most 6; fewer than 3 — filled with other goals' metrics", () => {
    const ms = [
      metric("a1", "leads", true),
      metric("a2", "leads", true),
      metric("a3", "leads", true),
      metric("a4", "leads", true),
      metric("b1", "retention", true),
      metric("o1", "stay_informed", false),
      metric("c1", "fill_schedule", true),
      metric("c2", "fill_schedule", true),
      metric("c3", "fill_schedule", true),
    ];
    const order = ["fill_schedule", "leads", "retention"];
    expect(pickTiles(ms, order).map((m) => m.id)).toEqual(["c1", "c2", "c3", "a1", "a2", "b1"]);
    expect(
      pickTiles([metric("a1", "leads", true), ms[5] as CompiledMetric], ["leads"]).map((m) => m.id),
    ).toEqual(["a1", "o1"]);
    expect(pickTiles([], ["leads"])).toEqual([]);
  });

  function compiled(plan: unknown, registry = testRegistry()): CompileSuccess {
    const r = compilePlan(plan, registry, { appName: "Улыбка" });
    if (!r.ok) throw new Error(JSON.stringify(r.errors, null, 2));
    return r;
  }

  test("«лендинг + заявки + отчёты»: the panel shows the metrics of the plan's goals under the client's wording", () => {
    const plan = landingLeadsPlan();
    plan.goals = [
      { id: "leads", statement: "Пациенты оставляют заявки на сайте, и мы их не теряем" },
      { id: "visibility", statement: "Видеть, сколько заявок пришло за неделю" },
    ];
    plan.modules.push({ id: "reports", params: { period: "week" } });
    const r = compiled(plan);
    const page = r.files["ui/pages/ReportsGoals.tsx"] ?? "";
    const fn = r.files["functions/goalMetrics.ts"] ?? "";
    expect(r.spec.pages?.find((p) => p.route === "/cabinet/goals")).toEqual({
      route: "/cabinet/goals",
      title: "Панель цели",
      file: "ui/pages/ReportsGoals.tsx",
      roles: ["owner"],
      nav: true,
    });
    expect(r.spec.functions?.find((f) => f.name === "goalMetrics")).toEqual({
      name: "goalMetrics",
      kind: "query",
      file: "functions/goalMetrics.ts",
      public: true,
      roles: ["owner"],
    });
    expect(r.files["functions/lib/goalPanel.ts"]).toBe(GOAL_PANEL_LIB);
    expect(r.files["ui/lib/goalPanel.ts"]).toBe(GOAL_PANEL_LIB);
    // Tiles: both lead metrics under the plan's goal «leads», in the page and in the query.
    expect(page).toContain(
      '{ id: "leads_count", label: "Новых заявок", unit: "count", better: "up", goalText: "Пациенты оставляют заявки на сайте, и мы их не теряем" }',
    );
    expect(page).toContain('{ id: "leads_handled", label: "Заявок в работе или закрыто", unit: "percent"');
    expect(page).toContain(
      '{ key: "leads", title: "Цель: Пациенты оставляют заявки на сайте, и мы их не теряем", tiles: [TILES[0] as Tile, TILES[1] as Tile] }',
    );
    expect(page).toContain('useState<Period>("week")');
    expect(page).toContain("const CSV = true;");
    expect(page).toContain('{ entity: "lead", label: "Заявка", statuses: [{"value":"new","label":"Новая"}');
    expect(page.endsWith(PANEL_VIEW)).toBe(true);
    expect(fn).toContain(
      '{ id: "leads_count", compute: {"kind":"count","entity":"lead","dateField":"created_at"}, source: 0 },',
    );
    expect(fn).toContain(
      "sources[0] = await collect((cursor, numItems) => ctx.db.lead.paginate({ where: { created_at: { gte: from, lt: to } }",
    );
    expect(r.metrics.filter((m) => m.planGoal).map((m) => m.id)).toEqual(["leads_count", "leads_handled"]);
    expect(r.warnings).not.toContain(
      "В плане нет других модулей: панели цели нечего показывать — добавьте модули, которые закрывают цели плана",
    );
  });

  test("weekly digest goes through notify's e-mail integration: one integration, both modules' templates", () => {
    const plan = landingLeadsPlan();
    plan.modules.push({ id: "reports", params: { digest: "weekly" } });
    const r = compiled(plan);
    const mail = (r.spec.integrations ?? []).filter((i) => i.connector === "email");
    expect(mail.map((i) => i.name)).toEqual([NOTIFY_MAIL]);
    const templates = Object.keys((mail[0]?.config as { templates?: object } | undefined)?.templates ?? {});
    expect(templates).toEqual(expect.arrayContaining(["new_lead", "goal_digest"]));
    const digest = r.spec.workflows?.find((wf) => wf.name === "goal_digest");
    expect(digest?.steps).toEqual([
      {
        type: "notify",
        params: { integration: NOTIFY_MAIL, to: "$owner", template: "goal_digest", link: "/cabinet/goals" },
      },
    ]);
    // notify only in Telegram: the digest still has its e-mail integration under the same name.
    const tgOnly = landingLeadsPlan();
    const notify = tgOnly.modules.find((m) => m.id === "notify");
    if (notify) notify.params = { channels: ["telegram"] };
    tgOnly.modules.push({ id: "reports", params: { digest: "weekly" } });
    const t = compiled(tgOnly);
    expect((t.spec.integrations ?? []).filter((i) => i.connector === "email").map((i) => i.name)).toEqual([
      NOTIFY_MAIL,
    ]);
  });

  test("sources: created_at by its index, a dated field by its own index, a field without one — newest first", () => {
    const r = compiled(salesPlan(), testRegistry([salesModule()]));
    const fn = r.files["functions/goalMetrics.ts"] ?? "";
    expect(fn).toContain('ctx.db.sale.paginate({ where: { sold_at: { gte: from, lt: to } }, order: "asc" }');
    expect(fn).toContain(
      'ctx.db.sale.paginate({ where: { sold_on: { gte: isoDate(w.previous.from), lte: isoDate(w.current.to) } }, order: "asc" }',
    );
    expect(fn).toContain('ctx.db.sale.paginate({ order: "desc" }');
    expect(fn).toContain(
      'ctx.db.sale.paginate({ where: { created_at: { gte: from, lt: to } }, order: "asc" }',
    );
    // Ranged reads first, the scan (source 2) last: it takes what is left of the row budget.
    expect([...fn.matchAll(/^ {4}sources\[(\d)\] = /gm)].map((m) => Number(m[1]))).toEqual([0, 1, 3, 2]);
    const page = r.files["ui/pages/ReportsGoals.tsx"] ?? "";
    // 8 metrics of one plan goal: 6 tiles; the function metric is asked from its own query.
    expect([...page.matchAll(/^ {2}\{ id: "(\w+)"/gm)].map((m) => m[1])).toEqual([
      "sales_paid",
      "sales_refunds",
      "sales_sum",
      "sales_avg",
      "sales_repeat",
      "sales_days",
    ]);
    // Every data metric is computed, not only the tiles.
    expect([...fn.matchAll(/^ {2}\{ id: "(\w+)"/gm)].map((m) => m[1])).toEqual([
      "sales_paid",
      "sales_refunds",
      "sales_sum",
      "sales_avg",
      "sales_repeat",
      "sales_days",
      "sales_touched",
    ]);
  });

  test("a function metric among the tiles: its query is asked with the period", () => {
    const plan = salesPlan();
    const r = compiled(plan, testRegistry([salesModule({ functionFirst: true })]));
    const page = r.files["ui/pages/ReportsGoals.tsx"] ?? "";
    expect(page).toContain('const fn0w = useQuery("fxSalesTarget", { period: "week" });');
    expect(page).toContain('const fn0m = useQuery("fxSalesTarget", { period: "month" });');
    expect(page).toContain('values.week["sales_target"] = fnValue(fn0w.data);');
    expect(page).toContain('values.month["sales_target"] = fnValue(fn0m.data);');
  });

  test("deterministic: the same plan gives the same query and page", () => {
    const a = compiled(salesPlan(), testRegistry([salesModule()]));
    const b = compiled(salesPlan(), testRegistry([salesModule()]));
    expect(b.files).toEqual(a.files);
  });

  test("engine: a file generator that throws, a helper file outside functions/** and ui/** — MODULE_BUG", () => {
    const withFiles = (files: NonNullable<ModuleDefinition["files"]>) => {
      const d = salesModule();
      return testRegistry([{ ...d, files: { ...d.files, ...files } }]);
    };
    const boom = compilePlan(
      salesPlan(),
      withFiles({
        "functions/lib/x.ts": () => {
          throw new Error("boom");
        },
      }),
    );
    expect(boom.ok ? [] : boom.errors.map((e) => [e.code, e.message_ru])).toEqual([
      ["MODULE_BUG", "Модуль «Продажи (фикстура)»: генератор файла «functions/lib/x.ts» упал: boom"],
    ]);
    const outside = compilePlan(salesPlan(), withFiles({ "lib/x.ts": "" }));
    expect(outside.ok ? [] : outside.errors.map((e) => e.message_ru)).toEqual([
      "Модуль «Продажи (фикстура)»: файл «lib/x.ts» вне functions/** и ui/**",
    ]);
  });
});
