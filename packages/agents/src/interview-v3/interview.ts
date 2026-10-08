// The v3 grill interview (V3-03; D77_v3 (8), (9), (12); grill-8 № 8, 9, 12). A turn at a time, stateless between turns
// like the v2 goal interview: the host persists InterviewV3Session (JSON) and saves session.brief as a new brief
// version (author agent). Each turn the model (interview_v3) gets the brief, the blocking gaps found by code and what
// happened, and answers with tools: submit_brief_update, then submit_question (the next blocking question) or
// finish_interview; defer_question sends non-blocking questions to the build queue; web_search and read_page find
// facts about the niche. The code owns the stop rule (blockingGaps, the cap of 15), the question → answer journal,
// the assumptions of «Решите за меня» and «Дальше решай сам», and the capability map. A crooked model answer never
// ends the interview: tolerant reading, repairs inside the tool loop, then a deterministic question (fallback.ts).
import { randomUUID } from "node:crypto";
import { emptyBrief, type SystemBrief, validateBrief } from "@wizard/appspec";
import { LlmError, type OrgPolicy, type RouteContext } from "@wizard/llm";
import type { ModuleRegistry } from "@wizard/modules";
import { scrub } from "@wizard/pii";
import type { AnyTool } from "../builder/tools.js";
import { AgentError } from "../core/errors.js";
import type { AgentEventSink, EmitFn, RunStepFn } from "../core/events.js";
import { type CallBase, type RouteFn, runToolLoop, type ToolLoopResult } from "../core/loop.js";
import { defineTool, ToolFailure, type ToolIssue } from "../core/tool.js";
import type { CapabilityGap, RecordDevelopmentRequest } from "../gaps.js";
import { piiCategories, piiNoticeText } from "../orchestrator/pii.js";
import { DEFAULT_REGISTRY } from "../planner/catalog.js";
import { clip } from "../planner/tolerant.js";
import type { Research } from "../research/research.js";
import { CAPABILITY_LABELS, capabilityCounts, normText } from "./capability.js";
import { defaultPatch, fallbackQuestion } from "./fallback.js";
import { type BlockingGap, blockingGaps, questionOrderIssues } from "./gaps.js";
import { addAssumption, addQa, applyBriefPatch, refreshCapability } from "./merge.js";
import { interviewV3Messages, type V3TurnInput } from "./prompt.js";
import { interviewResearchTools } from "./research-tools.js";
import {
  type BriefPatch,
  briefPatchSchema,
  DELEGATE_OPTION_ID,
  type DeferredQuestion,
  INTERVIEW_V3_CALL_TYPE,
  type InterviewV3Session,
  MAX_V3_QUESTIONS,
  V3_TOPIC_LABELS,
  V3_TURN_MAX_CALLS,
  type V3Question,
  type V3Topic,
  v3DeferInputSchema,
  v3FinishInputSchema,
  v3QuestionInputSchema,
} from "./schemas.js";
import { normalizeBriefPatchArgs, normalizeDeferArgs, normalizeQuestionArgs } from "./tolerant.js";

/** At most this many non-blocking questions wait for the build. */
export const MAX_DEFERRED = 20;
/** Extra requirements and facts kept by the session. */
const MAX_REQUIREMENTS = 40;
const MAX_FACTS = 10;

/** A question as the owner and the platform see it (no patches, no source). */
export interface V3PublicQuestion {
  id: string;
  topic: V3Topic;
  text: string;
  whyItMatters: string;
  recommendation: string;
  options: { id: string; label: string; description?: string; recommended: boolean }[];
  allowDelegate: boolean;
  allowCustom: true;
  /** 1-based number of the question and the cap. */
  step: number;
  max: number;
}

export type InterviewV3Output =
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
      kind: "question";
      text: string;
      question: V3PublicQuestion;
      gaps?: CapabilityGap[];
    }
  | {
      id: string;
      role: "assistant";
      kind: "brief";
      /** The short brief for the chat before «Собрать» (grill-8 № 9). */
      text: string;
      brief: SystemBrief;
      /** The build queue: non-blocking questions with the assumption used meanwhile. */
      deferred: DeferredQuestion[];
      /** Why the interview stopped: nothing blocking left, the owner's «Дальше решай сам», or the cap. */
      reason: "clear" | "owner_skip" | "cap";
      gaps?: CapabilityGap[];
    }
  | { id: string; role: "assistant"; kind: "text"; text: string; gaps?: CapabilityGap[] };

export interface InterviewV3Failure {
  code: "LLM_UNAVAILABLE" | "BUDGET_STOPPED";
  message_ru: string;
  retryable: boolean;
  cause?: string;
}

export interface InterviewV3Result {
  session: InterviewV3Session;
  outputs: InterviewV3Output[];
  failure?: InterviewV3Failure;
}

export interface InterviewV3Deps {
  route: RouteFn;
  orgPolicy: OrgPolicy | null;
  ctx: RouteContext;
  /** Module registry for the capability map and the catalog digest (default — @wizard/modules CATALOG). */
  registry?: ModuleRegistry;
  /** Research of the run (C8); null — no web tools. */
  research?: Research | null;
  emit?: EmitFn;
  runStep?: RunStepFn;
  onEvent?: AgentEventSink;
  newId?: () => string;
  /** D73: every «пока не умею» of the capability map becomes a development request. */
  recordDevelopmentRequest?: RecordDevelopmentRequest;
}

/** An owner's answer to the pending question: a button, own text, «Решите за меня» or «Дальше решай сам». */
export interface V3Answer {
  questionId: string;
  optionId?: string;
  text?: string;
  /** «Решите за меня» (also optionId DELEGATE_OPTION_ID). */
  delegate?: boolean;
  /** «Дальше решай сам»: this question and the rest become assumptions. */
  finish?: boolean;
}

export function newInterviewV3Session(): InterviewV3Session {
  return {
    v: 1,
    pipeline: "v3",
    state: "idle",
    prompt: null,
    brief: emptyBrief(),
    baseVersion: 0,
    asked: 0,
    current: null,
    lastTopic: null,
    fallbackTopics: [],
    requirements: [],
    deferred: [],
    facts: [],
    research: { searches: 0, pages: 0 },
    recorded: [],
    piiInBrief: false,
    piiNoticeShown: false,
    llmCalls: 0,
    creditsCharged: 0,
  };
}

/** A stored executor state of the v3 path. */
export function isInterviewV3Session(state: unknown): state is InterviewV3Session {
  return typeof state === "object" && state !== null && (state as { pipeline?: unknown }).pipeline === "v3";
}

/**
 * The latest stored brief wins over the session's copy (the owner may have edited it in the panel between turns):
 * a newer valid version replaces session.brief. Pure.
 */
export function adoptStoredBrief(
  session: InterviewV3Session,
  stored: { version: number; brief: unknown } | null | undefined,
): InterviewV3Session {
  if (!stored || stored.version <= session.baseVersion) return session;
  const v = validateBrief(stored.brief);
  return { ...session, baseVersion: stored.version, ...(v.ok ? { brief: v.brief } : {}) };
}

/** The question without its patches, as the platform stores it and the owner sees it. */
export function publicQuestion(q: V3Question): V3PublicQuestion {
  return {
    id: q.id,
    topic: q.topic,
    text: q.text,
    whyItMatters: q.whyItMatters,
    recommendation: q.recommendation,
    options: q.options.map((o) => ({
      id: o.id,
      label: o.label,
      ...(o.description ? { description: o.description } : {}),
      recommended: o.recommended,
    })),
    allowDelegate: q.allowDelegate,
    allowCustom: true,
    step: q.step,
    max: MAX_V3_QUESTIONS,
  };
}

/** The short brief for the chat before «Собрать» (plain language, D48; only counts and the owner's words, D49). */
export function briefSummaryText(brief: SystemBrief, deferred: readonly DeferredQuestion[]): string {
  const c = capabilityCounts(brief.capability);
  const must = brief.scenarios.filter((s) => s.priority === "must").length;
  const should = brief.scenarios.length - must;
  const lines = [
    "Бриф готов. Проверьте его перед сборкой, полная версия — в панели «Бриф».",
    brief.goals.length ? `Цели: ${brief.goals.map((g) => g.text).join("; ")}.` : null,
    `Сценарии: обязательных — ${must}${should ? `, желательных — ${should}` : ""}.`,
    brief.roles.length ? `Роли: ${brief.roles.map((r) => r.name).join(", ")}.` : null,
    brief.data.length ? `Данные: ${brief.data.map((d) => d.entity).join(", ")}.` : null,
    `Карта возможностей: ${CAPABILITY_LABELS.modules} — ${c.modules}, ${CAPABILITY_LABELS.custom} — ${c.custom}, пока не умею — ${c.not_yet}.`,
    c.not_yet ? "То, чего пока не умею, записал в запросы на развитие и предложил замену." : null,
    brief.assumptions.length ? `Допущения: ${brief.assumptions.length}, их можно поменять в брифе.` : null,
    deferred.length ? `Вопросы на время сборки: ${deferred.length}.` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

interface TurnCtx {
  invalid: { fallback: "questions" | "none"; issues: ToolIssue[] }[];
  gaps: CapabilityGap[];
}

/** What a tool loop ended with: the question asked or the finish (set by the tools' handlers). */
interface StepOutcome {
  question: V3Question | null;
  finished: boolean;
}

const MSG = {
  noQuestion: "Нет вопроса, ожидающего ответа.",
  noSuchQuestion: "Такого вопроса нет.",
  noSuchOption: "Такого варианта нет.",
  custom: "Свой ответ — до 2000 символов.",
  empty: "Опишите задачу хотя бы парой предложений.",
  unavailable: "Модели сейчас недоступны. Попробуйте позже.",
  budget: "Лимит кредитов на этот шаг исчерпан.",
};

export class InterviewV3 {
  private readonly deps: InterviewV3Deps;
  private readonly registry: ModuleRegistry;

  constructor(deps: InterviewV3Deps) {
    this.deps = deps;
    this.registry = deps.registry ?? DEFAULT_REGISTRY;
  }

  /** The owner's first message (and a draft brief from the ТЗ, V3-04): the brief so far and the first question. */
  start(
    session: InterviewV3Session,
    input: { prompt: string; draft?: unknown; baseVersion?: number },
  ): Promise<InterviewV3Result> {
    return this.turn(session, (s, out, ctx) => this.doStart(s, out, ctx, input));
  }

  /** An answer to the pending question. */
  answer(session: InterviewV3Session, a: V3Answer): Promise<InterviewV3Result> {
    return this.turn(session, (s, out, ctx) => this.doAnswer(s, out, ctx, a));
  }

  /** A chat message: an own answer while a question waits, a wish once the brief is ready, else a new start. */
  say(session: InterviewV3Session, text: string): Promise<InterviewV3Result> {
    return this.turn(session, async (s, out, ctx) => {
      if (s.state === "asking" && s.current)
        return this.doAnswer(s, out, ctx, { questionId: s.current.id, text });
      if (s.state === "ready" && text.trim()) {
        this.dlp(s, out, text);
        return this.step(s, out, ctx, { kind: "wish", text: clip(text, 2000) });
      }
      return this.doStart(s, out, ctx, { prompt: text });
    });
  }

  // ------------------------------------------------------------------ turns

  private async doStart(
    s: InterviewV3Session,
    out: InterviewV3Output[],
    ctx: TurnCtx,
    input: { prompt: string; draft?: unknown; baseVersion?: number },
  ): Promise<void> {
    const prompt = input.prompt.trim();
    const draft = input.draft !== undefined ? validateBrief(input.draft) : null;
    if (!prompt && !draft?.ok) throw new AgentError("INVALID_INPUT", MSG.empty);
    const fresh = newInterviewV3Session();
    Object.assign(s, {
      ...fresh,
      piiNoticeShown: s.piiNoticeShown,
      prompt: prompt.slice(0, 8000),
      brief: draft?.ok ? draft.brief : s.brief,
      baseVersion: input.baseVersion ?? s.baseVersion,
    });
    this.dlp(s, out, prompt);
    await this.step(s, out, ctx, { kind: "start" });
  }

  private async doAnswer(
    s: InterviewV3Session,
    out: InterviewV3Output[],
    ctx: TurnCtx,
    a: V3Answer,
  ): Promise<void> {
    const q = s.current;
    if (s.state !== "asking" || !q) throw new AgentError("INVALID_INPUT", MSG.noQuestion);
    if (a.questionId !== q.id)
      throw new AgentError("INVALID_INPUT", MSG.noSuchQuestion, { questionId: a.questionId });
    const rec = q.options.find((o) => o.recommended) ?? q.options[0];
    if (!rec) throw new AgentError("INVALID_INPUT", MSG.noSuchOption);
    const decided = `${q.text} — ${rec.label} (решили за вас)`;
    if (a.finish) {
      addQa(s.brief, { q: q.text, a: rec.label, recommended: rec.label, chosen: "delegated" });
      addAssumption(s.brief, decided, "owner_skip");
      this.applyOptionPatch(s, q, rec.id, "owner_skip");
      s.current = null;
      return this.step(s, out, ctx, { kind: "skip" });
    }
    let chosen: "recommended" | "option" | "custom" | "delegated";
    let label: string;
    let optionId: string | undefined;
    if (a.delegate || a.optionId === DELEGATE_OPTION_ID) {
      chosen = "delegated";
      label = rec.label;
      optionId = rec.id;
      addAssumption(s.brief, decided, "default");
    } else if (a.optionId !== undefined) {
      const o = q.options.find((x) => x.id === a.optionId);
      if (!o) throw new AgentError("INVALID_INPUT", MSG.noSuchOption, { optionId: a.optionId });
      chosen = o.recommended ? "recommended" : "option";
      label = o.label;
      optionId = o.id;
    } else {
      const text = a.text?.trim() ?? "";
      if (!text || text.length > 2000) throw new AgentError("INVALID_INPUT", MSG.custom);
      this.dlp(s, out, text);
      chosen = "custom";
      label = text;
    }
    addQa(s.brief, { q: q.text, a: label, recommended: rec.label, chosen });
    if (optionId) this.applyOptionPatch(s, q, optionId, "default");
    s.current = null;
    if (s.asked >= MAX_V3_QUESTIONS) return this.step(s, out, ctx, { kind: "cap" });
    return this.step(s, out, ctx, { kind: "answer", question: q.text, answer: scrub(label).text, chosen });
  }

  /**
   * One model turn: brief updates, then a question or the finish. «skip» and «cap» decide the rest without
   * questions; anything still blocking after them is filled by code with the recommended answers as assumptions.
   */
  private async step(
    s: InterviewV3Session,
    out: InterviewV3Output[],
    ctx: TurnCtx,
    input: V3TurnInput,
  ): Promise<void> {
    let inp = input;
    if ((inp.kind === "answer" || inp.kind === "wish" || inp.kind === "start") && s.asked >= MAX_V3_QUESTIONS)
      inp = { kind: "cap" };
    const decide = inp.kind === "skip" || inp.kind === "cap";
    const source = inp.kind === "skip" ? "owner_skip" : "default";
    const outcome: StepOutcome = { question: null, finished: false };
    const tools: AnyTool[] = [
      this.updateTool(s, source),
      this.deferTool(s),
      this.finishTool(s, outcome, decide),
      ...(decide ? [] : [this.questionTool(s, outcome), ...interviewResearchTools(this.deps.research, s)]),
    ];
    const r = await runToolLoop({
      ...this.base(s),
      messages: interviewV3Messages(this.registry, s, inp, this.gaps(s)),
      tools,
      maxTurns: V3_TURN_MAX_CALLS,
      stopOn: ["submit_question", "finish_interview"],
      toolChoice: "required",
    });
    this.count(s, r.stats);
    if (outcome.question) return this.ask(s, out, outcome.question);
    if (outcome.finished) {
      if (decide) this.fillDefaults(s, source);
      return this.finish(
        s,
        out,
        ctx,
        inp.kind === "skip" ? "owner_skip" : inp.kind === "cap" ? "cap" : "clear",
      );
    }
    // The model did not end the turn with a valid question or finish: the code goes on (B2-41 style).
    ctx.invalid.push({ fallback: "questions", issues: loopIssues(r) });
    if (decide) {
      this.fillDefaults(s, source);
      return this.finish(s, out, ctx, inp.kind === "skip" ? "owner_skip" : "cap");
    }
    return this.nextByCode(s, out, ctx);
  }

  /** Without a model: the deterministic question of the first blocking gap, its default once asked, or the finish. */
  private async nextByCode(s: InterviewV3Session, out: InterviewV3Output[], ctx: TurnCtx): Promise<void> {
    // Gaps are read again after each default: closing one may open the next (scenarios → their data).
    const tried = new Set<V3Topic>();
    const next = () => this.gaps(s).find((g) => !tried.has(g.topic));
    for (let gap = next(); gap; gap = next()) {
      tried.add(gap.topic);
      const fq = fallbackQuestion(gap.topic, this.fallbackCtx(s));
      if (fq && !s.fallbackTopics.includes(gap.topic) && s.asked < MAX_V3_QUESTIONS) {
        s.fallbackTopics.push(gap.topic);
        const { patches, ...rest } = fq;
        return this.ask(s, out, {
          ...rest,
          id: `q${s.asked + 1}`,
          step: s.asked + 1,
          source: "fallback",
          patches,
        });
      }
      this.fillTopic(s, gap.topic, "default");
    }
    // Every gap is asked or filled by its default now (a default that cannot apply leaves it to the owner's panel).
    return this.finish(s, out, ctx, s.asked >= MAX_V3_QUESTIONS ? "cap" : "clear");
  }

  private ask(s: InterviewV3Session, out: InterviewV3Output[], q: V3Question): void {
    s.current = q;
    s.asked = q.step;
    s.lastTopic = q.topic;
    s.state = "asking";
    this.refresh(s);
    out.push({
      id: this.id(),
      role: "assistant",
      kind: "question",
      text: q.text,
      question: publicQuestion(q),
    });
  }

  private async finish(
    s: InterviewV3Session,
    out: InterviewV3Output[],
    ctx: TurnCtx,
    reason: "clear" | "owner_skip" | "cap",
  ): Promise<void> {
    const map = this.refresh(s);
    // D73: every «пока не умею» once as a development request (quote scrubbed), and as a gap for «Написать команде».
    for (const v of map.verdicts) {
      if (v.level !== "not_yet") continue;
      const key = normText(v.text);
      if (s.recorded.includes(key)) continue;
      s.recorded.push(key);
      const gap: CapabilityGap = {
        category: v.category ?? "other",
        quote: clip(scrub(v.text).text, 300),
        missing: clip(scrub(v.text).text, 200),
        offered: v.substitute ? clip(v.substitute, 200) : null,
      };
      ctx.gaps.push(gap);
      try {
        await this.deps.recordDevelopmentRequest?.({
          category: gap.category,
          quote: gap.quote,
          offered: gap.offered,
        });
      } catch {
        // Best effort: the brief and the answer do not depend on the record.
      }
    }
    s.state = "ready";
    s.current = null;
    out.push({
      id: this.id(),
      role: "assistant",
      kind: "brief",
      text: briefSummaryText(s.brief, s.deferred),
      brief: s.brief,
      deferred: [...s.deferred],
      reason,
    });
  }

  // ------------------------------------------------------------------ tools

  private updateTool(s: InterviewV3Session, source: "default" | "owner_skip") {
    return defineTool({
      name: "submit_brief_update",
      description:
        "Add to the system brief what is now known: goals, audience, scenarios, roles, data, integrations, out of scope, assumptions, extra requirements, facts found.",
      input: briefPatchSchema,
      normalize: normalizeBriefPatchArgs,
      run: (p: BriefPatch) => {
        const res = applyBriefPatch(s.brief, p, { assumptionSource: source, registry: this.registry });
        if (!res.ok)
          throw new ToolFailure(
            "BRIEF_INVALID",
            "Бриф не прошёл проверку: исправь отмеченное и вызови снова.",
            res.issues,
          );
        s.brief = res.brief;
        for (const r of p.requirements ?? []) {
          if (s.requirements.some((x) => normText(x.text) === normText(r.text))) continue;
          s.requirements.push({
            text: scrub(r.text).text,
            ...(r.moduleHint ? { moduleHint: r.moduleHint } : {}),
          });
        }
        s.requirements = s.requirements.slice(0, MAX_REQUIREMENTS);
        for (const f of p.facts ?? [])
          if (!s.facts.some((x) => x.url === f.url && x.text === f.text)) s.facts.push(f);
        s.facts = s.facts.slice(-MAX_FACTS);
        this.refresh(s);
        const c = capabilityCounts(s.brief.capability);
        return {
          ok: true,
          blocking: this.gaps(s).map((g) => `${g.topic}: ${g.reasonRu}`),
          capability: { modules: c.modules, custom: c.custom, not_yet: c.not_yet },
        };
      },
    });
  }

  private questionTool(s: InterviewV3Session, outcome: StepOutcome) {
    return defineTool({
      name: "submit_question",
      description:
        "Ask the owner the next blocking question: topic of the tree, text, why it matters, why the recommended option, 3-5 options with exactly one recommended.",
      input: v3QuestionInputSchema,
      normalize: normalizeQuestionArgs,
      check: (q) => questionOrderIssues(q.topic, { gaps: this.gaps(s), lastTopic: s.lastTopic }),
      run: (q) => {
        outcome.question = { ...q, id: `q${s.asked + 1}`, step: s.asked + 1, source: "model" };
        return { ok: true };
      },
    });
  }

  private deferTool(s: InterviewV3Session) {
    return defineTool({
      name: "defer_question",
      description:
        "A non-blocking question goes to the build queue: the build asks it later and uses the assumption meanwhile.",
      input: v3DeferInputSchema,
      normalize: normalizeDeferArgs,
      run: (d) => {
        const item = { topic: d.topic, text: scrub(d.text).text, assumption: scrub(d.assumption).text };
        if (
          !s.deferred.some((x) => normText(x.text) === normText(item.text)) &&
          s.deferred.length < MAX_DEFERRED
        ) {
          s.deferred.push(item);
          addAssumption(s.brief, `${item.assumption} (уточним во время сборки)`, "default");
        }
        return { ok: true, queued: s.deferred.length };
      },
    });
  }

  private finishTool(s: InterviewV3Session, outcome: StepOutcome, decide: boolean) {
    return defineTool({
      name: "finish_interview",
      description: "End the interview: nothing blocking is left (the code checks it).",
      input: v3FinishInputSchema,
      run: () => {
        const gaps = this.gaps(s);
        // Asking turns may not finish over a blocking gap; «skip» and «cap» may — the code fills the rest.
        if (!decide && gaps.length > 0)
          throw new ToolFailure(
            "BLOCKING_GAPS",
            "Рано заканчивать: остались блокирующие пробелы. Задай вопрос по первому из них или заполни бриф.",
            gaps.map((g) => ({ path: g.topic, code: "BLOCKING_GAP", message: g.reasonRu })),
          );
        outcome.finished = true;
        return { ok: true };
      },
    });
  }

  // ------------------------------------------------------------------ helpers

  private gaps(s: InterviewV3Session): BlockingGap[] {
    return blockingGaps(s.brief, s.requirements, this.registry);
  }

  private refresh(s: InterviewV3Session) {
    return refreshCapability(s.brief, s.requirements, this.registry);
  }

  private fallbackCtx(s: InterviewV3Session) {
    return { brief: s.brief, prompt: s.prompt ?? "", extras: s.requirements, registry: this.registry };
  }

  /** The brief patch of a fallback question's option (model questions have none: the model applies the answer). */
  private applyOptionPatch(
    s: InterviewV3Session,
    q: V3Question,
    optionId: string,
    source: "default" | "owner_skip",
  ): void {
    const patch = q.patches?.[optionId];
    if (!patch) return;
    const res = applyBriefPatch(s.brief, patch, { assumptionSource: source, registry: this.registry });
    if (res.ok) s.brief = res.brief;
  }

  /** The recommended answer of a blocking topic written into the brief, with an explicit assumption. */
  private fillTopic(s: InterviewV3Session, topic: V3Topic, source: "default" | "owner_skip"): void {
    const d = defaultPatch(topic, this.fallbackCtx(s));
    if (!d) return;
    const res = applyBriefPatch(s.brief, d.patch, { assumptionSource: source, registry: this.registry });
    if (!res.ok) return;
    s.brief = res.brief;
    addAssumption(s.brief, `${V3_TOPIC_LABELS[topic]}: ${d.label} (решили за вас)`, source);
  }

  /** Every blocking gap left gets the recommended answer as an assumption (each topic once). */
  private fillDefaults(s: InterviewV3Session, source: "default" | "owner_skip"): void {
    const done = new Set<V3Topic>();
    for (let gap = this.gaps(s)[0]; gap && !done.has(gap.topic); gap = this.gaps(s)[0]) {
      done.add(gap.topic);
      this.fillTopic(s, gap.topic, source);
    }
    this.refresh(s);
  }

  private base(s: InterviewV3Session): CallBase {
    return {
      route: this.deps.route,
      callType: INTERVIEW_V3_CALL_TYPE,
      orgPolicy: this.deps.orgPolicy,
      ctx: this.deps.ctx,
      ...(this.deps.onEvent ? { onEvent: this.deps.onEvent } : {}),
      ...(this.deps.runStep ? { runStep: this.deps.runStep } : {}),
      stepName: `orchestrate:${INTERVIEW_V3_CALL_TYPE}:${s.llmCalls + 1}`,
    };
  }

  private count(s: InterviewV3Session, stats: { calls: number; creditsCharged: number }): void {
    s.llmCalls += stats.calls;
    s.creditsCharged = Math.round((s.creditsCharged + stats.creditsCharged) * 1000) / 1000;
  }

  private async turn(
    session: InterviewV3Session,
    body: (s: InterviewV3Session, out: InterviewV3Output[], ctx: TurnCtx) => Promise<void>,
  ): Promise<InterviewV3Result> {
    const s = structuredClone(session);
    const outputs: InterviewV3Output[] = [];
    const ctx: TurnCtx = { invalid: [], gaps: [] };
    const res: InterviewV3Result = { session: s, outputs };
    try {
      await body(s, outputs, ctx);
    } catch (e) {
      if (!(e instanceof LlmError)) throw e;
      const budget = e.code === "BUDGET_EXCEEDED";
      return {
        session,
        outputs: [],
        failure: {
          code: budget ? "BUDGET_STOPPED" : "LLM_UNAVAILABLE",
          message_ru: budget ? MSG.budget : MSG.unavailable,
          retryable: !budget,
          cause: e.code,
        },
      };
    }
    const main = [...outputs].reverse().find((o) => o.kind !== "notice");
    if (ctx.gaps.length && main?.role === "assistant") main.gaps = ctx.gaps;
    // Internal diagnosis (never shown to the owner): what did not pass and what replaced it.
    for (const n of ctx.invalid)
      await this.deps.emit?.("orch_invalid", {
        step: "interview",
        fallback: n.fallback,
        issues: n.issues.slice(0, 10).map((i) => ({
          path: i.path,
          ...(i.code ? { code: i.code } : {}),
          message: String(i.message).slice(0, 160),
        })),
      });
    return res;
  }

  private dlp(s: InterviewV3Session, out: InterviewV3Output[], text: string): void {
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

/** Why a tool loop ended without a question or the finish (orch_invalid issues). */
function loopIssues(r: ToolLoopResult): ToolIssue[] {
  const failed = r.results
    .filter((x) => !x.ok)
    .flatMap((x) => {
      const err = (x.content as { error?: { code?: string; message?: string; issues?: ToolIssue[] } }).error;
      return err?.issues?.length
        ? err.issues
        : [{ path: x.call.name, code: err?.code ?? "TOOL_FAILED", message: err?.message ?? "" }];
    });
  if (failed.length) return failed;
  return [
    r.reason === "stop"
      ? { path: "", code: "NO_TOOL_CALL", message: "Ответ без вызова submit_question или finish_interview." }
      : { path: "", code: "MAX_TURNS", message: "Ход закончился без вопроса и без завершения." },
  ];
}

export function createInterviewV3(deps: InterviewV3Deps): InterviewV3 {
  return new InterviewV3(deps);
}
