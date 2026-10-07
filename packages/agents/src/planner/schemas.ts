// zod schemas of the beta v2 goal interview and planner (specs/modules/modules.yaml#system_plan, #ai_rules;
// docs/reviews/grill-6.md decisions 2, 3, 5): the goals analysis with button questions, answers, the submit_plan input.
import { goalIdSchema, identSchema, OUT_OF_SCOPE_CATEGORIES, systemPlanSchema } from "@wizard/appspec";
import { z } from "zod";

const str = (max: number) => z.string().trim().min(1).max(max);

/** At most this many interview questions per brief: only what the brief does not answer (B2-20). */
export const MAX_GOAL_QUESTIONS = 4;

/** What a question clarifies: business goals, niche, roles, resources (who/what is booked or tracked), module params. */
export const GOAL_TOPICS = ["goals", "niche", "roles", "resources", "params"] as const;

export const goalOptionSchema = z.object({
  id: z.string().min(1).max(40),
  label: str(60),
  description: str(140).optional(),
  recommended: z.boolean(),
});

export const goalQuestionSchema = z.object({
  id: z.string().regex(/^q[1-4]$/),
  topic: z.enum(GOAL_TOPICS),
  /** topic=params: the catalog module and parameter the answer sets. */
  module: identSchema.optional(),
  param: identSchema.optional(),
  text: str(140),
  whyItMatters: str(160),
  options: z
    .array(goalOptionSchema)
    .min(2)
    .max(4)
    .refine((o) => o.filter((x) => x.recommended).length === 1, "Ровно один вариант должен быть recommended"),
  allowCustom: z.boolean().default(true),
});
export type GoalQuestion = z.infer<typeof goalQuestionSchema>;

/** submit_goals: what the brief already says, plus the questions for what it does not (≤ MAX_GOAL_QUESTIONS). */
export const goalsAnalysisSchema = z.object({
  niche: z.string().trim().min(2).max(80),
  goals: z
    .array(z.object({ id: goalIdSchema, statement: z.string().trim().min(3).max(200) }))
    .min(1)
    .max(3),
  /** People who work with the system besides the owner («администратор», «врач»). */
  roles: z.array(str(60)).max(6),
  /** What is booked, sold or tracked («кресла», «услуги», «инструмент»). */
  resources: z.array(str(60)).max(10),
  /** Catalog modules the goals need (available or not; the planner decides). */
  modules: z.array(z.object({ id: identSchema, why: str(160) })).max(12),
  /** What the client asked that no module does. */
  outOfScope: z.array(z.object({ request: str(300), category: z.enum(OUT_OF_SCOPE_CATEGORIES) })).max(10),
  questions: z.array(goalQuestionSchema).max(MAX_GOAL_QUESTIONS),
});
export type GoalsAnalysis = z.infer<typeof goalsAnalysisSchema>;

export const goalAnswerSchema = z
  .object({
    questionId: z.string().regex(/^q[1-4]$/),
    optionId: z.string().min(1).optional(),
    text: z.string().trim().min(1).max(500).optional(),
    byRecommendation: z.boolean(),
  })
  .refine((a) => (a.optionId === undefined) !== (a.text === undefined), "Нужен либо optionId, либо text");
export type GoalAnswer = z.infer<typeof goalAnswerSchema>;

const planShape = systemPlanSchema.shape;

/**
 * submit_plan input: SystemPlan where version, outOfScope and custom have defaults and design is optional (the code
 * fills a default until the design agent, B2-37). The full check is validateSystemPlan (custom limits included).
 */
export const plannerPlanSchema = z.strictObject({
  ...planShape,
  version: z.literal(1).default(1),
  // Stock photos are picked by the builder (B2-38), never written by the planner.
  design: planShape.design.omit({ photos: true }).optional(),
  outOfScope: planShape.outOfScope.default([]),
  custom: planShape.custom.default([]),
});
export type PlannerPlan = z.infer<typeof plannerPlanSchema>;
