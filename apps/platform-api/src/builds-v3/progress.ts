// Live progress of a build by the brief for the canvas (V3-17; workflows.yaml#events.schemas.v3_progress, product.yaml
// D77_v3 (10)): the host wraps the harness v3 without touching it — it watches the brief re-reads, the checkpoints and
// the harness events — and adds a full structured snapshot `progress` to build_stage, step_started and step_finished:
// the brief's scenarios with their states, spent and cap in ₽, elapsed and expected seconds against the 30 min cap,
// the revision of the live preview. The client takes the latest snapshot, so a page opened again restores the build
// from the server's events. The harness text lines (agent_message) stay as they are.

import {
  featureList,
  milliRub,
  V3_BUILD_LIMITS,
  V3_HOOK_STAGES,
  V3_STAGE_ETA_SEC,
  V3_STAGE_LABELS,
  V3_STAGES,
  type V3Checkpoint,
  type V3Host,
  type V3Stage,
} from "@wizard/agents/builder";
import type { SystemBrief } from "@wizard/appspec";
import type postgres from "postgres";

export type V3ProgressScenarioStatus = "pending" | "running" | "passed" | "failed" | "stopped";
export type V3ProgressStageStatus = "pending" | "running" | "done" | "reused" | "skipped";

/** One brief scenario on the canvas checklist; failed and stopped ones go to «Запросы на развитие» with the reason. */
export interface V3ProgressScenario {
  id: string;
  title: string;
  priority: "must" | "should";
  status: V3ProgressScenarioStatus;
  reason?: string;
  /** Taken from a checkpoint of an earlier build (not paid again). */
  reused?: boolean;
}

/** The snapshot of workflows.yaml#events.schemas.v3_progress. */
export interface V3BuildProgress {
  /** The stage running now (or the last one reached). */
  stage: V3Stage | null;
  stages: { id: V3Stage; label_ru: string; status: V3ProgressStageStatus }[];
  scenarios: V3ProgressScenario[];
  /** ₽ of the build with the steps taken from checkpoints (the «потрачено X ₽ из Y» of the harness). */
  spentRub: number;
  /** Part of spentRub paid by an earlier build (steps reused from its checkpoints). */
  reusedRub: number;
  capRub: number;
  elapsedSec: number;
  capSec: number;
  /** Expected seconds left by the stages still to run (≤ capSec − elapsedSec). */
  remainingSec: number;
  /** Revision of the live preview (the growing system); null — no preview yet. */
  previewRevision: number | null;
  checkpoints: { saved: number; reused: number };
}

/** What the platform knows right now: this run's spend, the clock of the run, the preview revision of the system. */
export interface V3LiveStats {
  runSpentRub: number;
  elapsedSec: number;
  previewRevision: number | null;
}

/** Harness events that carry the snapshot (workflows.yaml#events.types build_stage, step_started, step_finished). */
export const V3_PROGRESS_EVENTS: ReadonlySet<string> = new Set([
  "build_stage",
  "step_started",
  "step_finished",
]);

const SCENARIO = "scenario:";
const MAX_SCENARIOS = 100;
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Reasons of a scenario checkpoint written before the final list (the same words as the harness's STOP_REASON_RU). */
const STOPPED_RU: Readonly<Record<string, string>> = {
  budget: "не хватило бюджета сборки",
  target: "желательный сценарий — отложен, чтобы уложиться в целевой бюджет",
  time: "не успели: вышло время сборки",
};
const failedRu = (problems: unknown) =>
  `не прошёл проверку в браузере: ${
    Array.isArray(problems) && typeof problems[0] === "string" ? problems[0] : "сценарий не выполняется"
  }`;

interface Feature {
  id: string;
  title: string;
  priority: "must" | "should";
}

interface Row extends V3ProgressScenario {
  startedAt?: number;
}

/** The harness order after a brief edit: the known scenarios keep their place, new ones join by priority. */
function mergeOrder(prev: readonly Feature[], next: readonly Feature[]): Feature[] {
  const byId = new Map(next.map((f) => [f.id, f]));
  const kept = prev.filter((f) => byId.has(f.id)).map((f) => byId.get(f.id) as Feature);
  const added = next.filter((f) => !prev.some((x) => x.id === f.id));
  const of = (xs: Feature[], p: Feature["priority"]) => xs.filter((f) => f.priority === p);
  return [...of(kept, "must"), ...of(added, "must"), ...of(kept, "should"), ...of(added, "should")];
}

const isFeature = (x: unknown): x is Feature => {
  const f = x as Feature;
  return (
    !!f &&
    typeof f.id === "string" &&
    typeof f.title === "string" &&
    (f.priority === "must" || f.priority === "should")
  );
};

/**
 * State of one v3 build from what the harness does through its host: pure, the clock comes in (`at`, ms). Scenario
 * states come from the steps (running), the scenario checkpoints (passed, failed, stopped) and the final list of the
 * `scenarios` checkpoint; a scenario the harness took from an earlier build makes no event of its own — it shows as
 * done once the loop is past it (or with the final list).
 */
export class V3ProgressTracker {
  readonly #hooks: ReadonlySet<string>;
  readonly #rpc: number;
  readonly #capRub: number;
  readonly #capSec: number;
  #order: Feature[] = [];
  readonly #rows = new Map<string, Row>();
  readonly #stages = new Map<V3Stage, { status: V3ProgressStageStatus; startedAt: number }>();
  readonly #loaded = new Map<string, V3Checkpoint>();
  readonly #prior = new Set<string>();
  #priorMilli = 0;
  #saved = 0;
  readonly #durations: number[] = [];
  #preview: number | null | undefined;

  constructor(o: { hooks?: readonly string[]; rubPerCredit: number; capRub?: number; capMs?: number }) {
    this.#hooks = new Set(o.hooks ?? []);
    this.#rpc = o.rubPerCredit;
    this.#capRub = o.capRub ?? V3_BUILD_LIMITS.capRub;
    this.#capSec = Math.round((o.capMs ?? V3_BUILD_LIMITS.timeMs) / 1000);
  }

  /** A brief the harness read (before each stage and scenario): the scenario list in the harness order. */
  brief(b: SystemBrief): void {
    this.#features(featureList(b).map(({ id, title, priority }) => ({ id, title, priority })));
  }

  /** Checkpoints of earlier builds the harness loaded (costs of reused steps, scenarios passed before). */
  loaded(cps: readonly V3Checkpoint[]): void {
    for (const cp of cps) this.#loaded.set(cp.key, cp);
  }

  /** A checkpoint the harness saved in this run. */
  saved(cp: V3Checkpoint): void {
    const d = cp.data ?? {};
    if ((V3_STAGES as readonly string[]).includes(cp.key) || cp.key.startsWith(SCENARIO)) this.#saved += 1;
    if (cp.key === "brief" && Array.isArray(d.features)) this.#features(d.features.filter(isFeature));
    if (cp.key.startsWith(SCENARIO)) {
      const r = this.#rows.get(cp.key.slice(SCENARIO.length));
      if (!r) return;
      if (d.status === "passed") this.#set(r, "passed");
      else if (d.status === "failed") this.#set(r, "failed", failedRu(d.problems));
      else if (d.status === "stopped")
        this.#set(r, "stopped", STOPPED_RU[String(d.reason)] ?? STOPPED_RU.budget);
    }
    if (cp.key === "scenarios" && Array.isArray(d.scenarios)) {
      // The final list of the loop: every scenario with its state and the harness's own reason.
      for (const x of d.scenarios as Record<string, unknown>[]) {
        if (typeof x?.id !== "string") continue;
        let r = this.#rows.get(x.id);
        if (!r && isFeature(x)) {
          r = { id: x.id, title: clip(x.title, 200), priority: x.priority, status: "pending" };
          this.#rows.set(x.id, r);
        }
        if (!r) continue;
        const status = x.status === "passed" || x.status === "failed" ? x.status : "stopped";
        this.#set(r, status, typeof x.reason === "string" ? x.reason : undefined);
        if (x.reused === true) this.#reuseScenario(r);
      }
    }
  }

  /** A harness event (before the host writes it). */
  event(type: string, p: Record<string, unknown>, at: number): void {
    if (type === "build_stage") {
      const stage = p.stage as V3Stage;
      if (!(V3_STAGES as readonly string[]).includes(stage)) return;
      const st = p.status;
      if (st === "started") this.#stages.set(stage, { status: "running", startedAt: at });
      else if (st === "done" || st === "skipped") this.#stages.set(stage, { status: st, startedAt: at });
      else if (st === "reused") {
        this.#stages.set(stage, { status: "reused", startedAt: at });
        this.#addPrior(stage);
      }
      return;
    }
    const step = typeof p.step === "string" ? p.step : "";
    if (!step.startsWith(SCENARIO)) return;
    const r = this.#rows.get(step.slice(SCENARIO.length));
    if (!r) return;
    if (type === "step_started") {
      // The loop takes the first scenario it has no state for: everything before it is settled — a pending one there
      // was passed by an earlier build (its checkpoint says so) or, being «should», put off for the target.
      for (const f of this.#order) {
        if (f.id === r.id) break;
        const x = this.#rows.get(f.id);
        if (x?.status !== "pending") continue;
        if (this.#loaded.get(`${SCENARIO}${f.id}`)?.data?.status === "passed") {
          this.#set(x, "passed");
          this.#reuseScenario(x);
        } else if (x.priority === "should") this.#set(x, "stopped", STOPPED_RU.target);
      }
      this.#set(r, "running");
      r.startedAt = at;
    } else if (type === "step_finished" && r.startedAt !== undefined) {
      this.#durations.push(Math.max(0, at - r.startedAt));
    }
  }

  /** The snapshot for an event; the preview advances when a part of the system lands (skeleton, scenario, gates). */
  snapshot(
    live: V3LiveStats,
    at: number,
    event?: { type: string; payload: Record<string, unknown> },
  ): V3BuildProgress {
    if (this.#preview === undefined || this.#lands(event))
      this.#preview = live.previewRevision ?? this.#preview ?? null;
    const elapsedSec = Math.max(0, Math.round(live.elapsedSec));
    const reusedRub = milliRub(this.#priorMilli, this.#rpc);
    const stages = V3_STAGES.map((id) => ({
      id,
      label_ru: V3_STAGE_LABELS[id],
      status: this.#stages.get(id)?.status ?? ("pending" as const),
    }));
    const running = stages.filter((s) => s.status === "running").at(-1);
    const reached = stages.filter((s) => s.status !== "pending").at(-1);
    return {
      stage: running?.id ?? reached?.id ?? null,
      stages,
      scenarios: this.#list()
        .slice(0, MAX_SCENARIOS)
        .map(({ startedAt: _s, ...r }) => ({
          ...r,
          title: clip(r.title, 200),
          ...(r.reason ? { reason: clip(r.reason, 300) } : {}),
        })),
      spentRub: round2(Math.max(0, live.runSpentRub) + reusedRub),
      reusedRub,
      capRub: this.#capRub,
      elapsedSec,
      capSec: this.#capSec,
      remainingSec: Math.max(0, Math.min(this.#remainingSec(at), this.#capSec - elapsedSec)),
      previewRevision: this.#preview ?? null,
      checkpoints: { saved: this.#saved, reused: this.#prior.size },
    };
  }

  #features(next: readonly Feature[]) {
    this.#order = mergeOrder(this.#order, next);
    for (const f of this.#order) {
      const r = this.#rows.get(f.id);
      if (r) {
        r.title = f.title;
        r.priority = f.priority;
      } else this.#rows.set(f.id, { id: f.id, title: f.title, priority: f.priority, status: "pending" });
    }
  }

  /** Scenarios in the harness order; ones the brief no longer has stay only if the build already did something. */
  #list(): Row[] {
    const ids = new Set(this.#order.map((f) => f.id));
    const extra = [...this.#rows.values()].filter((r) => !ids.has(r.id) && r.status !== "pending");
    return [...this.#order.map((f) => this.#rows.get(f.id) as Row), ...extra];
  }

  #set(r: Row, status: V3ProgressScenarioStatus, reason?: string) {
    r.status = status;
    if (reason && status !== "passed") r.reason = reason;
    else delete r.reason;
  }

  #reuseScenario(r: Row) {
    r.reused = true;
    this.#addPrior(`${SCENARIO}${r.id}`);
  }

  #addPrior(key: string) {
    if (this.#prior.has(key)) return;
    const cp = this.#loaded.get(key);
    if (!cp) return;
    this.#prior.add(key);
    this.#priorMilli += Math.max(0, cp.costMilli);
  }

  #lands(e?: { type: string; payload: Record<string, unknown> }): boolean {
    if (!e) return false;
    const p = e.payload;
    if (e.type === "build_stage")
      return (
        (p.stage === "scenarios" && p.status === "started") ||
        ((p.stage === "skeleton" || p.stage === "gates") && (p.status === "done" || p.status === "reused"))
      );
    if (e.type === "step_finished" && typeof p.step === "string" && p.step.startsWith(SCENARIO))
      return this.#rows.get(p.step.slice(SCENARIO.length))?.status === "passed";
    return false;
  }

  /** Expected seconds of the stages still to run: the stage ETAs of the harness, scenarios by their average here. */
  #remainingSec(at: number): number {
    const avg = this.#durations.length
      ? this.#durations.reduce((s, x) => s + x, 0) / this.#durations.length / 1000
      : V3_STAGE_ETA_SEC.scenarios;
    let sec = 0;
    for (const st of V3_STAGES) {
      const s = this.#stages.get(st);
      const status = s?.status ?? "pending";
      if (status !== "pending" && status !== "running") continue;
      if (st === "scenarios") {
        for (const r of this.#list())
          if (r.status === "pending") sec += avg;
          else if (r.status === "running") sec += Math.max(0, avg - (at - (r.startedAt ?? at)) / 1000);
        continue;
      }
      if ((V3_HOOK_STAGES as readonly string[]).includes(st) && !this.#hooks.has(st)) continue;
      const eta = V3_STAGE_ETA_SEC[st];
      sec += status === "running" && s ? Math.max(0, eta - (at - s.startedAt) / 1000) : eta;
    }
    return Math.round(sec);
  }
}

/** This run's spend, its clock (database time since it started) and the system's preview revision. */
export async function liveStats(pg: postgres.Sql, runId: string, rubPerCredit: number): Promise<V3LiveStats> {
  const [r] = await pg<{ used: string | null; preview: number | null; elapsed: number | null }[]>`
    select r.credits_used_milli as used, s.preview_revision as preview,
      greatest(0, floor(extract(epoch from (now() - coalesce(r.started_at, r.created_at)))))::int as elapsed
    from platform.runs r
    left join platform.systems s on s.id = r.system_id
    where r.id = ${runId}`;
  return {
    runSpentRub: milliRub(Number(r?.used ?? 0), rubPerCredit),
    elapsedSec: r?.elapsed ?? 0,
    previewRevision: r?.preview ?? null,
  };
}

/**
 * The V3Host with the live progress: the same host whose brief re-reads and checkpoints the tracker watches and whose
 * build_stage / step_started / step_finished carry `progress`. A failed stats read never fails the build — the event
 * goes out without the snapshot.
 */
export function withLiveProgress(
  host: V3Host,
  o: {
    rubPerCredit: number;
    /** This run's spend, clock and preview (platform: liveStats). */
    stats: () => Promise<V3LiveStats>;
    now?: () => number;
  },
): V3Host {
  const now = o.now ?? Date.now;
  // Hook stages the host gives run (their ETA counts); the others are skipped by the harness.
  const hooks = Object.keys(host.hooks ?? {}).filter((k) =>
    (V3_HOOK_STAGES as readonly string[]).includes(k),
  );
  const t = new V3ProgressTracker({ hooks, rubPerCredit: o.rubPerCredit });
  return {
    ...host,
    emit: async (type, payload) => {
      const at = now();
      t.event(type, payload, at);
      if (!V3_PROGRESS_EVENTS.has(type)) return host.emit(type, payload);
      let progress: V3BuildProgress | null = null;
      try {
        progress = t.snapshot(await o.stats(), at, { type, payload });
      } catch {
        progress = null;
      }
      return host.emit(type, progress ? { ...payload, progress } : payload);
    },
    brief: async () => {
      const v = await host.brief();
      if (v) t.brief(v.brief);
      return v;
    },
    checkpoints: {
      load: async () => {
        const cps = await host.checkpoints.load();
        t.loaded(cps);
        return cps;
      },
      save: async (cp) => {
        await host.checkpoints.save(cp);
        t.saved(cp);
      },
    },
  };
}
