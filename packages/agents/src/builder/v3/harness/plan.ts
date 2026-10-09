// The backend plan of a v3 build from its brief, by code (builder-v3.md C5; D77 (9) — the brief replaces the plan of
// D76 (4), «алгоритмы вперёд моделей» D77 (11)): the deterministic planner of B2-41 reads the brief's words (goals,
// scenarios, roles, data) for the niche, the goals and the candidate modules; the scenarios' moduleHint add their
// modules; the planner's parameter questions become non-blocking questions of the build — the plan takes the
// recommended option until the owner answers, then the answer (V3QuestionAnswer).
import type { SystemBrief, SystemPlan } from "@wizard/appspec";
import type { ModuleRegistry } from "@wizard/modules";
import { availableModules } from "../../../planner/catalog.js";
import { editPlan } from "../../../planner/edits.js";
import { fallbackAnalysis, fallbackNiche, fallbackPlan } from "../../../planner/fallback.js";
import type { GoalAnswer, GoalQuestion } from "../../../planner/schemas.js";
import type { V3BuildQuestion, V3QuestionAnswer } from "./types.js";

/** The words of a brief the deterministic planner reads: audience, goals, scenarios, roles, data, integrations. */
export function briefText(brief: SystemBrief): string {
  return [
    brief.audience,
    ...brief.goals.map((g) => g.text),
    ...brief.scenarios.map((s) => `Когда ${s.when}, система ${s.then.join(", ")}.`),
    ...brief.roles.map((r) => `${r.name}: ${r.can.join(", ")}`),
    ...brief.data.map((d) => d.entity),
    ...brief.integrations.map((i) => i.name),
  ]
    .filter((x) => x.trim().length > 0)
    .join("\n");
}

/** Niche of a brief by its words (the art director and the niche memory). */
export const briefNiche = (brief: SystemBrief): string => fallbackNiche(briefText(brief));

const questionId = (q: GoalQuestion) =>
  q.topic === "params" ? `plan_${q.module}_${q.param}` : `plan_${q.topic}`;

/**
 * Questions the build asks without stopping: module parameters the planner would ask about, and who works in the
 * system when the brief names no roles.
 */
function buildQuestions(brief: SystemBrief, questions: readonly GoalQuestion[]): V3BuildQuestion[] {
  return questions
    .filter((q) => q.topic === "params" || (q.topic === "roles" && brief.roles.length === 0))
    .map((q) => ({
      id: questionId(q),
      text: q.text,
      options: q.options.map((o) => ({ id: o.id, label: o.label })),
      recommended: q.options.find((o) => o.recommended)?.id ?? q.options[0]?.id ?? "",
      why: q.whyItMatters,
      ...(q.topic === "params" && q.module && q.param ? { param: { module: q.module, param: q.param } } : {}),
    }));
}

export interface BriefPlan {
  plan: SystemPlan;
  /** Non-blocking questions with the option the plan took. */
  questions: V3BuildQuestion[];
  /** Module hints of the scenarios the catalog cannot build yet (for «Запросы на развитие»). */
  unavailable: string[];
}

/**
 * The plan of a brief: the planner's goals and modules (answers: the owner's, else the recommended option; the
 * brief's roles answer «who works» — two and more → the staff module), plus the scenarios' moduleHint modules.
 * null — nothing compiles (an empty catalog).
 */
export function briefPlan(
  brief: SystemBrief,
  registry: ModuleRegistry,
  answers: readonly V3QuestionAnswer[] = [],
  opts: { appName?: string } = {},
): BriefPlan | null {
  const analysis = fallbackAnalysis(briefText(brief), registry);
  const questions = buildQuestions(brief, analysis.questions);
  const chosen = new Map(answers.map((a) => [a.questionId, a.optionId]));
  const goalAnswers: GoalAnswer[] = [];
  for (const q of analysis.questions) {
    if (q.topic === "goals") continue;
    const own = chosen.get(questionId(q));
    const rec = q.options.find((o) => o.recommended)?.id;
    const roles = q.topic === "roles" && brief.roles.length > 0;
    const optionId = roles ? (brief.roles.length >= 2 ? "team" : "admin") : (own ?? rec);
    if (!optionId || !q.options.some((o) => o.id === optionId)) continue;
    goalAnswers.push({ questionId: q.id, optionId, byRecommendation: !roles && own === undefined });
  }
  const base = fallbackPlan(
    { analysis, questions: analysis.questions, answers: goalAnswers },
    registry,
    opts,
  );
  if (!base) return null;
  let plan = base.plan;
  const ok = availableModules(registry);
  const unavailable: string[] = [];
  for (const s of brief.scenarios) {
    const m = s.moduleHint;
    if (!m || plan.modules.some((x) => x.id === m)) continue;
    if (!ok.has(m)) {
      if (!unavailable.includes(m)) unavailable.push(m);
      continue;
    }
    const r = editPlan(plan, [{ op: "add_module", module: m }], registry);
    if (r.ok) plan = r.plan;
    else unavailable.push(m);
  }
  return { plan, questions, unavailable };
}
