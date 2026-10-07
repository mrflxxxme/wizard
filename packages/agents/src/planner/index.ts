// @wizard/agents/planner: beta v2 goal interview, system planner, deterministic plan edits and the canvas sketch
// (B2-20; specs/modules/modules.yaml#system_plan, #ai_rules; docs/reviews/grill-6.md decisions 2, 3, 5).
/** B2-44: the short site name of a plan (its niche, normalized) when the owner has not named the system. */
export { planSiteName, siteName } from "@wizard/modules";
/** Catalog digests for prompts, modules that compile today, ready landing sections, the default design. */
export {
  availableModules,
  DEFAULT_REGISTRY,
  defaultDesign,
  goalsDigest,
  interviewCatalogDigest,
  plannerCatalogDigest,
  readySections,
  sectionsDigest,
} from "./catalog.js";
/** Deterministic plan edits (no model): applyPlanEdits(plan, edits, registry) → compiled plan | PlanError[]. */
export {
  applyPlanEdits,
  type EditResult,
  editPlan,
  type PlanEdit,
  planEditSchema,
  planEditsSchema,
} from "./edits.js";
/** B2-41 fallback without a model: deterministic questions from a brief, a plan from the interview goals and modules. */
export {
  type FallbackPlanInput,
  type FallbackPlanResult,
  fallbackAnalysis,
  fallbackGoals,
  fallbackNiche,
  fallbackPlan,
} from "./fallback.js";
/** Goal interview: brief → 1–3 goals and button questions → planner → plan awaiting approval. */
export {
  checkGoalsAnalysis,
  createGoalInterview,
  GOAL_REPAIRS,
  GoalInterview,
  type GoalInterviewDeps,
  type GoalOutput,
  type GoalSession,
  type GoalState,
  type GoalTurnFailure,
  type GoalTurnResult,
  type InvalidFallback,
  type InvalidNote,
  isGoalSession,
  newGoalSession,
} from "./interview.js";
/** Planner: submit_plan → validateSystemPlan → compilePlan, errors back to the model (≤ 2 + 1 repairs). */
export {
  finalizePlan,
  PLAN_COMPILE_REPAIRS,
  PLAN_VALIDATION_REPAIRS,
  type PlannerResult,
  planErrors,
  planIssues,
  type RunPlannerOptions,
  runPlanner,
} from "./planner.js";
/** Prompts of the interview and the planner. */
export { answerLines, interviewMessages, type PlannerPromptInput, plannerMessages } from "./prompt.js";
/** Schemas: goals analysis with button questions, answers, submit_plan input. */
export {
  GOAL_TOPICS,
  type GoalAnswer,
  type GoalQuestion,
  type GoalsAnalysis,
  goalAnswerSchema,
  goalQuestionSchema,
  goalsAnalysisSchema,
  MAX_GOAL_QUESTIONS,
  type PlannerPlan,
  plannerPlanSchema,
} from "./schemas.js";
/** Canvas sketch: interviewSketch(analysis) while asking, planSketch(plan, compiled) after. */
export { interviewSketch, type PlanSketch, planSketch, type SketchDesign } from "./sketch.js";
/** B2-41 tolerant reading of submit_goals and submit_plan before zod (no model call). */
export { clip, normalizeGoalsArgs, normalizePlanArgs } from "./tolerant.js";
/** A stored plan for the plan screen: viewPlan(plan, registry) → compiled, errors, sketch; the build's credits cap. */
export {
  type CompileResult,
  type CompileSuccess,
  type ModuleRegistry,
  PLAN_BUILD_TARGET_RUB,
  type PlanView,
  planBuildCapCredits,
  viewPlan,
} from "./view.js";
