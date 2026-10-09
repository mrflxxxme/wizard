// V3-03: an interview turn of the v3 pipeline (WIZARD_BUILD_PIPELINE=v3; D77_v3 (8), (9), (12)) — the grill interview of
// @wizard/agents/interview-v3 over the platform host: one question per turn (messages kind=questions with the step and
// the cap), the system brief written as a new version (author agent) every turn, the short brief in the chat and the
// D7 point (stage card) when nothing blocking is left. «Решите за меня» comes as the reserved option of the question;
// «Остальное по рекомендациям» (restByRecommendation) is «Дальше решай сам».

import type { CapabilityGap } from "@wizard/agents";
import { AgentError } from "@wizard/agents/core";
import { hostRouteFn } from "@wizard/agents/host";
import {
  adoptStoredBrief,
  createInterviewV3,
  DELEGATE_LABEL,
  DELEGATE_OPTION_ID,
  type InterviewV3Result,
  isInterviewV3Session,
  newInterviewV3Session,
  type V3Answer,
  type V3PublicQuestion,
} from "@wizard/agents/interview-v3";
import type { ModuleRegistry } from "@wizard/agents/planner";
import { createResearch, type Research, type ResearchContext, researchMode } from "@wizard/agents/research";
import { recordInterviewFallback } from "../ops/metrics.js";
import { type InterviewHost, type InterviewOutput, RunFailure } from "../runs/types.js";

export interface InterviewV3Options {
  /** Module registry of the capability map (default — @wizard/modules CATALOG). */
  registry?: ModuleRegistry;
  /**
   * Research of a turn (C8). Default: with WIZARD_RESEARCH_MODE=live — createResearch over process.env (web_search
   * only with YANDEX_SEARCH_API_KEY and YANDEX_FOLDER_ID); otherwise none, as the platform has no recorded answers to
   * replay and a tool that always refuses would only cost model calls. null — no web tools.
   */
  research?: ((ctx: ResearchContext) => Research | null) | null;
}

const defaultResearch = (context: ResearchContext): Research | null =>
  researchMode(process.env) === "live" ? createResearch({ env: process.env, mode: "live", context }) : null;

/** The platform form of a v3 question (pending_questions): the agent's buttons plus the reserved «Решите за меня». */
export function platformQuestion(q: V3PublicQuestion): Record<string, unknown> {
  return {
    ...q,
    options: [
      ...q.options,
      { id: DELEGATE_OPTION_ID, label: DELEGATE_LABEL, recommended: false, delegate: true },
    ],
  };
}

function userTexts(host: InterviewHost): string[] {
  return host.context.messages.filter((m) => m.role === "user" && m.kind === "text").map((m) => m.text ?? "");
}

/** answers of the API (one pending question in v3) → the agent's answer; byRecommendation is «Дальше решай сам». */
function toAnswer(raw: unknown[] | undefined): V3Answer | null {
  const answers = (raw ?? []) as {
    questionId: string;
    optionId?: string;
    text?: string;
    byRecommendation?: boolean;
  }[];
  const own = answers.find((a) => !a.byRecommendation);
  if (own)
    return {
      questionId: own.questionId,
      ...(own.optionId !== undefined ? { optionId: own.optionId } : {}),
      ...(own.text !== undefined ? { text: own.text } : {}),
    };
  const rest = answers.find((a) => a.byRecommendation);
  return rest ? { questionId: rest.questionId, finish: true } : null;
}

/** One v3 interview turn → the InterviewOutput platform-api persists (questions | answer with the ready brief). */
export async function interviewV3Turn(
  host: InterviewHost,
  o: InterviewV3Options = {},
): Promise<InterviewOutput> {
  const c = host.context;
  const ctx = { orgId: c.org.id, runId: host.run.id, systemId: c.system.id };
  const research = o.research === null ? null : (o.research ?? defaultResearch)(ctx);
  const iv = createInterviewV3({
    route: hostRouteFn(host.route, { step: "orchestrate" }),
    orgPolicy: c.org.policy,
    ctx,
    ...(o.registry ? { registry: o.registry } : {}),
    research,
    runStep: host.runStep,
    // B2-41 style: what did not pass and what replaced it — the internal event and the metric.
    emit: async (type, payload) => {
      if (type !== "orch_invalid") return;
      recordInterviewFallback(payload as { step?: unknown; fallback?: unknown });
      await host.emit("orch_invalid", payload);
    },
    recordDevelopmentRequest: (input) => host.recordDevelopmentRequest(input),
  });
  const stored = c.brief ?? null;
  const base = stored?.version ?? 0;
  const session = adoptStoredBrief(isInterviewV3Session(c.state) ? c.state : newInterviewV3Session(), stored);
  let res: InterviewV3Result;
  try {
    if (c.trigger === "create")
      // A brief already stored (the draft from a ТЗ file, V3-04) is the start: the interview asks only the gaps.
      res = await iv.start(newInterviewV3Session(), {
        prompt: userTexts(host)[0] ?? "",
        ...(stored ? { draft: stored.brief } : {}),
        baseVersion: base,
      });
    else if (c.trigger === "answers") {
      const a = toAnswer(c.answers);
      if (!a) return { kind: "answer", text: "Нет ни одного ответа." };
      res = await iv.answer(session, a);
    } else res = await iv.say(session, userTexts(host).at(-1) ?? "");
  } catch (e) {
    if (e instanceof AgentError) return { kind: "answer", text: e.message };
    throw e;
  }
  if (res.failure) throw new RunFailure(res.failure.code, res.failure.message_ru, res.failure.retryable);
  return v3Output(res, base);
}

/** InterviewV3Output[] of one turn → the InterviewOutput (+ notice, gaps, the brief to save, the state). */
function v3Output(res: InterviewV3Result, base: number): InterviewOutput {
  let main: InterviewOutput | undefined;
  let notice: { categories: string[] } | undefined;
  const gaps: CapabilityGap[] = [];
  for (const o of res.outputs) {
    if (o.kind === "notice") {
      notice = { categories: o.payload.categories };
      continue;
    }
    if (o.gaps?.length) gaps.push(...o.gaps);
    if (o.kind === "question")
      main = {
        kind: "questions",
        text: o.text,
        questions: [platformQuestion(o.question)],
        interview: { step: o.question.step, max: o.question.max, topic: o.question.topic },
      };
    else if (o.kind === "brief")
      main = {
        kind: "answer",
        text: o.text,
        briefReady: true,
        interview: { ready: true, reason: o.reason, buildQuestions: o.deferred },
      };
    else main = { kind: "answer", text: o.text };
  }
  return {
    ...(main ?? { kind: "answer", text: "Готово." }),
    ...(notice ? { notice } : {}),
    ...(gaps.length > 0 ? { gaps } : {}),
    brief: res.session.brief as unknown as Record<string, unknown>,
    briefBase: base,
    state: res.session as unknown as Record<string, unknown>,
  };
}
