// Builder v2 host contract and params (specs/agents/builder.yaml#v2): a build of an approved system plan in stages
// plan → texts → design → photos → compile → custom → gates, a checkpoint after each stage, a budget per stage.
import type { AppSpec, SystemPlan } from "@wizard/appspec";
import type { GateReport, GoalScenarioInput } from "@wizard/gates";
import type { CustomSlot, ModuleRegistry } from "@wizard/modules";
import type { RunStepFn } from "../../core/events.js";
import type { RouteFn } from "../../core/loop.js";
import type { RecordDevelopmentRequest } from "../../gaps.js";
import type { HostRoute } from "../../host/index.js";
import type { PhotoHost } from "./photos.js";

/** Stages in build order (builder.yaml#v2.stages). */
export const V2_STAGES = ["plan", "texts", "design", "photos", "compile", "custom", "gates"] as const;
export type V2Stage = (typeof V2_STAGES)[number];

/** A stage result kept in the database: a repeated build of the same plan starts after the last one. */
export interface StageCheckpoint {
  stage: V2Stage;
  /** Hash of the approved plan the stage worked on (a checkpoint of another plan is ignored). */
  planHash: string;
  /** Stage output: the plan after texts/design, {revision, fingerprint} after compile, {items, baseRevision, revision, notes_ru} after custom. */
  data: Record<string, unknown>;
  /** Credits (milli) the stage spent on models — never paid again. */
  costMilli: number;
  durationMs: number;
  runId: string;
}

/** Checkpoints of one plan revision (platform: platform.system_plans.checkpoints). */
export interface CheckpointStore {
  load(): Promise<StageCheckpoint[]>;
  save(cp: StageCheckpoint): Promise<void>;
}

export type V2GateLevel = "G0" | "G1" | "G2";

/** What the host gives the builder v2; platform-api builds it over its durable BuildHost. */
export interface V2Host {
  /** host.route: the host fills ctx/orgPolicy/signal and enforces the run cap (upperBoundCredits). */
  route: HostRoute;
  runStep: RunStepFn;
  emit(type: string, payload: Record<string, unknown>): Promise<void> | void;
  signal?: AbortSignal;
  run: { id: string };
  checkpoints: CheckpointStore;
  /** The current draft revision: its spec (owner-only fields go into the compiled spec) and version. */
  currentSpec(): Promise<{ spec: AppSpec; version: number }>;
  /** Writes the compiled spec and files as one draft revision; other ui/** and functions/** files are removed. */
  commitCompiled(input: {
    spec: AppSpec;
    files: Readonly<Record<string, string>>;
    summary_ru: string;
  }): Promise<{ revision: number }>;
  /** Runs a gate on the current draft revision (events gate_started/gate_result, reports — the host). */
  runGates(
    level: V2GateLevel,
    overrides?: { goalScenarios?: readonly GoalScenarioInput[] },
  ): Promise<GateReport>;
  /**
   * true: G1 can run the plan's goal scenarios in a browser (B2-24, gates.yaml#G1.browser) and gets them. Otherwise G1
   * runs without the browser checks and build_metrics says so (readiness by D76 — eval with a browser, B2-41).
   */
  goalBrowser?: boolean;
  recordDevelopmentRequest?: RecordDevelopmentRequest;
  /**
   * B2-38: stock search and the platform photo library for the photos stage. Absent (or no stock keys) — the landing
   * keeps the theme graphic; the build never fails for photos.
   */
  photos?: PhotoHost;
}

/** ₽ per stage and for the whole build without custom code (D76 (9): ≤ 15 ₽, custom ≤ +20 ₽). */
export interface V2Budgets {
  texts: number;
  design: number;
  custom: number;
  /** Σ of all stages except custom. */
  total: number;
}

/**
 * The custom-code stage (default — custom.ts buildCustom, B2-23): writes the plan's custom parts on top of the compiled
 * draft and returns the draft revision it leaves (the compiled one when nothing was added).
 */
export type CustomStageFn = (ctx: {
  host: V2Host;
  plan: SystemPlan;
  budgetRub: number;
  /** host.route behind the stage wallet: budget checks before each call, credits counted for the stage. */
  route: RouteFn;
  registry: ModuleRegistry;
  /** The compiled draft revision the stage builds on: its spec (owner fields kept) and module files. */
  base: { spec: AppSpec; files: Readonly<Record<string, string>>; revision: number };
  /** Reserved names and files of the custom parts (compilePlan().customSlots). */
  slots: readonly CustomSlot[];
  /** G1 overrides of the gates stage (goal scenarios with a browser). */
  goalScenarios?: readonly GoalScenarioInput[];
}) => Promise<{
  data: Record<string, unknown>;
  /** Credits (milli) spent outside `route` (calls through `route` are counted by the wallet). */
  costMilli: number;
  notes_ru: string[];
  /** The draft revision after the stage; absent — the compiled one. */
  revision?: number;
  fallback?: boolean;
  note?: string;
}>;

export interface V2Params {
  /** The approved plan (platform.system_plans revision; compiled again at the plan stage). */
  plan: unknown;
  planRevision: number;
  registry?: ModuleRegistry;
  /** Name of the system (AppSpec app.name). */
  appName?: string;
  /**
   * Origin of the platform and the system's id there (B2-28): compilePlan gets them, generators link the owner's page
   * of the system (`${platformUrl}/s/${systemId}`). Both or neither.
   */
  platformUrl?: string;
  systemId?: string;
  budgets?: Partial<V2Budgets>;
  /** The custom-code stage (default buildCustom; tests plug their own). */
  custom?: CustomStageFn;
  /** ₽ per credit (models.yaml#credits.rub_per_credit; default from the registry). */
  rubPerCredit?: number;
  now?: () => number;
  /** Time budget of the photos stage, ms (default PHOTOS_TIME_BUDGET_MS). */
  photosTimeMs?: number;
}

export type V2FailureCode =
  | "PLAN_INVALID"
  | "MODULE_BUG"
  | "STAGE_BUDGET_EXCEEDED"
  | "GATES_FAILED"
  | "INTERNAL";

/** Per-stage line of build_metrics (builder.yaml#v2.metrics). */
export interface StageMetric {
  status: "done" | "reused" | "skipped" | "failed";
  costRub: number;
  durationMs: number;
  calls?: number;
  fallback?: boolean;
  note?: string;
}

export type V2Outcome =
  | {
      status: "succeeded";
      revision: number;
      summary_ru: string;
      /** ₽ spent by this run (reused stages cost nothing). */
      costRub: number;
      durationMs: number;
      stages: Partial<Record<V2Stage, StageMetric>>;
    }
  | {
      status: "failed";
      code: V2FailureCode;
      message_ru: string;
      retryable: boolean;
      costRub: number;
      stages: Partial<Record<V2Stage, StageMetric>>;
      reports?: GateReport[];
    };
