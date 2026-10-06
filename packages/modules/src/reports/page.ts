// ui/pages/ReportsGoals.tsx of a compiled system: the goal panel in the owner's cabinet. The page has two parts — the
// data part generated from the panel model (tiles grouped by the plan's goals, reports, hooks of goalMetrics and of the
// modules' function metrics) and PANEL_VIEW, a fixed view on today's ui-kit components. A new design (B2-27, B2-34)
// replaces only PANEL_VIEW (or swaps it for a ui-kit component taking the same props); the data part stays.
import { js, pascal } from "../screens/jsx.js";
import type { ScreenContext } from "../types.js";
import { type PanelModel, type PanelTile, panelModel } from "./panel.js";
import { GOAL_METRICS_FN } from "./query.js";

/** Period switch of the panel. */
export const PERIODS = [
  { id: "week", label: "Неделя", span: "за 7 дней" },
  { id: "month", label: "Месяц", span: "за 30 дней" },
] as const;

/** Tiles grouped for the view: one group per plan goal (its wording), then «Дополнительно» for other goals. */
export function tileGroups(
  model: PanelModel,
  planGoals: readonly { id: string; statement: string }[],
): { key: string; title: string; tiles: PanelTile[] }[] {
  const groups = planGoals
    .map((g) => ({
      key: g.id,
      title: `Цель: ${g.statement}`,
      tiles: model.tiles.filter((t) => t.goal === g.id),
    }))
    .filter((g) => g.tiles.length);
  const other = model.tiles.filter((t) => !t.planGoal);
  if (other.length) groups.push({ key: "other", title: "Дополнительно", tiles: other });
  return groups;
}

/**
 * The view: props {period, onPeriod, values (by tile id), reports (goalMetrics reports), loading, failed, onRetry};
 * reads TILES, GROUPS, REPORTS, PERIODS and CSV of the data part. No template literals inside (the generator embeds it).
 */
export const PANEL_VIEW = `// ---------------------------------------------------------------- view (today's ui-kit; B2-27 replaces this part)

type ViewProps = {
  period: Period;
  onPeriod: (p: Period) => void;
  values: Record<string, Value | undefined>;
  reports: ReportData[] | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
};

function unitLabel(t: Tile): string {
  if (t.unit === "minutes") return t.label + ", мин";
  if (t.unit === "days") return t.label + ", дн.";
  return t.label;
}

function kpiOf(t: Tile, v: Value | undefined) {
  const value = v ? v.value : null;
  const format: "int" | "money" | "percent" | undefined =
    t.unit === "count" ? "int" : t.unit === "percent" ? "percent" : t.unit === "rub" ? "money" : undefined;
  const capped = v && v.capped ? " · по последним записям" : "";
  return {
    id: t.id,
    label: unitLabel(t),
    value: value === null ? 0 : t.unit === "percent" ? value / 100 : value,
    format,
    hint: value === null ? "Нет данных за период" : trendText(value, v ? v.previous : null, t.unit, t.better) + capped,
  };
}

function reportData(r: Report, d: ReportData | undefined) {
  const total = d ? d.total : 0;
  const capped = d && d.capped ? " · по последним записям" : "";
  return {
    kpis: [
      {
        id: "total",
        label: "Новых записей",
        value: total,
        format: "int" as const,
        hint: trendText(total, d ? d.previous : null, "count", "up") + capped,
      },
    ],
    ...(r.statuses.length
      ? {
          bars: {
            title: "По статусам",
            items: r.statuses.map((s) => ({
              label: s.label,
              value: d ? (d.byStatus.find((b) => b.value === s.value)?.count ?? 0) : 0,
              max: total,
            })),
          },
        }
      : {}),
  };
}

function csvHref(period: Period, values: Record<string, Value | undefined>, reports: ReportData[] | undefined): string {
  const span = PERIODS.find((p) => p.id === period)?.span ?? "";
  const rows: (string | number | null)[][] = [["Показатель " + span, "Цель", "Значение", "Прошлый период"]];
  for (const t of TILES) {
    const v = values[t.id];
    rows.push([t.label, t.goalText, formatValue(v ? v.value : null, t.unit), formatValue(v ? v.previous : null, t.unit)]);
  }
  rows.push([]);
  rows.push(["Раздел", "Статус", "Новых записей " + span, "Прошлый период"]);
  for (const r of REPORTS) {
    const d = (reports ?? []).find((x) => x.entity === r.entity);
    rows.push([r.label, "все", d ? d.total : null, d ? d.previous : null]);
    for (const s of r.statuses)
      rows.push([r.label, s.label, d ? (d.byStatus.find((b) => b.value === s.value)?.count ?? 0) : null, null]);
  }
  return "data:text/csv;charset=utf-8," + encodeURIComponent(csvOf(rows));
}

function GoalPanelView(props: ViewProps) {
  const span = PERIODS.find((p) => p.id === props.period)?.span ?? "";
  const switcher = (
    <div role="group" aria-label="Период" data-testid="wz-goals-period">
      {PERIODS.map((p) => (
        <Button
          key={p.id}
          size="sm"
          variant={p.id === props.period ? "primary" : "secondary"}
          aria-pressed={p.id === props.period}
          onClick={() => props.onPeriod(p.id)}
        >
          {p.label}
        </Button>
      ))}
    </div>
  );
  const status = props.failed ? (
    <EmptyState text="Не удалось посчитать показатели" action={<Button onClick={props.onRetry}>Повторить</Button>} />
  ) : props.loading ? (
    <Loading lines={3} />
  ) : null;
  const goals = (
    <>
      {switcher}
      {status ??
        (GROUPS.length === 0 ? (
          <EmptyState text="Показателей пока нет: модули плана их не объявили" />
        ) : (
          GROUPS.map((g) => (
            <StatsReport
              key={g.key}
              testId={"goal-" + g.key}
              title={g.title}
              subtitle={"Показатели " + span}
              data={{ kpis: g.tiles.map((t) => kpiOf(t, props.values[t.id])) }}
            />
          ))
        ))}
      {CSV && !status && TILES.length ? (
        <a href={csvHref(props.period, props.values, props.reports)} download={"panel-" + props.period + ".csv"} data-testid="wz-goals-csv">
          Скачать CSV
        </a>
      ) : null}
    </>
  );
  const reports = (
    <>
      {switcher}
      {status ??
        (REPORTS.length === 0 ? (
          <EmptyState text="Разделов с записями пока нет" />
        ) : (
          REPORTS.map((r) => (
            <StatsReport
              key={r.entity}
              testId={"report-" + r.entity}
              title={r.label}
              subtitle={"Новые записи " + span}
              data={reportData(r, (props.reports ?? []).find((x) => x.entity === r.entity))}
            />
          ))
        ))}
    </>
  );
  return (
    <CabinetLayout
      title="Панель цели"
      defaultSection="goals"
      sections={[
        { id: "goals", label: "Цели", content: goals },
        { id: "reports", label: "Отчёты", content: reports },
      ]}
    />
  );
}
`;

export function goalPanelSource(
  model: PanelModel,
  ctx: Pick<ScreenContext, "plan">,
  component: string,
): string {
  const groups = tileGroups(model, ctx.plan.goals);
  const tile = (t: PanelTile) =>
    `{ id: ${js(t.id)}, label: ${js(t.label)}, unit: ${js(t.unit)}, better: ${js(t.better)}, goalText: ${js(t.goalText)} }`;
  const fnTiles = model.tiles.filter((t) => t.fn);
  return [
    "// Generated by the module «Отчёты и панель цели» (B2-17): the goal panel of the owner — metrics of the plan's goals",
    "// for a week or a month with the change against the period before, reports by entity and a CSV of the numbers.",
    'import { useQuery, useState } from "@wizard/sdk";',
    'import { Button, CabinetLayout, EmptyState, Loading, StatsReport } from "@wizard/ui-kit";',
    'import { csvOf, formatValue, type MetricUnit, type Period, trendText } from "../lib/goalPanel";',
    "",
    'type Tile = { id: string; label: string; unit: MetricUnit; better: "up" | "down"; goalText: string };',
    "type Report = { entity: string; label: string; statuses: { value: string; label: string }[] };",
    "type Value = { value: number | null; previous: number | null; capped?: boolean };",
    "type ReportData = { entity: string; total: number; previous: number; byStatus: { value: string; count: number }[]; capped: boolean };",
    "",
    `const PERIODS: { id: Period; label: string; span: string }[] = ${js(PERIODS)};`,
    "const TILES: Tile[] = [",
    ...model.tiles.map((t) => `  ${tile(t)},`),
    "];",
    "const GROUPS: { key: string; title: string; tiles: Tile[] }[] = [",
    ...groups.map(
      (g) =>
        `  { key: ${js(g.key)}, title: ${js(g.title)}, tiles: [${g.tiles.map((t) => `TILES[${model.tiles.indexOf(t)}] as Tile`).join(", ")}] },`,
    ),
    "];",
    "const REPORTS: Report[] = [",
    ...model.reports.map(
      (r) => `  { entity: ${js(r.entity)}, label: ${js(r.label)}, statuses: ${js(r.statuses)} },`,
    ),
    "];",
    `const CSV = ${model.exportCsv};`,
    "",
    "/** A function metric's query answers {value, previous?} for the period (modules.yaml#manifest.metrics.compute.function). */",
    "function fnValue(d: { value: number | null; previous?: number | null } | undefined): Value | undefined {",
    "  return d ? { value: d.value, previous: d.previous ?? null } : undefined;",
    "}",
    "",
    `export default function ${component}() {`,
    `  const [period, setPeriod] = useState<Period>(${js(model.period)});`,
    `  const main = useQuery(${js(GOAL_METRICS_FN)}, { period });`,
    ...fnTiles.map((t, i) => `  const fn${i} = useQuery(${js(t.fn)}, { period });`),
    "  const values: Record<string, Value | undefined> = {};",
    "  for (const m of main.data?.metrics ?? []) values[m.id] = m;",
    ...fnTiles.map((t, i) => `  values[${js(t.id)}] = fnValue(fn${i}.data);`),
    "  return (",
    "    <GoalPanelView",
    "      period={period}",
    "      onPeriod={setPeriod}",
    "      values={values}",
    "      reports={main.data?.reports}",
    `      loading={main.isLoading${fnTiles.map((_, i) => ` || fn${i}.isLoading`).join("")}}`,
    "      failed={main.error !== undefined}",
    "      onRetry={main.refetch}",
    "    />",
    "  );",
    "}",
    "",
    PANEL_VIEW,
  ].join("\n");
}

/** The screen generator of «Панель цели» (route /cabinet/goals). */
export const goalPanelPage = (ctx: ScreenContext): string =>
  goalPanelSource(panelModel(ctx), ctx, `${pascal("reports")}${pascal(ctx.screen.id)}`);
