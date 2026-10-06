// The goal-panel model of «Отчёты и панель цели»: what the panel shows for a compiled plan — tiles (metrics of the
// plan's goals first), the data sources the goalMetrics query reads and the reports by entity. Pure and deterministic;
// the query and the page are both emitted from this one model, so they always agree on ids and order.
import { entityIndexes, goalLabel } from "@wizard/appspec";
import { can, statusField } from "../screens/cabinet.js";
import type { CompiledMetric, GenContext } from "../types.js";
import type { MetricCompute, MetricUnit, Period } from "./lib/goalPanel.js";

/** The panel shows 3–6 tiles (modules.yaml#catalog reports; goal-panel design — B2-27). */
export const MIN_TILES = 3;
export const MAX_TILES = 6;
/** Documents one goalMetrics call reads at most (a query reads ≤ 4000, sdk.md §2.1; one page may overshoot by 200). */
export const ROW_BUDGET = 3600;
/** The role the panel is for: the owner (the screen's and the query's roles are $owner). */
export const PANEL_ROLE = "owner";

export interface PanelTile {
  id: string;
  /** Module of the metric. */
  module: string;
  label: string;
  unit: MetricUnit;
  better: "up" | "down";
  goal: string;
  /** The plan's wording of the goal, or the goal's label for a metric of a goal outside the plan. */
  goalText: string;
  planGoal: boolean;
  /** A function metric: the module's query `fn({period}) → {value, previous?}`; else computed by goalMetrics. */
  fn?: string;
  description?: string;
}

/**
 * How goalMetrics reads a source (entity + date field) for both periods: created — by the implicit created_at index;
 * index — by a declared index that starts with the date field; scan — newest first without a range (no index fits,
 * e.g. updated_at), filtered in memory.
 */
export interface PanelSource {
  entity: string;
  dateField: string;
  mode: "created" | "index" | "scan";
  /** The date field holds a date without time ('YYYY-MM-DD'). */
  dateOnly: boolean;
}

export interface PanelReport {
  entity: string;
  label: string;
  /** Status field of the entity (statusField) and its options; null — no status breakdown. */
  status: string | null;
  statuses: { value: string; label: string }[];
  source: number;
}

export interface PanelModel {
  period: Period;
  exportCsv: boolean;
  tiles: PanelTile[];
  /** Every visible data metric of the plan with the index of its source (goalMetrics computes them all). */
  data: { id: string; compute: MetricCompute; source: number }[];
  sources: PanelSource[];
  reports: PanelReport[];
}

/** Tiles: metrics of the plan's goals, round-robin over the goals in the plan's order, then others up to MIN_TILES. */
export function pickTiles(
  metrics: readonly CompiledMetric[],
  goalOrder: readonly string[],
): CompiledMetric[] {
  const byGoal = goalOrder.map((g) => metrics.filter((m) => m.planGoal && m.goal === g));
  const picked: CompiledMetric[] = [];
  for (let round = 0; picked.length < MAX_TILES && byGoal.some((l) => l.length > round); round++)
    for (const list of byGoal) {
      const m = list[round];
      if (m && picked.length < MAX_TILES) picked.push(m);
    }
  for (const m of metrics) {
    if (picked.length >= MIN_TILES) break;
    if (!m.planGoal) picked.push(m);
  }
  // Display order: by goal (plan goals first), then as the modules declare them.
  const rank = (m: CompiledMetric) => {
    const g = goalOrder.indexOf(m.goal);
    return g === -1 ? goalOrder.length : g;
  };
  return picked
    .map((m, i) => ({ m, i, at: metrics.indexOf(m) }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.at - b.at || a.i - b.i)
    .map((x) => x.m);
}

export function panelModel(ctx: GenContext): PanelModel {
  const { spec, plan } = ctx;
  const entityOf = (name: string) => spec.entities.find((e) => e.name === name);
  // Metrics the owner can see: a data metric of a readable entity, a function metric (its roles are the module's).
  const visible = ctx.metrics.filter((m) =>
    m.compute.kind === "function" ? true : can(spec, PANEL_ROLE, m.compute.entity, "read"),
  );
  const goalOrder = plan.goals.map((g) => g.id as string);
  const tiles = pickTiles(visible, goalOrder);

  const sources: PanelSource[] = [];
  const sourceOf = (entity: string, dateField: string): number => {
    const at = sources.findIndex((s) => s.entity === entity && s.dateField === dateField);
    if (at !== -1) return at;
    const e = entityOf(entity);
    const f = e?.fields.find((x) => x.name === dateField);
    const indexed =
      e !== undefined &&
      (f?.type === "date" || f?.type === "datetime") &&
      entityIndexes(e).some((idx) => idx[0] === dateField);
    sources.push({
      entity,
      dateField,
      mode: dateField === "created_at" ? "created" : indexed ? "index" : "scan",
      dateOnly: f?.type === "date",
    });
    return sources.length - 1;
  };

  const out: PanelTile[] = tiles.map((m) => {
    const goal = plan.goals.find((g) => g.id === m.goal);
    return {
      id: m.id,
      module: m.module,
      label: m.label,
      unit: m.unit,
      better: m.better,
      goal: m.goal,
      goalText: goal?.statement ?? goalLabel(m.goal),
      planGoal: m.planGoal,
      ...(m.compute.kind === "function" ? { fn: m.compute.name } : {}),
      ...(m.description ? { description: m.description } : {}),
    };
  });
  // Every visible data metric is computed (tiles are what the view shows now; hints and digests may use the rest).
  const data: PanelModel["data"] = [];
  for (const m of visible)
    if (m.compute.kind !== "function")
      data.push({
        id: m.id,
        compute: structuredClone(m.compute),
        source: sourceOf(m.compute.entity, m.compute.dateField),
      });

  const reports: PanelReport[] = spec.entities
    .filter((e) => can(spec, PANEL_ROLE, e.name, "read"))
    .map((e) => {
      const st = statusField(spec, e.name);
      return {
        entity: e.name,
        label: e.label,
        status: st?.name ?? null,
        statuses: (st?.enum ?? []).map((o) => ({ value: o.value, label: o.label })),
        source: sourceOf(e.name, "created_at"),
      };
    });

  return {
    period: ctx.params.period === "week" ? "week" : "month",
    exportCsv: ctx.params.export_csv !== false,
    tiles: out,
    data,
    sources,
    reports,
  };
}
