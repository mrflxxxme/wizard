// Pluggable run executors (architecture.yaml#interfaces.agent_host). packages/agents implements them in M0-26;
// until then platform-api ships stubs (./stub.ts) and tests inject fakes.
import type { ApplyOpsResult, AppSpec } from "@wizard/appspec";
import type { RouteInput, RouteOutput } from "@wizard/llm";
import type postgres from "postgres";
import type { EventType } from "./events.js";

export type GateLevel = "G0" | "G1" | "G2";

/** specs/quality/gates.yaml#report (copy: api.yaml#/components/schemas/GateReport). */
export interface GateCheck {
  id: string;
  status: "pass" | "fail" | "warn" | "skip" | "error";
  severity: "blocker" | "warning";
  message_ru: string;
  file?: string;
  line?: number;
  path?: string;
  acId?: string;
  evidence?: string;
  fixHint?: string;
}
export interface GateReport {
  level: GateLevel;
  passed: boolean;
  specVersion?: number;
  startedAt?: string;
  durationMs?: number;
  summary?: { pass?: number; fail?: number; warn?: number; skip?: number; error?: number };
  checks: GateCheck[];
  explanations?: unknown[];
  [k: string]: unknown;
}

/** architecture.yaml#interfaces.gate_context as platform-api fills it. */
export interface GateContext {
  spec: AppSpec;
  prevSpec: AppSpec | null;
  specVersion: number;
  files: ReadonlyMap<string, string>;
  env: "draft" | "prod";
  systemKey: string;
  db: postgres.Sql;
  milestone: string;
  signal: AbortSignal;
  [k: string]: unknown;
}
export type GateRunner = (level: GateLevel, ctx: GateContext) => Promise<GateReport>;

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

export interface HostRouteInput extends Omit<RouteInput, "ctx" | "orgPolicy" | "signal"> {
  step?: string;
  /** upper_bound(call) in credits (agents/builder.yaml#budgets.credits_cap); default 0. */
  upperBoundCredits?: number;
}

export interface StepHost {
  route(input: HostRouteInput): Promise<RouteOutput>;
  emit(type: EventType, payload: Record<string, unknown>): Promise<void>;
  /** M0: identity with cancel check (M1: DBOS.runStep). */
  runStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
  signal: AbortSignal;
  run: { id: string; orgId: string; systemId: string; kind: string; mode: string | null };
}

export interface BuildStore {
  getSpec(): Promise<{ spec: AppSpec; version: number }>;
  applyOps(ops: readonly unknown[], expectedVersion: number, idemKey?: string): Promise<ApplyOpsResult>;
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  readFile(path: string): Promise<string | null>;
  listFiles(prefix?: string): Promise<string[]>;
  /** Commits the run's working tree as one revision kind=files; null when nothing changed. */
  commitFiles(): Promise<{ revision: number } | null>;
}

export interface QaAgent {
  generate(...args: unknown[]): Promise<unknown>;
  explain(...args: unknown[]): Promise<unknown>;
}

/** architecture.yaml#interfaces.agent_host (+ needsInput for budget/escalation decisions). */
export interface BuildHost extends StepHost {
  runGates(level: GateLevel, overrides?: Partial<GateContext>): Promise<GateReport>;
  qa: QaAgent;
  store: BuildStore;
  needsInput(req: InputRequest): Promise<InputAnswer>;
}

export interface BuildParams {
  card: Record<string, unknown>;
  /** Credits cap of the run. */
  cap: number;
  mode: "create" | "change" | "fix";
}
export interface BuildOutcome {
  /** "cancelled" = user chose to stop (escalation rollback). */
  status?: "succeeded" | "cancelled";
  summary_ru?: string;
}

export interface ChatMessage {
  id: string;
  seq: number;
  role: string;
  kind: string;
  text?: string;
  payload?: Record<string, unknown>;
}

export interface InterviewContext {
  system: { id: string; name: string; stage: string; draftRevision: number; previewRevision: number | null };
  trigger: "create" | "message" | "answers";
  messages: ChatMessage[];
  spec: AppSpec;
  pendingQuestions: unknown[];
  card: Record<string, unknown> | null;
  answers?: unknown[];
}
export interface InterviewHost extends StepHost {
  context: InterviewContext;
}

export type InterviewOutput = (
  | {
      kind: "questions";
      text?: string;
      questions: Record<string, unknown>[];
      analysis?: Record<string, unknown>;
    }
  | { kind: "card"; text?: string; card: Record<string, unknown> }
  | { kind: "answer"; text: string }
) & { notice?: { categories: string[] } };

/** Hook for bundle_and_reload after G0 passed (M0-26: migrate_draft, seed_draft, packages/build writeArtifact, reload). */
export type OnG0Passed = (a: {
  systemId: string;
  systemKey: string;
  revision: number;
  spec: AppSpec;
  files: ReadonlyMap<string, string>;
  runId: string;
}) => Promise<{ bundleKey: string } | undefined>;

export interface RunExecutors {
  interviewTurn(host: InterviewHost): Promise<InterviewOutput>;
  build(host: BuildHost, params: BuildParams): Promise<BuildOutcome | undefined>;
  gates?: GateRunner;
  qa?: QaAgent;
  onG0Passed?: OnG0Passed;
}

/** Throw from an executor to fail the run with a workflows.yaml#run_lifecycle.failure_codes code. */
export class RunFailure extends Error {
  constructor(
    readonly code: string,
    readonly message_ru: string,
    readonly retryable = false,
  ) {
    super(`${code}: ${message_ru}`);
    this.name = "RunFailure";
  }
}

/** Cooperative cancellation; stopBudget = the user chose "stop" on budget_exceeded. */
export class RunCancelled extends Error {
  constructor(readonly summary_ru = "Прогон отменён") {
    super("run cancelled");
    this.name = "RunCancelled";
  }
}
