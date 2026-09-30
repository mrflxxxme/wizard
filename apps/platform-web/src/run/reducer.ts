// reduceRun: pure state of «Ход сборки» from RunEvent (platform-screens.yaml#sse.events, workflows.yaml#events).
import type { GateLevel, RunEvent } from "../api/types.js";

export const EVENT_TYPES = [
  "run_started",
  "plan_ready",
  "step_started",
  "step_finished",
  "agent_message",
  "chat_output",
  "ops_applied",
  "file_written",
  "gate_started",
  "gate_result",
  "budget_update",
  "budget_exceeded",
  "lock_waiting",
  "needs_input",
  "input_received",
  "run_finished",
  "run_failed",
] as const;
export const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["run_finished", "run_failed"]);
const KNOWN: ReadonlySet<string> = new Set(EVENT_TYPES);

export type StepStatus = "queued" | "running" | "done";

export interface StepRow {
  id: string;
  title: string;
  kind?: string;
  status: StepStatus;
  attempt: number;
  details: string[];
  inPlan: boolean;
}

export interface GateRow {
  status: "pending" | "running" | "passed" | "failed";
  revision?: number;
  totalChecks?: number;
  failedChecks: { id: string; message_ru: string; file?: string; line?: number }[];
}

export interface InputOption {
  id: string;
  label: string;
  recommended?: boolean;
  freeText?: boolean;
}

export interface NeedsInput {
  inputId: string;
  kind: "decision" | "secret";
  decisionId?: string;
  prompt_ru: string;
  options: InputOption[];
  secretName?: string;
}

export interface AgentMessage {
  id: string;
  agent: string;
  text: string;
}

export interface RunState {
  lastSeq: number;
  kind?: string;
  mode?: string;
  phase: "idle" | "running" | "needs_input" | "finished" | "failed";
  steps: StepRow[];
  ruFallback: boolean;
  gates: Record<GateLevel, GateRow>;
  credits: { used: number; cap: number | null; estimate: number | null };
  messages: AgentMessage[];
  budgetExceeded: { used: number; cap: number; nextStep?: string } | null;
  lock: { holderRunId: string; holderName?: string; position?: number } | null;
  input: NeedsInput | null;
  finished: {
    status: string;
    summary_ru?: string;
    resultRevision?: number | null;
    creditsUsed?: number;
    prodUrl?: string | null;
  } | null;
  failure: { code: string; message_ru: string; retryable: boolean; lastGoodRevision: number | null } | null;
  /** Revision of the last gate_result{G0, passed} (preview reload trigger). */
  g0PassedRevision: number | null;
}

const emptyGate = (): GateRow => ({ status: "pending", failedChecks: [] });

export function initialRunState(): RunState {
  return {
    lastSeq: 0,
    phase: "idle",
    steps: [],
    ruFallback: false,
    gates: { G0: emptyGate(), G1: emptyGate(), G2: emptyGate() },
    credits: { used: 0, cap: null, estimate: null },
    messages: [],
    budgetExceeded: null,
    lock: null,
    input: null,
    finished: null,
    failure: null,
    g0PassedRevision: null,
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function isGate(v: unknown): v is GateLevel {
  return v === "G0" || v === "G1" || v === "G2";
}

function upsertStep(steps: StepRow[], id: string, patch: (s: StepRow) => StepRow, title = id): StepRow[] {
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0)
    return [...steps, patch({ id, title, status: "queued", attempt: 1, details: [], inPlan: false })];
  return steps.map((s, j) => (j === i ? patch(s) : s));
}

/**
 * The real builder reports phases (plan/ops/code/verify), the plan lists items of kind ops|code (builder.yaml#loop.phases):
 * a phase event without its own row marks the plan items of that kind.
 */
function patchSteps(steps: StepRow[], id: string, patch: (s: StepRow) => StepRow, title = id): StepRow[] {
  if (steps.some((s) => s.id === id)) return upsertStep(steps, id, patch, title);
  if (!steps.some((s) => s.inPlan && s.kind === id)) return upsertStep(steps, id, patch, title);
  return steps.map((s) => (s.inPlan && s.kind === id ? patch(s) : s));
}

function currentStepId(steps: StepRow[]): string | undefined {
  return [...steps].reverse().find((s) => s.status === "running")?.id;
}

function addDetail(steps: StepRow[], lines: string[]): StepRow[] {
  const id = currentStepId(steps);
  if (!id || lines.length === 0) return steps;
  return upsertStep(steps, id, (s) => ({ ...s, details: [...s.details, ...lines] }));
}

export function reduceRun(state: RunState, e: RunEvent): RunState {
  if (e.seq <= state.lastSeq) return state; // dedup after reconnect (Last-Event-ID / after)
  const s: RunState = { ...state, lastSeq: e.seq };
  const p = obj(e.payload);
  if (!KNOWN.has(e.type)) {
    console.warn(`[wizard] неизвестное событие прогона: ${e.type}`);
    return s;
  }
  switch (e.type) {
    case "run_started": {
      const credits = obj(p.credits);
      return {
        ...initialRunState(),
        lastSeq: e.seq,
        kind: str(p.kind),
        mode: str(p.mode),
        phase: "running",
        credits: { used: 0, cap: num(credits.cap) ?? null, estimate: num(credits.estimate) ?? null },
      };
    }
    case "plan_ready": {
      const planned: StepRow[] = arr(p.steps).map((raw) => {
        const st = obj(raw);
        const id = str(st.id) ?? "";
        const existing = s.steps.find((x) => x.id === id);
        return existing
          ? { ...existing, inPlan: true }
          : {
              id,
              title: str(st.title) ?? id,
              kind: str(st.kind),
              status: "queued" as const,
              attempt: 1,
              details: [],
              inPlan: true,
            };
      });
      const extra = s.steps.filter((x) => !planned.some((pl) => pl.id === x.id));
      return { ...s, steps: [...planned, ...extra] };
    }
    case "step_started": {
      const id = str(p.step) ?? "";
      const label = str(p.label_ru) ?? id;
      const attempt = num(p.attempt) ?? 1;
      return {
        ...s,
        phase: "running",
        steps: patchSteps(
          s.steps,
          id,
          (st) => ({
            ...st,
            title: st.inPlan && st.id !== id ? st.title : label,
            status: "running",
            attempt,
          }),
          label,
        ),
      };
    }
    case "step_finished": {
      const id = str(p.step) ?? "";
      return {
        ...s,
        ruFallback: s.ruFallback || p.ruFallback === true,
        steps: patchSteps(s.steps, id, (st) => ({ ...st, status: "done" })),
      };
    }
    case "agent_message": {
      const id = str(p.messageId) ?? `seq-${e.seq}`;
      const text = str(p.text) ?? "";
      const agent = str(p.agent) ?? "orchestrator";
      const i = s.messages.findIndex((m) => m.id === id);
      if (i < 0) return { ...s, messages: [...s.messages, { id, agent, text }] };
      const messages = s.messages.map((m, j) =>
        j === i ? { ...m, text: p.delta === true ? m.text + text : text } : m,
      );
      return { ...s, messages };
    }
    case "ops_applied":
      return {
        ...s,
        steps: addDetail(
          s.steps,
          arr(p.summary_ru).filter((x) => typeof x === "string"),
        ),
      };
    case "file_written": {
      const path = str(p.path);
      if (!path) return s;
      const label = path.startsWith("ui/") ? "UI" : path.startsWith("functions/") ? "Логика" : "Файл";
      return { ...s, steps: addDetail(s.steps, [`${label}: ${path}`]) };
    }
    case "gate_started": {
      if (!isGate(p.level)) return s;
      return {
        ...s,
        gates: {
          ...s.gates,
          [p.level]: { status: "running", revision: num(p.revision), failedChecks: [] },
        },
      };
    }
    case "gate_result": {
      if (!isGate(p.level)) return s;
      const passed = p.passed === true;
      const failedChecks = arr(p.failedChecks)
        .slice(0, 20)
        .map((raw) => {
          const c = obj(raw);
          return {
            id: str(c.id) ?? "",
            message_ru: (str(c.message_ru) ?? "").slice(0, 300),
            ...(str(c.file) ? { file: str(c.file) } : {}),
            ...(num(c.line) !== undefined ? { line: num(c.line) } : {}),
          };
        });
      const revision = num(p.revision);
      return {
        ...s,
        gates: {
          ...s.gates,
          [p.level]: {
            status: passed ? "passed" : "failed",
            revision,
            totalChecks: num(p.totalChecks),
            failedChecks,
          },
        },
        g0PassedRevision:
          p.level === "G0" && passed ? (revision ?? s.g0PassedRevision ?? 0) : s.g0PassedRevision,
      };
    }
    case "budget_update":
      return {
        ...s,
        credits: {
          used: num(p.used) ?? s.credits.used,
          cap: num(p.cap) ?? s.credits.cap,
          estimate: num(p.estimate) ?? s.credits.estimate,
        },
      };
    case "budget_exceeded": {
      const used = num(p.used) ?? s.credits.used;
      const cap = num(p.cap) ?? s.credits.cap ?? 0;
      return {
        ...s,
        credits: { ...s.credits, used, cap },
        budgetExceeded: { used, cap, ...(str(p.nextStep) ? { nextStep: str(p.nextStep) } : {}) },
      };
    }
    case "lock_waiting":
      return {
        ...s,
        lock: {
          holderRunId: str(p.holderRunId) ?? "",
          ...(str(p.holderName) ? { holderName: str(p.holderName) } : {}),
          ...(num(p.position) !== undefined ? { position: num(p.position) } : {}),
        },
      };
    case "needs_input": {
      const kind = p.kind === "secret" ? "secret" : "decision";
      const options = arr(p.options).map((raw) => {
        const o = obj(raw);
        return {
          id: str(o.id) ?? "",
          label: str(o.label) ?? str(o.id) ?? "",
          ...(o.recommended === true ? { recommended: true } : {}),
          ...(o.freeText === true ? { freeText: true } : {}),
        };
      });
      return {
        ...s,
        phase: "needs_input",
        input: {
          inputId: str(p.inputId) ?? "",
          kind,
          ...(str(p.decisionId) ? { decisionId: str(p.decisionId) } : {}),
          prompt_ru: str(p.prompt_ru) ?? "",
          options,
          ...(str(p.secretName) ? { secretName: str(p.secretName) } : {}),
        },
      };
    }
    case "input_received": {
      if (s.input?.inputId !== str(p.inputId)) return s;
      return { ...s, phase: "running", input: null, budgetExceeded: null };
    }
    case "run_finished":
      return {
        ...s,
        phase: "finished",
        input: null,
        lock: null,
        finished: {
          status: str(p.status) ?? "succeeded",
          summary_ru: str(p.summary_ru),
          resultRevision: num(p.resultRevision) ?? null,
          creditsUsed: num(p.creditsUsed),
          prodUrl: str(p.prodUrl) ?? null,
        },
        credits: { ...s.credits, used: num(p.creditsUsed) ?? s.credits.used },
      };
    case "run_failed":
      return {
        ...s,
        phase: "failed",
        input: null,
        lock: null,
        failure: {
          code: str(p.code) ?? "INTERNAL",
          message_ru: str(p.message_ru) ?? "",
          retryable: p.retryable === true,
          lastGoodRevision: num(p.lastGoodRevision) ?? null,
        },
      };
    default:
      // chat_output: the caller re-reads GET /systems/:id; the build log itself does not change.
      return s;
  }
}
