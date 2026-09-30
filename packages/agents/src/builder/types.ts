// Builder host contract (architecture.yaml#interfaces.agent_host) and runBuild params/outcome (agents/builder.yaml).
import type { ApplyOpsResult, AppSpec } from "@wizard/appspec";
import type { Check, GateReport } from "@wizard/gates";
import type { RouteInput, RouteOutput } from "@wizard/llm";
import type { SystemCard } from "../orchestrator/schemas.js";

export type BuildMode = "create" | "change" | "fix" | "point_edit";
export type BuilderGateLevel = "G0" | "G1";

/** route() input as the host takes it: the host fills orgPolicy, ctx (org/run/system, budget) and signal. */
export interface HostRouteInput extends Omit<RouteInput, "ctx" | "orgPolicy" | "signal"> {
  /** Durable step name (also the usage record step). */
  step?: string;
  /** upper_bound(call) in credits (builder.yaml#budgets.credits_cap). */
  upperBoundCredits?: number;
}

export interface BuildStore {
  getSpec(): Promise<{ spec: AppSpec; version: number }>;
  applyOps(ops: readonly unknown[], expectedVersion: number, idemKey?: string): Promise<ApplyOpsResult>;
  /** Stages a file in the run's working tree (committed by commitFiles). */
  writeFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  listFiles(prefix?: string): Promise<string[]>;
  /** Commits the working tree as one revision kind=files; null when nothing changed. */
  commitFiles(): Promise<{ revision: number } | null>;
}

export interface InputOption {
  id: string;
  label: string;
  recommended?: boolean;
  freeText?: boolean;
}
export interface InputRequest {
  kind?: "decision";
  decisionId: string;
  prompt_ru: string;
  options: InputOption[];
}
export interface InputAnswer {
  choice: string;
  text?: string;
}

export interface QaGenerateInput {
  card: BuildCard;
  spec: AppSpec;
  specVersion: number;
}
export interface QaExplainInput {
  card: BuildCard;
  spec: AppSpec;
  report: GateReport;
}
/** QA agent (M0-14, agents/qa.yaml): checks for G1 and explanations of failures for the builder. */
export interface BuilderQa {
  generate(input: QaGenerateInput): Promise<Check[]>;
  explain(input: QaExplainInput): Promise<unknown[]>;
}

export interface OrchestratorAnswer {
  answer: string;
  source: "card" | "defaults" | "user";
}

export interface BuildHost {
  route(input: HostRouteInput): Promise<RouteOutput>;
  /**
   * Runs a gate on the current revision (the host commits staged files, builds the GateContext, stores the
   * full report and emits gate_started/gate_result — workflows.yaml#build.step_rules).
   */
  runGates(level: BuilderGateLevel, overrides?: { checks?: Check[] }): Promise<GateReport>;
  qa: BuilderQa;
  store: BuildStore;
  /** RunEvent emitter (workflows.yaml#events). */
  emit(type: string, payload: Record<string, unknown>): Promise<void> | void;
  /** M0: identity; M1: DBOS.runStep. */
  runStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Puts the run into needs_input (emits needs_input/input_received) and resolves with the answer. */
  needsInput(req: InputRequest): Promise<InputAnswer>;
  signal?: AbortSignal;
  run?: { id: string };
  /**
   * true: host.route enforces the credits cap itself from upperBoundCredits and emits budget_update /
   * budget_exceeded / needs_input(budget) (platform-api). Otherwise the builder does it.
   */
  managesBudget?: boolean;
  /** Optional orchestrator bridge for ask_orchestrator (card/defaults answer is used without it). */
  askOrchestrator?(q: { question: string; options?: string[] }): Promise<OrchestratorAnswer>;
}

/** The approved card as the builder reads it (orchestrator.yaml#system_card); unknown extra fields are ignored. */
export type BuildCard = Partial<Omit<SystemCard, "acceptance" | "roles">> &
  Pick<SystemCard, "acceptance" | "roles"> & { title?: string };

export interface PointEditTarget {
  wzId: string;
  componentName: string;
  file: string;
  line: number;
  route: string;
  instruction: string;
}

export interface BuildParams {
  card: BuildCard;
  /** Credits cap (card.cap.credits or the fix/point_edit cap). */
  cap: number;
  mode: BuildMode;
  target?: PointEditTarget;
  /** Overrides of builder.yaml#budgets (tests, eval). */
  limits?: Partial<BuildLimits>;
  now?: () => number;
}

export interface BuildLimits {
  maxSteps: number;
  maxWallClockMs: number;
  escalationThreshold: number;
  gateIterations: number;
  /** Context collapse thresholds in characters (builder.yaml#context.collapse). */
  maxChars: number;
  minChars: number;
}

export type FailureCode =
  | "BUDGET_STOPPED"
  | "CONSECUTIVE_ERRORS"
  | "GATES_FAILED"
  | "LLM_UNAVAILABLE"
  | "INTERNAL";

export type BuildOutcome =
  | {
      status: "succeeded";
      resultRevision: number;
      creditsUsed: number;
      summary_ru: string;
      steps: number;
    }
  | {
      /** User chose stop (budget) or rollback (escalation); rollback → the host reverts to the last G0-passed revision. */
      status: "cancelled";
      reason: "budget_stop" | "rollback" | "aborted";
      creditsUsed: number;
      summary_ru: string;
      steps: number;
    }
  | {
      status: "failed";
      code: FailureCode;
      message_ru: string;
      retryable: boolean;
      creditsUsed: number;
      steps: number;
      /** Last gate reports (GATES_FAILED). */
      reports?: GateReport[];
    };
