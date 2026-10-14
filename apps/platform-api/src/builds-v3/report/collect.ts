// V4-04: the build report from what the run left in the database — the stage metrics of build_metrics (₽, minutes,
// calls, fallbacks), the scenario, critic and techreview checkpoints of the run, its gate reports and model calls.
import type postgres from "postgres";
import type {
  BuildReport,
  ReportCall,
  ReportGate,
  ReportScenario,
  ReportStage,
  ScenarioHttp,
} from "./types.js";

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : str(v));
const minutes = (ms: number): number => Math.round((ms / 60_000) * 10) / 10;
const rub = (v: number): number => Math.round(v * 100) / 100;

/** Keys of build_metrics.stages that are not stages. */
const NOT_STAGES = new Set([
  "pipeline",
  "briefVersion",
  "status",
  "scenarios_summary",
  "stop",
  "previewMs",
  "spentRub",
]);

export function stagesOf(metrics: Record<string, unknown>): ReportStage[] {
  return Object.entries(metrics)
    .filter(([k, v]) => !NOT_STAGES.has(k) && v !== null && typeof v === "object")
    .map(([stage, v]) => {
      const m = obj(v);
      return {
        stage,
        status: str(m.status) ?? "unknown",
        rub: rub(num(m.costRub)),
        minutes: minutes(num(m.durationMs)),
        ...(typeof m.calls === "number" ? { calls: m.calls } : {}),
        ...(typeof m.fallback === "boolean" ? { fallback: m.fallback } : {}),
        ...(typeof m.note === "string" ? { note: m.note.slice(0, 300) } : {}),
      };
    });
}

/** Failed and errored checks of a stored gate report (gates GateReport: checks[] with id, status, message_ru). */
export function failedChecks(report: unknown): ReportGate["failed"] {
  const checks = Array.isArray(obj(report).checks) ? (obj(report).checks as unknown[]) : [];
  return checks
    .map(obj)
    .filter((c) => c.status === "fail" || c.status === "error")
    .slice(0, 30)
    .map((c) => ({
      id: str(c.id) ?? "?",
      status: str(c.status) ?? "?",
      message: (str(c.message_ru) ?? "").slice(0, 300),
    }));
}

export interface CollectInput {
  runId: string;
  http?: readonly ScenarioHttp[];
  shots?: BuildReport["shots"];
  records?: string | null;
  gaps?: string[];
  now?: () => Date;
}

/** The report of run `runId` (a v3 build); null — no such run. */
/** The main findings of the critic's last cycle in words («P1 · L13 … · /@390#hero»), without repeats, ≤ 5. */
export function criticTop(cycle: unknown): string[] {
  const top = cycle && typeof cycle === "object" ? (cycle as { top?: unknown }).top : undefined;
  return (
    (Array.isArray(top) ? top : [])
      .map(obj)
      .map((f) => [str(f.severity), str(f.sign), str(f.where)].filter(Boolean).join(" · "))
      // The same finding twice in one cycle (the model repeats itself) is one line of the table.
      .filter((line, i, all) => line && all.indexOf(line) === i)
      .slice(0, 5)
  );
}

export async function collectBuildReport(pg: postgres.Sql, o: CollectInput): Promise<BuildReport | null> {
  const [run] = await pg<
    {
      id: string;
      org_id: string;
      system_id: string | null;
      status: string;
      failure_code: string | null;
      failure_message_ru: string | null;
      started_at: Date | null;
      finished_at: Date | null;
      started_by: string | null;
      org_kind: string;
      system_name: string | null;
    }[]
  >`
    select r.id, r.org_id, r.system_id, r.status, r.failure_code, r.failure_message_ru, r.started_at, r.finished_at,
           r.started_by, o.kind as org_kind, s.name as system_name
    from platform.runs r
    join platform.orgs o on o.id = r.org_id
    left join platform.systems s on s.id = r.system_id
    where r.id = ${o.runId}`;
  if (!run) return null;

  const [metricsRow] = await pg<{ payload: Record<string, unknown> }[]>`
    select e.payload from platform.run_events e
    where e.run_id = ${o.runId} and e.type = 'build_metrics'
    order by e.seq desc limit 1`;
  const payload = obj(metricsRow?.payload);
  const metrics = obj(payload.stages);

  const checkpoints = run.system_id
    ? await pg<{ key: string; checkpoint: Record<string, unknown> }[]>`
        select c.key, c.checkpoint from platform.system_build_checkpoints c
        where c.system_id = ${run.system_id} and c.run_id = ${o.runId}`
    : [];
  const data = (key: string) => obj(obj(checkpoints.find((c) => c.key === key)?.checkpoint).data);

  const http = o.http ?? [];
  const scenarios: ReportScenario[] = checkpoints
    .filter((c) => c.key.startsWith("scenario:"))
    .map((c) => {
      const id = c.key.slice("scenario:".length);
      const d = obj(obj(c.checkpoint).data);
      return {
        id,
        status: str(d.status) ?? "unknown",
        problems: strs(d.problems).slice(0, 5),
        http: http.filter((h) => h.scenario === id),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const gateRows = await pg<{ level: string; revision: number; passed: boolean; report: unknown }[]>`
    select distinct on (g.level) g.level, g.revision, g.passed, g.report
    from platform.gate_reports g
    where g.run_id = ${o.runId}
    order by g.level, g.revision desc, g.created_at desc`;
  const gates: ReportGate[] = gateRows.map((g) => ({
    level: g.level,
    revision: g.revision,
    passed: g.passed,
    failed: failedChecks(g.report),
  }));

  const critic = data("critic");
  const review = obj(critic.review);
  const cycles = Array.isArray(review.cycles) ? (review.cycles as unknown[]).map(obj) : [];
  const tech = data("techreview");

  const callRows = await pg<
    {
      step: string | null;
      call_type: string;
      model_id: string;
      tier: string;
      status: string;
      error_code: string | null;
      cost_rub: string;
      latency_ms: number | null;
    }[]
  >`
    select c.step, c.call_type, c.model_id, c.tier, c.status, c.error_code, c.cost_rub, c.latency_ms
    from platform.llm_calls c where c.run_id = ${o.runId} order by c.created_at limit 500`;
  const calls: ReportCall[] = callRows.map((c) => ({
    step: c.step,
    callType: c.call_type,
    model: c.model_id,
    tier: c.tier,
    status: c.status,
    errorCode: c.error_code,
    rub: rub(num(c.cost_rub)),
    latencyMs: c.latency_ms,
  }));

  const started = run.started_at?.getTime() ?? null;
  const finished = run.finished_at?.getTime() ?? (o.now ?? (() => new Date()))().getTime();
  const failed = run.status === "failed" || metrics.status === "failed";
  return {
    v: 1,
    runId: run.id,
    systemId: run.system_id,
    systemName: run.system_name,
    orgId: run.org_id,
    orgKind: run.org_kind,
    startedBy: run.started_by,
    status: str(metrics.status) ?? run.status,
    failure: failed ? { code: run.failure_code, message: run.failure_message_ru } : null,
    startedAt: iso(run.started_at),
    finishedAt: iso(run.finished_at),
    minutes: started === null ? minutes(num(payload.durationMs)) : minutes(finished - started),
    rub: rub(typeof metrics.spentRub === "number" ? metrics.spentRub : calls.reduce((s, c) => s + c.rub, 0)),
    stages: stagesOf(metrics),
    scenarios,
    gates,
    critic: Object.keys(critic).length
      ? {
          scores: cycles.map((c) => num(c.score)).filter((s) => s > 0),
          stop: str(review.stop),
          note: str(critic.note) ?? strs(critic.notes)[0] ?? null,
          top: criticTop(cycles.at(-1)),
          left: (Array.isArray(review.left) ? (review.left as unknown[]).map(obj) : [])
            .map((p) => ({
              code: str(p.code) ?? "",
              where: str(p.where) ?? "",
              message: str(p.message_ru) ?? "",
            }))
            .filter((p) => p.code)
            .slice(0, 30),
        }
      : null,
    techreview: Object.keys(tech).length
      ? {
          status: str(tech.status),
          blockers: strs(tech.blockers).slice(0, 10),
          notes: strs(tech.notes).slice(0, 10),
        }
      : null,
    calls,
    shots: o.shots ?? [],
    records: o.records ?? null,
    gaps: o.gaps ?? [],
    createdAt: (o.now ?? (() => new Date()))().toISOString(),
  };
}
