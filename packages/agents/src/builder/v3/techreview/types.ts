// Types of the techreview of the build harness v3 (V3-15; specs/agents/builder-v3.md §3 C6 stage 7, product.yaml
// D77_v3 (10): a mandatory techreview — the deterministic part, then a reviewer on a model of another family than the
// builder, ≤ 2 rounds of fixes, blockers → the system is not published).
import type { AppSpec, ExtensionOp } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import type { ModuleRegistry } from "@wizard/modules";
import type { IntegrationContract } from "../../../integrations/index.js";

/** Areas of the deterministic checks. */
export const TECH_AREAS = [
  "build",
  "migrations",
  "rls",
  "pii",
  "permissions",
  "security",
  "integrations",
  "chains",
  "performance",
  "accessibility",
] as const;
export type TechArea = (typeof TECH_AREAS)[number];

/** Russian names of the areas (blockers and notes read «<область>: <что не так>»). */
export const TECH_AREA_RU: Record<TechArea | ReviewArea, string> = {
  build: "Сборка и типы",
  migrations: "Миграции",
  rls: "Права в базе (RLS)",
  pii: "Персональные данные",
  permissions: "Права",
  security: "Безопасность",
  integrations: "Интеграции",
  chains: "Связи модулей",
  performance: "Скорость",
  accessibility: "Доступность",
  data: "Связность данных",
  errors: "Обработка ошибок",
  edge_cases: "Краевые случаи",
};

/** One deterministic check of the techreview: a gate check mapped to its area, or a check of the techreview itself. */
export interface TechCheck {
  /** Gate check id (G0-TS-01, G2-PII-02…) or a techreview one (TR-CHAIN-lead_owner, TR-A11Y-01…). */
  id: string;
  area: TechArea;
  status: "pass" | "fail" | "warn" | "skip";
  severity: "blocker" | "warning";
  message_ru: string;
  /** Short technical evidence (no client data). */
  evidence?: string;
  /** Where: a JSON pointer into the spec (/workflows/2) or a file path (ui/pages/Home.tsx:12). */
  ref?: string;
}

/** The system under review: the spec and the files of the build context. */
export interface TechSystem {
  spec: AppSpec;
  files: ReadonlyMap<string, string>;
}

/** Gates the deterministic part runs on the system as it is (G1 with the runtime is the final gates stage). */
export type TechGateLevel = "G0" | "G2";

/** An integration contract of the system (V3-20) with its state on the platform. */
export interface TechContract {
  /** Integration id of the brief = the contract id (functions/integrations/<id>/**). */
  integrationId: string;
  contract: IntegrationContract;
  version: number;
  /** mock — no key yet; live — the V3-20 key check passed; failed — the key or the contract did not pass it. */
  status: "mock" | "live" | "failed";
  /** The V3-20 key check (its Russian message), null — not checked yet. */
  keyCheck: { ok: boolean; message_ru: string } | null;
}

/** Result of the contract tests of one integration (V3-20: contract → typed client → mock → contract tests). */
export interface IntegrationContractResult {
  ok: boolean;
  /** true — the tests ran against the deterministic mock of the contract. */
  mock: boolean;
  /** Russian problems, no secret values. */
  problems: string[];
}

/**
 * Contract tests of one integration contract (default: the V3-20 contract tests on its deterministic mock; the live
 * side is the V3-20 key check, read from the contract's state).
 */
export type IntegrationContractRunner = (
  contract: TechContract,
  system: TechSystem,
) => Promise<IntegrationContractResult>;

/** A «Запрос на развитие» the techreview leaves (a chain the module catalog does not close, an unapplied fix). */
export interface TechRequest {
  key: string;
  quote_ru: string;
  offered_ru: string | null;
}

/** What the host gives the techreview. */
export interface TechreviewDeps {
  /**
   * A gate over the system as it is now — not committed yet (platform: G0 with the migration dry run in the shadow
   * schema against the preview revision, G2 static checks). Absent — the same gates in process without a database:
   * G0 without G0-MIG-02 (the migration is planned and its DDL and RLS built instead) and the static G2.
   */
  gates?: (level: TechGateLevel, system: TechSystem) => Promise<GateReport>;
  /**
   * Gate reports already run on the committed draft (platform: the latest G1 of this run — acceptance scenarios with
   * the module chains through the runtime). Evidence only: a failure there is a warning — the final G1 decides.
   */
  evidence?: () => Promise<readonly GateReport[]>;
  /** The stored contracts of the system's integrations (V3-20; platform: their latest versions with the state). */
  contracts?: () => Promise<readonly TechContract[]>;
  /** Contract tests of one contract; default — the V3-20 contract tests on the mock (contractTests). */
  integrations?: IntegrationContractRunner;
  /** Module catalog the plan is compiled with (reference for the module chains); default — the planner's. */
  registry?: ModuleRegistry;
  /**
   * Model families of this run's builder (models.yaml#routes.techreview: the reviewer is of another family). Default —
   * the heads of the builder routes (page_compose, signature_section, art_direction).
   */
  builderFamilies?: () => Promise<readonly string[]>;
  /** Rounds of fixes, ≤ 2 (D77 (10)). */
  maxRounds?: number;
  /**
   * The harness merges the extension fixes into the spec (V3HookResult.extensions: it compiles the backend again with
   * them). Off: an extension fix is checked under the gates but not applied — the finding stays, explained, and goes to
   * «Запросы на развитие».
   */
  applyExtensions?: boolean;
  /** «Запросы на развитие». */
  request?: (r: TechRequest) => Promise<void>;
  /** ₽ per credit (reviewer cost in the outcome). */
  rubPerCredit?: number;
}

export const REVIEW_AREAS = [
  "data",
  "permissions",
  "errors",
  "edge_cases",
  "chains",
  "integrations",
  "performance",
  "accessibility",
] as const;
export type ReviewArea = (typeof REVIEW_AREAS)[number];

export const REVIEW_SEVERITIES = ["blocker", "major", "minor"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** How a finding is fixed: a function patch in functions/custom/**, an extension operation (C5), or nothing safe. */
export type ReviewFix =
  | { kind: "none" }
  | { kind: "function_patch"; file: string; source: string }
  | { kind: "extension"; op: Record<string, unknown> };

/** A finding of the reviewer — the closed set of submit_techreview. */
export interface ReviewFinding {
  /** r<round>-<n>. */
  id: string;
  severity: ReviewSeverity;
  area: ReviewArea;
  title_ru: string;
  evidence: { kind: "check" | "spec" | "file"; ref: string };
  fix: ReviewFix;
}

/** What happened to a fix. */
export interface FixOutcome {
  finding: string;
  kind: "function_patch" | "extension";
  round: number;
  applied: boolean;
  /** Why it was not applied (Russian). */
  reason_ru?: string;
}

/** The reviewer's part of a techreview. */
export interface ReviewerState {
  status: "done" | "skipped";
  calls: number;
  /** Model id that answered last (another family than the builder's). */
  model: string | null;
  /** Why the reviewer was skipped (budget, models unavailable). */
  reason?: string;
  /** ₽ of the reviewer calls (they go through ctx.route — the stage wallet counts them). */
  costRub: number;
  /** Findings dropped for an evidence the system does not have. */
  unfounded: number;
}

export interface TechreviewOutcome {
  /** Deterministic checks of the system after the rounds — the source of truth. */
  checks: TechCheck[];
  /** Reviewer findings still open after the rounds. */
  findings: ReviewFinding[];
  fixes: FixOutcome[];
  /** Files the fixes changed (path → new source). */
  files: Map<string, string>;
  /** Extension operations accepted under the gates (applied only with deps.applyExtensions). */
  extensions: ExtensionOp[];
  /** Russian blockers: the system is not published (D77 (10)). */
  blockers: string[];
  /**
   * The reviewer's findings about the owner's input (the personal data operator's name, contact, address): never
   * blockers of the build — publication refuses without them and asks the owner (OPERATOR_*_REQUIRED).
   */
  ownerInput: string[];
  /** Short Russian notes for the client. */
  notes: string[];
  /** Fix rounds done (≤ 2). */
  rounds: number;
  reviewer: ReviewerState;
  /** One line for build_metrics. */
  note: string;
}
