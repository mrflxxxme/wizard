// Goal interview of beta v2 (B2-20; grill-6 decision 5): brief → 1–3 business goals from the closed vocabulary, niche,
// roles and resources, and button questions only for what the brief does not say (≤ MAX_GOAL_QUESTIONS, one
// recommended option each) → the planner (planner.ts) → a plan that waits for the client's approval. Stateless between
// turns like the orchestrator: the host persists GoalSession (JSON) and the outputs.
// B2-41: a crooked model answer never ends the interview — tolerant reading (tolerant.ts), ≤ 2 repairs with the issues
// as the tool result, then the fallback without a model (fallback.ts): deterministic questions on the interview turn,
// the previous plan or a plan from the interview on the plan turn, else one more planner run. Each such answer is an
// internal orch_invalid event {step, fallback, issues} (workflows.yaml#events) for the diagnosis and the metrics.
import { randomUUID } from "node:crypto";
import type { PlanError, SystemPlan } from "@wizard/appspec";
import { LlmError, type OrgPolicy, type RouteContext } from "@wizard/llm";
import { type CompileResult, compilePlan, type ModuleRegistry, planCatalog } from "@wizard/modules";
import { scrubJson } from "@wizard/pii";
import { AgentError } from "../core/errors.js";
import type { AgentEventSink, EmitFn, RunStepFn } from "../core/events.js";
import { type CallBase, callTool, type RouteFn } from "../core/loop.js";
import { defineTool, type ToolIssue } from "../core/tool.js";
import { type CapabilityGap, type RecordDevelopmentRequest, reportCapabilityGapTool } from "../gaps.js";
import { piiCategories, piiNoticeText } from "../orchestrator/pii.js";
import { DEFAULT_REGISTRY } from "./catalog.js";
import { fallbackAnalysis, fallbackPlan } from "./fallback.js";
import { type PlannerResult, runPlanner } from "./planner.js";
import { answerLines, interviewMessages } from "./prompt.js";
import {
  type GoalAnswer,
  type GoalQuestion,
  type GoalsAnalysis,
  goalsAnalysisSchema,
  MAX_GOAL_QUESTIONS,
} from "./schemas.js";
import { interviewSketch, type PlanSketch, planSketch } from "./sketch.js";
import { normalizeGoalsArgs } from "./tolerant.js";

/** Repair rounds of submit_goals after the tolerant reading (models.yaml#call_policy.structured_output). */
export const GOAL_REPAIRS = 2;

/** What replaced an answer that did not pass: none — the turn failed. */
export type InvalidFallback = "questions" | "previous_plan" | "plan" | "retry" | "none";

/** One model answer that did not pass after the repairs (orch_invalid payload without the size limits). */
export interface InvalidNote {
  step: "interview" | "system_plan";
  fallback: InvalidFallback;
  issues: ToolIssue[];
}

export type GoalState = "idle" | "asking" | "planned" | "failed";

export interface GoalSession {
  v: 1;
  /** Marks the beta v2 path: the host keeps a system on the pipeline it started with. */
  pipeline: "modules";
  state: GoalState;
  brief: string | null;
  piiInBrief: boolean;
  piiNoticeShown: boolean;
  analysis: GoalsAnalysis | null;
  questions: GoalQuestion[];
  answers: GoalAnswer[];
  /** Client's wishes about the plan in words (each re-plans with the model). */
  edits: string[];
  /** The last plan the planner produced (deterministic edits live with the host's plan revisions). */
  plan: SystemPlan | null;
  llmCalls: number;
  creditsCharged: number;
  seenKeys: string[];
  gaps: CapabilityGap[];
}

export type GoalOutput =
  | {
      id: string;
      role: "system";
      kind: "notice";
      text: string;
      payload: { type: "pii"; categories: string[] };
    }
  | {
      id: string;
      role: "assistant";
      kind: "questions";
      text: string;
      questions: GoalQuestion[];
      sketch: PlanSketch;
      gaps?: CapabilityGap[];
    }
  | {
      id: string;
      role: "assistant";
      kind: "plan";
      text: string;
      plan: SystemPlan;
      /** Errors of the final compilation (empty — the plan compiles and can be approved). */
      errors: PlanError[];
      sketch: PlanSketch;
      gaps?: CapabilityGap[];
    }
  | { id: string; role: "assistant"; kind: "text"; text: string; gaps?: CapabilityGap[] };

export interface GoalTurnFailure {
  code: "ORCH_INVALID_OUTPUT" | "LLM_UNAVAILABLE" | "BUDGET_STOPPED";
  message_ru: string;
  retryable: boolean;
  cause?: string;
  issues?: ToolIssue[];
}

export interface GoalTurnResult {
  session: GoalSession;
  outputs: GoalOutput[];
  failure?: GoalTurnFailure;
}

export interface GoalInterviewDeps {
  route: RouteFn;
  orgPolicy: OrgPolicy | null;
  ctx: RouteContext;
  /** Module registry (default — @wizard/modules CATALOG). */
  registry?: ModuleRegistry;
  /** Name of the system for the compiled spec. */
  appName?: string;
  emit?: EmitFn;
  runStep?: RunStepFn;
  onEvent?: AgentEventSink;
  newId?: () => string;
  recordDevelopmentRequest?: RecordDevelopmentRequest;
}

export function newGoalSession(): GoalSession {
  return {
    v: 1,
    pipeline: "modules",
    state: "idle",
    brief: null,
    piiInBrief: false,
    piiNoticeShown: false,
    analysis: null,
    questions: [],
    answers: [],
    edits: [],
    plan: null,
    llmCalls: 0,
    creditsCharged: 0,
    seenKeys: [],
    gaps: [],
  };
}

/** A stored executor state of the beta v2 path (else — the v1 orchestrator's OrchSession). */
export function isGoalSession(state: unknown): state is GoalSession {
  return (
    typeof state === "object" && state !== null && (state as { pipeline?: unknown }).pipeline === "modules"
  );
}

const MSG = {
  questions: (n: number) =>
    n === 1
      ? "Остался один вопрос, чтобы составить план системы."
      : `Есть ${n} ${n >= 2 && n <= 4 ? "вопроса" : "вопросов"}, чтобы составить план системы.`,
  plan: "План системы готов: цели, модули и что не входит. Проверьте и утвердите — сборка начнётся только после этого.",
  planErrors:
    "План готов, но в нём есть ошибки — поправьте отмеченное на экране плана или напишите, что изменить.",
  remaining: "Ответьте на оставшиеся вопросы или нажмите «Остальное — по рекомендациям».",
  invalid: "Не удалось разобрать ответ модели. Попробуйте ещё раз.",
  /** B2-41: the plan turn failed even after the fallback and one more planner run. */
  planInvalid:
    "Не получилось составить план по этим ответам. Нажмите «Повторить» или напишите, что изменить в описании.",
  /** B2-41: a wish about the plan the planner could not apply — the previous plan stays. */
  revisionKept:
    "Не получилось применить это пожелание автоматически — план остался прежним. Поправьте его на экране плана или напишите пожелание иначе.",
  unavailable: "Модели сейчас недоступны. Попробуйте позже.",
  budget: "Лимит кредитов на этот шаг исчерпан.",
};

class InvalidOutput extends Error {
  constructor(
    readonly issues: ToolIssue[],
    readonly step: InvalidNote["step"] = "interview",
  ) {
    super("ORCH_INVALID_OUTPUT");
  }
}

/** Per-turn notes of answers that did not pass (emitted as orch_invalid when the turn ends). */
interface TurnCtx {
  invalid: InvalidNote[];
}

/** Semantic checks of submit_goals: catalog modules, distinct goals, sequential questions with known params. */
export function checkGoalsAnalysis(a: GoalsAnalysis, registry: ModuleRegistry): ToolIssue[] {
  const issues: ToolIssue[] = [];
  const byId = new Map(planCatalog(registry).modules.map((m) => [m.id, m]));
  const goals = a.goals.map((g) => g.id);
  if (new Set(goals).size !== goals.length)
    issues.push({ path: "goals", code: "DUPLICATE_GOAL", message: "Цели не должны повторяться" });
  a.modules.forEach((m, i) => {
    if (!byId.has(m.id))
      issues.push({
        path: `modules.${i}.id`,
        code: "UNKNOWN_MODULE",
        message: `Модуля «${m.id}» нет в каталоге; допустимо: ${[...byId.keys()].join(", ")}`,
      });
  });
  a.questions.forEach((q, i) => {
    if (q.id !== `q${i + 1}`)
      issues.push({ path: `questions.${i}.id`, message: `Вопросы нумеруются по порядку: q${i + 1}` });
    if (q.topic !== "params") return;
    const m = q.module ? byId.get(q.module) : undefined;
    if (!m?.params.some((p) => p.name === q.param))
      issues.push({
        path: `questions.${i}`,
        message: "Вопрос о параметре: укажи module и param из каталога",
      });
  });
  return issues;
}

export class GoalInterview {
  private readonly deps: GoalInterviewDeps;
  private readonly registry: ModuleRegistry;

  constructor(deps: GoalInterviewDeps) {
    this.deps = deps;
    this.registry = deps.registry ?? DEFAULT_REGISTRY;
  }

  /** Brief → goals analysis → questions, or straight to the plan when the brief answers everything. */
  submitBrief(
    session: GoalSession,
    brief: string,
    opts: { idempotencyKey?: string } = {},
  ): Promise<GoalTurnResult> {
    return this.turn(session, opts, async (s, out, ctx) => {
      if (brief.trim().length === 0)
        throw new AgentError("INVALID_INPUT", "Опишите задачу хотя бы парой предложений.");
      Object.assign(s, { ...newGoalSession(), seenKeys: s.seenKeys, piiNoticeShown: s.piiNoticeShown });
      s.brief = brief;
      this.dlp(s, out, brief);
      const r = await callTool({
        ...this.base(s, "interview"),
        messages: interviewMessages(this.registry, brief),
        tool: defineTool({
          name: "submit_goals",
          description:
            "Business goals (closed vocabulary), niche, roles, resources, catalog modules, out of scope, and button questions only for what the brief does not say.",
          input: goalsAnalysisSchema,
          normalize: (v) => normalizeGoalsArgs(v, this.registry),
          check: (v) => checkGoalsAnalysis(v, this.registry),
        }),
        sideTools: [this.gapTool(s)],
        maxRepairs: GOAL_REPAIRS,
        textArgs: true,
      });
      this.count(s, r.stats);
      // B2-41: still not valid after the repairs → deterministic questions from the brief and the catalog.
      if (!r.ok) ctx.invalid.push({ step: "interview", fallback: "questions", issues: r.issues });
      // PII from the brief never reaches the analysis, the questions or the plan.
      const analysis = scrubJson(r.ok ? r.value : fallbackAnalysis(brief, this.registry)).value;
      s.analysis = analysis;
      s.questions = analysis.questions.slice(0, MAX_GOAL_QUESTIONS);
      if (s.questions.length === 0) return this.plan(s, out, ctx);
      s.state = "asking";
      out.push({
        id: this.id(),
        role: "assistant",
        kind: "questions",
        text: MSG.questions(s.questions.length),
        questions: s.questions,
        sketch: interviewSketch(analysis, this.registry),
      });
    });
  }

  /**
   * Answers to the open questions (an option or a custom text ≤ 500); restByRecommendation fills the rest. When all
   * are answered — the planner.
   */
  answer(
    session: GoalSession,
    answers: readonly { questionId: string; optionId?: string; text?: string }[],
    o: { restByRecommendation?: boolean; idempotencyKey?: string } = {},
  ): Promise<GoalTurnResult> {
    return this.turn(session, o, async (s, out, ctx) => {
      if (s.state !== "asking") throw new AgentError("INVALID_INPUT", "Нет вопросов, ожидающих ответа.");
      for (const a of answers) {
        const q = s.questions.find((x) => x.id === a.questionId);
        if (!q) throw new AgentError("INVALID_INPUT", "Такого вопроса нет.", { questionId: a.questionId });
        if (s.answers.some((x) => x.questionId === q.id)) continue;
        if (a.optionId !== undefined) {
          if (!q.options.some((x) => x.id === a.optionId))
            throw new AgentError("INVALID_INPUT", "Такого варианта нет.", { optionId: a.optionId });
          s.answers.push({ questionId: q.id, optionId: a.optionId, byRecommendation: false });
        } else {
          const text = a.text?.trim() ?? "";
          if (!q.allowCustom || text.length === 0 || text.length > 500)
            throw new AgentError("INVALID_INPUT", "Свой вариант — до 500 символов.");
          this.dlp(s, out, text);
          s.answers.push({ questionId: q.id, text, byRecommendation: false });
        }
      }
      if (o.restByRecommendation)
        for (const q of s.questions) {
          if (s.answers.some((x) => x.questionId === q.id)) continue;
          const rec = q.options.find((x) => x.recommended) ?? q.options[0];
          if (rec) s.answers.push({ questionId: q.id, optionId: rec.id, byRecommendation: true });
        }
      if (s.questions.some((q) => !s.answers.some((a) => a.questionId === q.id))) {
        out.push({ id: this.id(), role: "assistant", kind: "text", text: MSG.remaining });
        return;
      }
      await this.plan(s, out, ctx);
    });
  }

  /** A wish about the plan in words: the planner again with the previous plan and all wishes. */
  revise(session: GoalSession, text: string, o: { idempotencyKey?: string } = {}): Promise<GoalTurnResult> {
    return this.turn(session, o, async (s, out, ctx) => {
      this.dlp(s, out, text);
      s.edits.push(text.trim().slice(0, 1000));
      await this.plan(s, out, ctx);
    });
  }

  // ------------------------------------------------------------------ steps

  private runPlanner(s: GoalSession): Promise<PlannerResult> {
    return runPlanner(
      this.base(s, "system_plan"),
      {
        brief: s.brief ?? "",
        analysis: s.analysis,
        answers: answerLines(s.questions, s.answers),
        edits: s.edits,
        previousPlan: s.plan,
      },
      { registry: this.registry, ...(this.deps.appName ? { appName: this.deps.appName } : {}) },
    );
  }

  private async plan(s: GoalSession, out: GoalOutput[], ctx: TurnCtx): Promise<void> {
    const r = await this.runPlanner(s);
    this.count(s, r.stats);
    if (r.ok) return this.showPlan(s, out, r.plan, r.compiled);
    const opts = this.deps.appName ? { appName: this.deps.appName } : {};
    // B2-41 fallback of the plan turn, without a model first.
    // 1. A wish the planner could not apply: the previous plan stays, the wish is dropped (it would fail again).
    if (s.plan && s.edits.length > 0) {
      ctx.invalid.push({ step: "system_plan", fallback: "previous_plan", issues: r.issues });
      s.edits.pop();
      const previous = s.plan;
      const compiled = compilePlan(previous, this.registry, opts);
      return this.showPlan(s, out, compiled.ok ? compiled.plan : previous, compiled, MSG.revisionKept);
    }
    // 2. A plan from the interview: its goals, the candidate modules with the answered parameters.
    const fb = fallbackPlan(
      { analysis: s.analysis, questions: s.questions, answers: s.answers },
      this.registry,
      opts,
    );
    if (fb) {
      ctx.invalid.push({ step: "system_plan", fallback: "plan", issues: r.issues });
      return this.showPlan(s, out, fb.plan, fb.compiled);
    }
    // 3. Not possible deterministically: one more planner run, as the client's «Повторить» would do.
    ctx.invalid.push({ step: "system_plan", fallback: "retry", issues: r.issues });
    const again = await this.runPlanner(s);
    this.count(s, again.stats);
    if (!again.ok) throw new InvalidOutput(again.issues, "system_plan");
    return this.showPlan(s, out, again.plan, again.compiled);
  }

  private showPlan(
    s: GoalSession,
    out: GoalOutput[],
    plan: SystemPlan,
    compiled: CompileResult,
    text?: string,
  ): void {
    s.plan = plan;
    s.state = "planned";
    const errors = compiled.ok ? [] : compiled.errors;
    out.push({
      id: this.id(),
      role: "assistant",
      kind: "plan",
      text: text ?? (errors.length ? MSG.planErrors : MSG.plan),
      plan,
      errors,
      sketch: planSketch(plan, compiled, this.registry),
    });
  }

  // ------------------------------------------------------------------ helpers

  private gapTool(s: GoalSession) {
    return reportCapabilityGapTool({
      record: this.deps.recordDevelopmentRequest,
      known: s.gaps,
      onGap: (g) => {
        s.gaps = [...s.gaps, g];
      },
    });
  }

  private base(s: GoalSession, callType: "interview" | "system_plan"): CallBase {
    return {
      route: this.deps.route,
      callType,
      orgPolicy: this.deps.orgPolicy,
      ctx: this.deps.ctx,
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {}),
      ...(this.deps.runStep ? { runStep: this.deps.runStep } : {}),
      stepName: `orchestrate:${callType}:${s.llmCalls + 1}`,
    };
  }

  private count(s: GoalSession, stats: { calls: number; creditsCharged: number }): void {
    s.llmCalls += stats.calls;
    s.creditsCharged = Math.round((s.creditsCharged + stats.creditsCharged) * 1000) / 1000;
  }

  private async turn(
    session: GoalSession,
    opts: { idempotencyKey?: string },
    body: (s: GoalSession, out: GoalOutput[], ctx: TurnCtx) => Promise<unknown>,
  ): Promise<GoalTurnResult> {
    if (opts.idempotencyKey !== undefined && session.seenKeys.includes(opts.idempotencyKey))
      return { session, outputs: [] };
    const s = structuredClone(session);
    const known = s.gaps.length;
    const outputs: GoalOutput[] = [];
    const res: GoalTurnResult = { session: s, outputs };
    const ctx: TurnCtx = { invalid: [] };
    try {
      await body(s, outputs, ctx);
    } catch (e) {
      if (e instanceof InvalidOutput) {
        s.state = "failed";
        ctx.invalid.push({ step: e.step, fallback: "none", issues: e.issues });
        res.failure = {
          code: "ORCH_INVALID_OUTPUT",
          message_ru: e.step === "system_plan" ? MSG.planInvalid : MSG.invalid,
          retryable: true,
          issues: e.issues,
        };
      } else if (e instanceof LlmError) {
        const budget = e.code === "BUDGET_EXCEEDED";
        s.state = "failed";
        res.failure = {
          code: budget ? "BUDGET_STOPPED" : "LLM_UNAVAILABLE",
          message_ru: budget ? MSG.budget : MSG.unavailable,
          retryable: !budget,
          cause: e.code,
        };
      } else throw e;
    }
    const gaps = s.gaps.slice(known);
    const main = [...outputs].reverse().find((o) => o.kind !== "notice");
    if (gaps.length && main?.role === "assistant") main.gaps = gaps;
    if (opts.idempotencyKey !== undefined) s.seenKeys.push(opts.idempotencyKey);
    // Internal diagnosis (never shown to the client): what did not pass and what replaced it.
    for (const n of ctx.invalid)
      await this.deps.emit?.("orch_invalid", {
        step: n.step,
        fallback: n.fallback,
        issues: n.issues.slice(0, 10).map((i) => ({
          path: i.path,
          ...(i.code ? { code: i.code } : {}),
          message: String(i.message).slice(0, 160),
        })),
      });
    return res;
  }

  private dlp(s: GoalSession, out: GoalOutput[], text: string): void {
    const categories = piiCategories(text);
    if (categories.length === 0) return;
    s.piiInBrief = true;
    if (s.piiNoticeShown) return;
    s.piiNoticeShown = true;
    out.push({
      id: this.id(),
      role: "system",
      kind: "notice",
      text: piiNoticeText(categories),
      payload: { type: "pii", categories },
    });
  }

  private id(): string {
    return (this.deps.newId ?? randomUUID)();
  }
}

export function createGoalInterview(deps: GoalInterviewDeps): GoalInterview {
  return new GoalInterview(deps);
}
