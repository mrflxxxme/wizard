// The live v3 build of the canvas (V3-17) from run events — pure. The host of the harness v3 adds a full snapshot
// `progress` (workflows.yaml#events.schemas.v3_progress) to build_stage, step_started and step_finished; the latest one
// is the state, so a page opened again restores the build from the server's events (replayed from seq 1). Nothing is
// parsed from the harness text lines. Gate results come from gate_result, the end from run_finished / run_failed.
import type { Message, RunEvent, V3BuildProgress } from "../../../api/types.js";
import { liveRu } from "./ru.js";

export type V3LivePhase = "running" | "done" | "failed";

export interface V3LiveGate {
  /** seq of its gate_result event. */
  seq: number;
  level: string;
  passed: boolean;
  revision: number | null;
  failed: number;
}

export interface V3Live {
  runId: string;
  progress: V3BuildProgress;
  /** Server time of the event with the latest snapshot, ms: the clock goes on from it. */
  at: number;
  phase: V3LivePhase;
  /** run_finished summary_ru. */
  summary: string | null;
  /** Server time of run_finished / run_failed, ms (null while running). */
  endedAt: number | null;
  gates: V3LiveGate[];
}

const CARRIERS: ReadonlySet<string> = new Set(["build_stage", "step_started", "step_finished"]);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A snapshot as the schema has it (shallow: the server validates the rest). */
export function isV3Progress(x: unknown): x is V3BuildProgress {
  const p = x as V3BuildProgress;
  return (
    !!p &&
    typeof p === "object" &&
    Array.isArray(p.scenarios) &&
    Array.isArray(p.stages) &&
    num(p.spentRub) &&
    num(p.capRub) &&
    num(p.elapsedSec) &&
    num(p.capSec) &&
    num(p.remainingSec) &&
    (p.previewRevision === null || num(p.previewRevision))
  );
}

/** The live build of one run's events, or null when they carry no v3 snapshot (a v1/v2 build, another run). */
export function v3Live(events: readonly RunEvent[]): V3Live | null {
  let live: V3Live | null = null;
  const gates: V3LiveGate[] = [];
  let phase: V3LivePhase = "running";
  let summary: string | null = null;
  let endedAt: number | null = null;
  for (const e of events) {
    const p = e.payload ?? {};
    if (CARRIERS.has(e.type) && isV3Progress(p.progress)) {
      const at = Date.parse(e.ts);
      live = {
        runId: e.runId,
        progress: p.progress,
        at: Number.isFinite(at) ? at : Date.now(),
        phase,
        summary,
        endedAt,
        gates,
      };
    } else if (e.type === "gate_result") {
      const failed = Array.isArray(p.failedChecks) ? p.failedChecks.length : 0;
      gates.push({
        seq: e.seq,
        level: String(p.level ?? ""),
        passed: p.passed === true,
        revision: num(p.revision) ? p.revision : null,
        failed,
      });
    } else if (e.type === "run_finished" || e.type === "run_failed") {
      phase = e.type === "run_finished" && p.status !== "cancelled" ? "done" : "failed";
      summary = typeof p.summary_ru === "string" && p.summary_ru ? p.summary_ru : null;
      const at = Date.parse(e.ts);
      endedAt = Number.isFinite(at) ? at : Date.now();
    }
  }
  return live ? { ...live, phase, summary, endedAt, gates: gates.slice(-12) } : null;
}

export interface V3LiveClock {
  /** Seconds the build has been going (frozen at the end). */
  elapsedSec: number;
  /** Expected seconds left, never past the cap (0 at the end). */
  remainingSec: number;
}

/** The clock of a live build at `now` (ms): the server's snapshot moved on by the time since its event. */
export function liveClock(live: V3Live, now: number): V3LiveClock {
  const p = live.progress;
  const until = live.endedAt ?? now;
  const since = Math.max(0, (until - live.at) / 1000);
  const elapsedSec = Math.min(p.capSec, Math.max(0, Math.round(p.elapsedSec + since)));
  if (live.phase !== "running") return { elapsedSec, remainingSec: 0 };
  const remainingSec = Math.max(0, Math.min(p.remainingSec - since, p.capSec - elapsedSec));
  return { elapsedSec, remainingSec: Math.round(remainingSec) };
}

/** «потрачено 42 ₽ из 500 ₽» of the latest snapshot (the build row of the chat), null without one. */
export function v3SpendLine(events: readonly RunEvent[]): string | null {
  const live = v3Live(events);
  return live ? liveRu.spend.line(live.progress.spentRub, live.progress.capRub) : null;
}

/** Scenarios done and in total. */
export function scenarioCount(p: V3BuildProgress): { done: number; total: number } {
  return { done: p.scenarios.filter((s) => s.status === "passed").length, total: p.scenarios.length };
}

/** The run of the latest build report in the chat (a v3 system opened after its build replays it). */
export function lastReportRun(messages: readonly Message[]): string | null {
  let best: Message | null = null;
  for (const m of messages)
    if (m.kind === "run_report" && typeof m.runId === "string" && m.runId && (!best || m.seq > best.seq))
      best = m;
  return best?.runId ?? null;
}
