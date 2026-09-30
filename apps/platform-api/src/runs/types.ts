// Pluggable run executors (architecture.yaml#interfaces.agent_host). The host contract is the canonical one of
// @wizard/agents/host; platform-api implements it durably (M0-26 wires the real agents: ../agents/executors.ts).
import type {
  BuildHost as AgentBuildHost,
  BuildStore as AgentBuildStore,
  BuilderQa,
  HostRouteInput,
  InputAnswer,
  InputOption,
  InputRequest,
} from "@wizard/agents/host";
import type { AppSpec } from "@wizard/appspec";
import type { Check, GateContext, GateLevel, GateReport } from "@wizard/gates";
import type { OrgPolicy, RouteOutput } from "@wizard/llm";
import type { EventType } from "./events.js";

export type { GateContext, GateLevel, GateReport, HostRouteInput, InputAnswer, InputOption, InputRequest };
/** specs/quality/gates.yaml#report check (api.yaml#/components/schemas/GateReport). */
export type GateCheck = Check;
export type GateRunner = (level: GateLevel, ctx: GateContext) => Promise<GateReport>;

export interface StepHost {
  route(input: HostRouteInput): Promise<RouteOutput>;
  emit(type: EventType, payload: Record<string, unknown>): Promise<void>;
  /** M0: identity with cancel check (M1: DBOS.runStep). */
  runStep<T>(name: string, fn: () => Promise<T>): Promise<T>;
  signal: AbortSignal;
  run: { id: string; orgId: string; systemId: string; kind: string; mode: string | null };
}

export interface BuildStore extends AgentBuildStore {
  deleteFile(path: string): Promise<void>;
}

/** Kept for compatibility: the QA agent the host hands to the builder (@wizard/agents/host BuilderQa). */
export type QaAgent = BuilderQa;

/** agent_host as platform-api provides it: the budget is enforced in route() (managesBudget = true). */
export interface BuildHost
  extends Omit<AgentBuildHost, "runGates" | "emit" | "store" | "signal" | "run">,
    StepHost {
  runGates(level: GateLevel, overrides?: Partial<GateContext>): Promise<GateReport>;
  qa: BuilderQa;
  store: BuildStore;
  needsInput(req: InputRequest): Promise<InputAnswer>;
  managesBudget: true;
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
  /** Org of the system: plan and the routing policy the host applies (t1Restricted as in route()). */
  org: { id: string; plan: string; policy: OrgPolicy };
  /** Executor state saved by the previous successful interview turn of this system (OrchSession), or null. */
  state: Record<string, unknown> | null;
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
) & {
  notice?: { categories: string[] };
  /** Executor state to persist with this turn (handed back as context.state next time); never shown to users. */
  state?: Record<string, unknown>;
};

/** Hook for bundle_and_reload after G0 passed (M0-26: migrate_draft, seed_draft, packages/build writeArtifact, reload). */
export type OnG0Passed = (a: {
  systemId: string;
  systemKey: string;
  revision: number;
  spec: AppSpec;
  files: ReadonlyMap<string, string>;
  runId: string;
  /** Spec of the current preview_revision (what the draft schema holds), null before the first G0 pass. */
  prevSpec: AppSpec | null;
}) => Promise<{ bundleKey: string } | undefined>;

export interface RunExecutors {
  interviewTurn(host: InterviewHost): Promise<InterviewOutput>;
  build(host: BuildHost, params: BuildParams): Promise<BuildOutcome | undefined>;
  gates?: GateRunner;
  qa?: QaAgent;
  onG0Passed?: OnG0Passed;
  /** Releases executor resources (runtime for G1, function processes) on PlatformApi.close(). */
  close?(): Promise<void>;
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
