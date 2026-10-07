// Build progress of the canvas (B2-25) from run events — the only place that knows their shape. The builder v2 (B2-21)
// reports build_stage {stage, status, index, total, label_ru, remainingSec}; until it is everywhere the progress falls
// back to the generic step_started/step_finished of the run. Pure: the canvas re-runs it on every event.
import type { RunEvent } from "../../api/types.js";
import { canvas } from "../../i18n/ru/canvas.js";

export type BuildPhase = "idle" | "running" | "done" | "failed";

export interface BuildFailure {
  code: string;
  /** The server's own words (message_ru). */
  message: string;
  retryable: boolean;
  /** Stage the build stopped at (build_stage), for «Подробнее». */
  stage?: string;
}

export interface BuildProgress {
  phase: BuildPhase;
  /** 1-based number of the current stage (0 — nothing started yet). */
  index: number;
  total: number;
  /** Plain words of the current stage («Пишу тексты сайта»). */
  label: string;
  /** 0…1 of the whole build. */
  fraction: number;
  /** Seconds left (null — unknown yet). */
  remainingSec: number | null;
  /** Stages that came from a previous attempt (status reused, after /fix). */
  reused: number;
  failure: BuildFailure | null;
  summary: string | null;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Default stages of the builder v2 (agents/builder.yaml, B2-21) when an event carries no total. */
const STAGES = ["plan", "texts", "design", "compile", "custom", "gates"] as const;

export function emptyProgress(): BuildProgress {
  return {
    phase: "idle",
    index: 0,
    total: STAGES.length,
    label: "",
    fraction: 0,
    remainingSec: null,
    reused: 0,
    failure: null,
    summary: null,
  };
}

/** Progress of one build run from its events in seq order. */
export function buildProgress(events: readonly RunEvent[]): BuildProgress {
  const out = emptyProgress();
  const stageDone = new Set<string>();
  let haveStages = false;
  let stepsTotal = 0;
  let stepsDone = 0;
  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let stage: string | undefined;
  for (const e of events) {
    const p = e.payload ?? {};
    const ts = Date.parse(e.ts);
    if (Number.isFinite(ts)) {
      firstTs ??= ts;
      lastTs = ts;
    }
    switch (e.type) {
      case "run_started":
        out.phase = "running";
        break;
      case "build_stage": {
        haveStages = true;
        out.phase = "running";
        stage = str(p.stage) ?? stage;
        const total = num(p.total) ?? num(p.count) ?? STAGES.length;
        const idx =
          num(p.index) ??
          num(p.number) ??
          (stage ? STAGES.indexOf(stage as (typeof STAGES)[number]) + 1 : out.index);
        out.total = Math.max(1, total);
        out.index = Math.max(out.index, idx);
        out.label =
          str(p.label_ru) ?? str(p.label) ?? (stage ? (canvas.build.stages[stage] ?? out.label) : out.label);
        const rem = num(p.remainingSec) ?? num(p.etaSec) ?? num(p.remaining_s);
        if (rem !== undefined) out.remainingSec = Math.max(0, Math.round(rem));
        const status = str(p.status);
        if (stage && (status === "done" || status === "reused" || status === "skipped")) stageDone.add(stage);
        if (status === "reused") out.reused += 1;
        out.fraction = Math.min(1, Math.max(out.fraction, stageDone.size / out.total));
        break;
      }
      case "plan_ready":
        if (!haveStages) stepsTotal = Array.isArray(p.steps) ? p.steps.length : stepsTotal;
        break;
      case "step_started":
        out.phase = "running";
        if (!haveStages) {
          out.index = stepsDone + 1;
          out.label = str(p.label_ru) ?? out.label;
          stepsTotal = Math.max(stepsTotal, out.index);
          out.total = stepsTotal;
        }
        break;
      case "step_finished":
        if (!haveStages) {
          stepsDone += 1;
          out.fraction = stepsTotal > 0 ? Math.min(1, stepsDone / Math.max(stepsTotal, stepsDone + 1)) : 0;
          // Without stage estimates: the average step so far × steps left (null until one step is done).
          if (firstTs !== null && lastTs !== null && stepsTotal > stepsDone)
            out.remainingSec = Math.round(((lastTs - firstTs) / 1000 / stepsDone) * (stepsTotal - stepsDone));
        }
        break;
      case "run_finished":
        if (p.status === "cancelled") {
          out.phase = "failed";
          out.failure = {
            code: "CANCELLED",
            message: str(p.summary_ru) ?? canvas.build.cancelled,
            retryable: true,
          };
        } else {
          out.phase = "done";
          out.fraction = 1;
          out.remainingSec = 0;
          out.index = out.total;
          out.summary = str(p.summary_ru) ?? null;
        }
        break;
      case "run_failed":
        out.phase = "failed";
        out.failure = {
          code: str(p.code) ?? "INTERNAL",
          message: str(p.message_ru) ?? "",
          retryable: p.retryable === true,
          ...(stage ? { stage } : {}),
        };
        break;
    }
  }
  return out;
}

/** «1 мин 20 с», «45 с», «меньше минуты»-style plain words for the remaining time. */
export function remainingText(sec: number | null): string {
  if (sec === null) return canvas.build.estimating;
  if (sec <= 0) return canvas.build.almost;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return canvas.build.leftSec(s);
  return s === 0 ? canvas.build.leftMin(m) : canvas.build.leftMinSec(m, s);
}
