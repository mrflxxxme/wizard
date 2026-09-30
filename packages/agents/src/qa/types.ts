// QA agent contracts (specs/agents/qa.yaml): checks for G1/G2 and Explanation of G1 failures.
import type { QaCheck, Scenario } from "@wizard/gates";
import type { OrgPolicy, RouteContext } from "@wizard/llm";
import type { QaExplainInput, QaGenerateInput } from "../builder/types.js";
import type { AgentEventSink, RouteFn, RunStepFn } from "../core/index.js";

export const EXPLANATION_CATEGORIES = [
  "permission_too_broad",
  "permission_too_narrow",
  "missing_entity_or_field",
  "wrong_status_flow",
  "function_error",
  "validation_mismatch",
  "workflow_not_triggered",
  "connector_mock_mismatch",
  "seed_problem",
  "check_invalid",
] as const;
export type ExplanationCategory = (typeof EXPLANATION_CATEGORIES)[number];

/** qa.yaml#explain.Explanation. */
export interface Explanation {
  checkId: string;
  acId?: string;
  category: ExplanationCategory;
  /** ≤ 200 */
  expected: string;
  /** ≤ 300, no values of pii≠none fields. */
  actual: string;
  /** ≤ 300, Russian. */
  likelyCause: string;
  fix: { kind: "ops" | "code" | "none"; target: string; suggestion: string };
  owner: "builder" | "qa";
}

/** Cached scenarios of one AC: valid ones, or the validation errors after the repeat (check_invalid). */
export interface CachedAc {
  scenarios: Scenario[];
  invalid?: string[];
}

/** Scenario cache (qa.yaml#checks.determinism); platform-api may persist it, the default is in memory. */
export interface QaCache {
  get(key: string): CachedAc | undefined | Promise<CachedAc | undefined>;
  set(key: string, value: CachedAc): void | Promise<void>;
}

export interface QaAgentOptions {
  route: RouteFn;
  orgPolicy?: OrgPolicy | null;
  ctx?: RouteContext;
  cache?: QaCache;
  /** Default: env WIZARD_MILESTONE, else M0. */
  milestone?: string;
  runStep?: RunStepFn;
  onEvent?: AgentEventSink;
  signal?: AbortSignal;
}

export interface QaAgent {
  generate(input: QaGenerateInput): Promise<QaCheck[]>;
  explain(input: QaExplainInput): Promise<Explanation[]>;
}
