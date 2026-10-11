// Host contract, params and outcome of the build harness v3 (V3-11; specs/agents/builder-v3.md §3 C6, product.yaml
// D77_v3 (9)–(11)): stages brief → design → backend → skeleton → scenarios → critic → template_gate → techreview →
// gates, a checkpoint after each stage and each scenario, a wallet in ₽ and a clock with the stop rules of D77 (10).
import type { AppSpec, BriefScenario, ExtensionOp, SystemBrief } from "@wizard/appspec";
import type { GateReport, GoalScenarioInput } from "@wizard/gates";
import type { ModuleRegistry } from "@wizard/modules";
import type { DesignSystemV3 } from "@wizard/ui-kit/v3/design";
import type { RunStepFn } from "../../../core/events.js";
import type { RecordDevelopmentRequest } from "../../../gaps.js";
import type { HostRoute } from "../../../host/index.js";
import type { PhotoHost } from "../../v2/photos.js";
import type { PageComposer, V3BuildContext } from "../contract.js";

/** Stages in build order (builder-v3.md C6; the backend is compiled after the design so cabinets take its tokens). */
export const V3_STAGES = [
  "brief",
  "design",
  "backend",
  "skeleton",
  "scenarios",
  "critic",
  "template_gate",
  "techreview",
  "gates",
] as const;
export type V3Stage = (typeof V3_STAGES)[number];

/** Stages V3-13…15 implement; until a host gives the hook they are reported as skipped. */
export const V3_HOOK_STAGES = ["critic", "template_gate", "techreview"] as const;
export type V3HookStage = (typeof V3_HOOK_STAGES)[number];

/**
 * A result kept between runs of one system: a stage (key = stage id) or one scenario (key = `scenario:<id>`). A step
 * reuses it only when `fingerprint` — the hash of everything the step read — is the same; a reused step does not pay.
 */
export interface V3Checkpoint {
  key: string;
  fingerprint: string;
  data: Record<string, unknown>;
  /** Credits (milli) the step spent on models. */
  costMilli: number;
  durationMs: number;
  runId: string;
}

/** Checkpoints of a system's v3 builds (platform: platform.system_build_checkpoints). */
export interface V3CheckpointStore {
  load(): Promise<V3Checkpoint[]>;
  save(cp: V3Checkpoint): Promise<void>;
}

/** The latest version of the system brief (V3-02). */
export interface V3BriefVersion {
  version: number;
  brief: SystemBrief;
}

/**
 * A non-blocking question of the build (D77 (8)): asked during the build, which goes on with the recommended option;
 * the answer — a «вопрос → ответ» entry of the brief (qa[] with the same question text) or the host's answers() — is
 * applied in a later step. `param` — the answer sets a module parameter of the backend plan.
 */
export interface V3BuildQuestion {
  id: string;
  text: string;
  options: { id: string; label: string }[];
  /** Option id the build takes until the owner answers. */
  recommended: string;
  why?: string;
  param?: { module: string; param: string };
}

/** An answer to a build question. */
export interface V3QuestionAnswer {
  questionId: string;
  optionId: string;
}

/** What the browser check of one brief scenario gets (the draft is committed before the call). */
export interface ScenarioCheckInput {
  scenario: BriefScenario;
  /** Goal scenarios of the compiled modules this brief scenario maps to (by moduleHint, goal and actor). */
  goalScenarios: readonly GoalScenarioInput[];
  /** Routes of the pages the scenario wrote or changed. */
  routes: string[];
  /** The draft revision under check. */
  revision: number;
}

/** Result of the browser check: ok — the scenario works; problems — Russian, for the build log and the requests. */
export interface ScenarioCheckResult {
  ok: boolean;
  problems: string[];
  /** false — the host had no browser and checked without it (renders only). */
  browser: boolean;
  /**
   * V3-18: the check could not run even after a retry (a check with status error: the browser, a timeout) — not the
   * scenario's failure: it is kept, not rolled back, and the final gates check it.
   */
  unavailable?: boolean;
}

/** What a stage hook (critic V3-13, template_gate V3-14, techreview V3-15) returns. */
export interface V3HookResult {
  status: "done" | "skipped";
  /** Changed files (path → source; null — delete), merged by the harness and committed as a draft revision. */
  files?: Map<string, string | null>;
  /** Short Russian notes for the client. */
  notes?: string[];
  /** Blockers left after the hook's own rounds (techreview: the system is not published, D77 (10)). */
  blockers?: string[];
  /** ₽ spent outside ctx.route (calls through ctx.route are counted by the wallet). */
  spentRub?: number;
  /**
   * template_gate: too close to past sites of the niche. Right after the skeleton the art director picks again without
   * these archetypes and the skeleton is recomposed (once per run; never over a direction the owner pinned); at the
   * late stage, after the scenarios, it is only a note. `patterns` (V3-40): over a direction the owner pinned, the
   * skeleton is recomposed in the same style without these library patterns where another variant fits.
   */
  redesign?: { avoid: string[]; patterns?: string[] };
  /**
   * Token edits of the design system (the critic): the harness takes them as ctx.design of the later stages, compiles
   * the backend (cabinets) with them and writes their ui/design.css over the earlier layers.
   */
  design?: DesignSystemV3;
  /**
   * techreview (V3-15): extension operations (C5) its fixes need, already checked under the gates; the harness adds
   * them to the build's extensions and compiles the backend again (applyExtensions: RLS, ПДн and migration rules) — a
   * rejected one goes to «Запросы на развитие» with its reason.
   */
  extensions?: ExtensionOp[];
  /**
   * The operator's diagnostics of the hook (the critic: the axes, the verdict and the main findings of each cycle),
   * kept in the stage's checkpoint for the measurements; never shown to the client.
   */
  review?: Record<string, unknown>;
  note?: string;
}

/** A stage hook: the build context (ctx.budgetRub — its stage budget, ctx.route — through the wallet). */
export type V3StageHook = (ctx: V3BuildContext) => Promise<V3HookResult>;

/** The ready notice (D77 (10)): the host sends it by e-mail or Telegram. */
export interface V3ReadyNotice {
  summary_ru: string;
  revision: number;
  scenariosDone: number;
  scenariosTotal: number;
  costRub: number;
  durationMs: number;
}

export type V3GateLevel = "G0" | "G1" | "G2";

/** What the host gives the harness v3; platform-api builds it over its durable BuildHost (builds-v3/host.ts). */
export interface V3Host {
  /** host.route: the host fills ctx/orgPolicy/signal and enforces the run cap. */
  route: HostRoute;
  runStep: RunStepFn;
  emit(type: string, payload: Record<string, unknown>): Promise<void> | void;
  signal?: AbortSignal;
  run: { id: string };
  systemId: string;
  /** The latest brief version, re-read before each stage and each scenario (D77 (9)); null — no brief. */
  brief(): Promise<V3BriefVersion | null>;
  checkpoints: V3CheckpointStore;
  /** The current draft revision (owner-only compliance fields of its spec survive the build). */
  currentSpec(): Promise<{ spec: AppSpec; version: number }>;
  /** Writes the spec and the whole file set as one draft revision (other ui/** and functions/** files are removed). */
  commit(input: {
    spec: AppSpec;
    files: Readonly<Record<string, string>>;
    summary_ru: string;
  }): Promise<{ revision: number }>;
  /** A gate on the current draft revision. */
  runGates(
    level: V3GateLevel,
    overrides?: { goalScenarios?: readonly GoalScenarioInput[] },
  ): Promise<GateReport>;
  /** The page writer of V3-12. */
  composer: PageComposer;
  /** Live preview of the draft (platform: G0 → bundle → preview revision); absent — no preview step. */
  preview?(): Promise<{ ok: boolean; problems: string[]; unavailable?: boolean }>;
  /** Browser check of one scenario on the committed draft; absent — scenarios are accepted after the composer's lint. */
  checkScenario?(input: ScenarioCheckInput): Promise<ScenarioCheckResult>;
  /** true: the final G1 gets the goal scenarios of the done brief scenarios (a browser runs them). */
  goalBrowser?: boolean;
  /** Stages of V3-13…15; absent — skipped. */
  hooks?: Partial<Record<V3HookStage, V3StageHook>>;
  /** Non-blocking questions: the interview's queue (V3-03), asking without a stop, answers outside the brief. */
  questions?: {
    pending?(): Promise<V3BuildQuestion[]>;
    ask?(q: V3BuildQuestion, defaultLabel: string): Promise<void>;
    answers?(): Promise<V3QuestionAnswer[]>;
  };
  recordDevelopmentRequest?: RecordDevelopmentRequest;
  notifyReady?(notice: V3ReadyNotice): Promise<void>;
  /** Niche memory of the art director: archetypes of the latest builds of the niche, most recent first. */
  recentArchetypes?(niche: string): Promise<string[]>;
  /**
   * V3-18: the stock of the photos stage (the v2 PhotoHost: platform egress or the CI photo library, copies in the
   * platform photo library); absent or null — the site goes without stock photos.
   */
  photos?: PhotoHost | null;
  /**
   * V3-18: a read whose result the run must see the same after a worker restart (a durable step of the host's
   * workflow); absent — called directly.
   */
  once?<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /**
   * V3-20: the brief's integrations on top of the compiled backend — the host reads the stored contracts and their
   * states and returns the spec and files with functions/integrations/<id>/** (@wizard/agents/integrations
   * integrationLayer + withIntegrationLayer); null or absent — no integrations layer.
   */
  integrations?(input: {
    brief: SystemBrief;
    spec: AppSpec;
    files: Readonly<Record<string, string>>;
  }): Promise<{ spec: AppSpec; files: Record<string, string>; fingerprint: string; notes: string[] } | null>;
}

/** Caps of a build (D77 (10), (11)). */
export interface V3Limits {
  /** Hard cap of a build, ₽ (with the stages paid by earlier runs of the same inputs). */
  capRub: number;
  /** Target of a build, ₽: «should» scenarios are brought up only within it. */
  targetRub: number;
  /** Wall clock of a run, ms. */
  timeMs: number;
  /** Target of the skeleton preview, ms after «Собрать». */
  previewMs: number;
}

/** Budgets of the paid stages, ₽ (the scenarios share what the cap leaves). */
export interface V3Budgets {
  design: number;
  critic: number;
  techreview: number;
  /** Least a scenario gets: below it the scenarios stop by budget. */
  scenarioMin: number;
}

export interface V3Params {
  registry?: ModuleRegistry;
  /** Name of the system (AppSpec app.name). */
  appName?: string;
  /** The owner's own words about the business (the system's first message): the skeleton's texts (V3-18). */
  request?: string;
  /** Origin of the platform (generators link the owner's page `${platformUrl}/s/${systemId}`). */
  platformUrl?: string;
  /** Spec extension operations (C5) — data; rejected ones go to «Запросы на развитие». */
  extensions?: readonly unknown[];
  limits?: Partial<V3Limits>;
  budgets?: Partial<V3Budgets>;
  /** ₽ this run may still spend by the host's run cap (the wallet stops before the host would). */
  runCapRub?: number;
  /** ₽ per credit (models.yaml#credits.rub_per_credit; default from the registry). */
  rubPerCredit?: number;
  now?: () => number;
  /** Seed of the design (default: the system id). */
  seed?: string;
  /** Time budget of the stock photos (default: the v2 photos stage's). */
  photosTimeMs?: number;
}

export type V3FailureCode =
  | "PLAN_INVALID"
  | "MODULE_BUG"
  | "STAGE_BUDGET_EXCEEDED"
  | "GATES_FAILED"
  /** V3-18: a check could not run (infrastructure) even after a retry; retryable, the paid stages stay. */
  | "CHECKS_UNAVAILABLE"
  | "INTERNAL";

/** Per-stage line of build_metrics. */
export interface V3StageMetric {
  status: "done" | "reused" | "skipped" | "failed";
  costRub: number;
  durationMs: number;
  calls?: number;
  fallback?: boolean;
  note?: string;
}

/** Why the scenario loop stopped (D77 (10)): every scenario tried, time, the cap, or the target for «should». */
export type V3StopReason = "done" | "time" | "budget" | "target";

/** State of one brief scenario after the build. */
export interface V3ScenarioState {
  id: string;
  title: string;
  priority: "must" | "should";
  status: "passed" | "failed" | "stopped";
  /** Russian reason of a failed or stopped scenario. */
  reason?: string;
  costRub: number;
  reused?: boolean;
}

export type V3Outcome =
  | {
      status: "succeeded";
      revision: number;
      summary_ru: string;
      /** ₽ spent by this run (reused steps cost nothing). */
      costRub: number;
      durationMs: number;
      /** ms from the start to the skeleton preview (null — no preview step or it failed). */
      previewMs: number | null;
      stop: { reason: V3StopReason; message_ru: string };
      scenarios: V3ScenarioState[];
      stages: Partial<Record<V3Stage, V3StageMetric>>;
    }
  | {
      status: "failed";
      code: V3FailureCode;
      message_ru: string;
      retryable: boolean;
      costRub: number;
      stages: Partial<Record<V3Stage, V3StageMetric>>;
      reports?: GateReport[];
    };
