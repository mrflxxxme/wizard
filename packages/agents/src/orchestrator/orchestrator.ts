// Orchestrator: interview → system card → hand-off (specs/agents/orchestrator.yaml#algorithm, #change_requests).
// Stateless between turns: the host persists OrchSession (JSON) and the returned outputs (workflows.yaml#interview_turn).
import { randomUUID } from "node:crypto";
import { LlmError, type OrgPolicy, type Registry, type RouteContext } from "@wizard/llm";
import { scrubJson } from "@wizard/pii";
import { AgentError } from "../core/errors.js";
import type { AgentEventSink, EmitFn, RunStepFn } from "../core/events.js";
import { type CallBase, callTool, type RouteFn } from "../core/loop.js";
import { defineTool, type ToolIssue } from "../core/tool.js";
import { estimateCard } from "./estimate.js";
import { piiCategories, piiNoticeText } from "./pii.js";
import { buildMessages, type OrgContext } from "./prompt.js";
import {
  type Analysis,
  type Answer,
  analysisSchema,
  askQuestionsSchema,
  type ChangeCard,
  type ChangeKind,
  cardDraftSchema,
  changeCardSchema,
  changeClassSchema,
  changeDraftSchema,
  type Question,
  type SystemCard,
  systemCardSchema,
} from "./schemas.js";
import { MAX_CARD_VERSIONS, type OrchEvent, type OrchState, transition } from "./state-machine.js";
import { FORK_IDS, type ForkSelection, finalDefaults, selectForks } from "./taxonomy.js";
import { checkCard, checkChangeDraft, checkQuestions } from "./validate.js";

export interface AnalysisSummary {
  title: string;
  roles: string[];
  skeleton: string[];
  constraints: string[];
  forks: { forkId: string; status: "resolved" | "asking" | "pending" }[];
}

export type OrchOutput =
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
      payload: { questionIds: string[]; analysis?: AnalysisSummary };
      questions: Question[];
    }
  | {
      id: string;
      role: "assistant";
      kind: "card";
      text: string;
      payload: { cardVersion: number };
      card: SystemCard | ChangeCard;
    }
  | {
      id: string;
      role: "assistant";
      kind: "text";
      text: string;
      payload?: { hint?: "style" | "restart" | "topup" };
    };

export interface ChangeContext {
  /** Digest of the current spec for prompt_skeleton.dynamic.current_spec. */
  specDigest: string;
  roles: string[];
  entities: string[];
}

export interface OrchSession {
  v: 1;
  state: OrchState;
  mode: "create" | "change";
  brief: string | null;
  piiInBrief: boolean;
  piiNoticeShown: boolean;
  analysis: Analysis | null;
  selection: ForkSelection | null;
  questions: Question[];
  answers: Answer[];
  card: SystemCard | ChangeCard | null;
  /** Version of the current card series (≤ 5 per series). */
  cardVersion: number;
  edits: string[];
  change: (ChangeContext & { kind: ChangeKind; summary?: string }) | null;
  seenKeys: string[];
  llmCalls: number;
  creditsCharged: number;
}

export interface Handoff {
  card: SystemCard | ChangeCard;
  cardVersion: number;
  cap: number;
  mode: "create" | "change";
}

export interface TurnFailure {
  code: "ORCH_INVALID_OUTPUT" | "LLM_UNAVAILABLE" | "BUDGET_STOPPED";
  message_ru: string;
  retryable: boolean;
  /** LlmError code or validation issues for the journal (no prompt content). */
  cause?: string;
  issues?: ToolIssue[];
}

export interface TurnResult {
  session: OrchSession;
  outputs: OrchOutput[];
  handoff?: Handoff;
  failure?: TurnFailure;
  changeKind?: ChangeKind;
  /** approve: balance < cap (M1+) — the card stays and offers «Докупить». */
  insufficientCredits?: boolean;
}

export interface OrchestratorDeps {
  route: RouteFn;
  orgPolicy: OrgPolicy | null;
  ctx: RouteContext;
  org?: Partial<OrgContext>;
  /** Registry for the estimate (default createRegistry()). */
  registry?: Registry;
  emit?: EmitFn;
  runStep?: RunStepFn;
  onEvent?: AgentEventSink;
  newId?: () => string;
}

export interface TurnOptions {
  idempotencyKey?: string;
}

export function isChangeCard(card: SystemCard | ChangeCard): card is ChangeCard {
  return "kind" in card && card.kind === "change";
}

export function newSession(): OrchSession {
  return {
    v: 1,
    state: "idle",
    mode: "create",
    brief: null,
    piiInBrief: false,
    piiNoticeShown: false,
    analysis: null,
    selection: null,
    questions: [],
    answers: [],
    card: null,
    cardVersion: 0,
    edits: [],
    change: null,
    seenKeys: [],
    llmCalls: 0,
    creditsCharged: 0,
  };
}

const STYLE_RE = /цвет|шрифт|скругл|тём|темн|светл|фон|оформлен|стил|палитр|логотип|иконк/;
const STRUCTURE_RE =
  /пол[еяю]\b|пол[ея]м|рол[ьи]|доступ|оплат|статус|экран|страниц|уведомл|отч[её]т|данн|таблиц|заявк|заказ|вход|интеграц|подключ|автомат|рассылк|правил|лимит|провер/;

/** change_requests.classify, code part: style_only needs no LLM and no run. */
export function isStyleOnly(text: string): boolean {
  const t = text.toLowerCase();
  return STYLE_RE.test(t) && !STRUCTURE_RE.test(t);
}

const MSG = {
  questions: (n: number) =>
    n === 1
      ? "Остался один вопрос, чтобы собрать карточку системы."
      : `Есть ${n} вопроса, чтобы собрать карточку системы.`,
  card: (v: number) =>
    v === 1 ? "Карточка системы готова. Проверьте и нажмите «Строить»." : `Карточка обновлена (версия ${v}).`,
  change: "Готово предложение по правке. Проверьте и подтвердите.",
  style: "Это меняется бесплатно во вкладке «Стиль»: цвета, шрифты, скругления и тема. Сборка не нужна.",
  restart: "Карточку правили уже 5 раз. Лучше начать заново: опишите задачу целиком ещё раз.",
  topup: "Не хватает кредитов на сборку. Пополните баланс кнопкой «Докупить».",
  invalid: "Не удалось разобрать ответ модели. Попробуйте ещё раз.",
  unavailable: "Модели сейчас недоступны. Попробуйте позже.",
  budget: "Лимит кредитов на этот шаг исчерпан.",
};

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly org: OrgContext;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.org = {
      plan: deps.org?.plan ?? "free",
      ruOnly: deps.org?.ruOnly ?? deps.orgPolicy?.ruOnly ?? false,
      ...(deps.org?.systems ? { systems: deps.org.systems } : {}),
    };
  }

  newSession(): OrchSession {
    return newSession();
  }

  /** S1–S4 (or straight to S5 when no forks). */
  submitBrief(session: OrchSession, brief: string, opts: TurnOptions = {}): Promise<TurnResult> {
    return this.turn(session, opts, async (s, out) => {
      if (brief.trim().length === 0)
        throw new AgentError("INVALID_INPUT", "Опишите задачу хотя бы парой предложений.");
      s.state = transition(s.state, { type: "BRIEF_SUBMITTED" });
      s.mode = "create";
      s.brief = brief;
      this.dlp(s, out, brief);
      return this.analyze(s, out);
    });
  }

  /** One answer: an option of the question or a custom text (≤500, DLP). */
  answer(
    session: OrchSession,
    input: { questionId: string; optionId?: string; text?: string },
    opts: TurnOptions = {},
  ): Promise<TurnResult> {
    return this.turn(session, opts, async (s, out) => {
      const q = s.questions.find((x) => x.id === input.questionId);
      if (!q) throw new AgentError("INVALID_INPUT", "Такого вопроса нет.", { questionId: input.questionId });
      if (s.answers.some((a) => a.questionId === q.id)) {
        throw new AgentError("INVALID_INPUT", "На этот вопрос уже есть ответ.", { questionId: q.id });
      }
      let answer: Answer;
      if (input.optionId !== undefined) {
        if (!q.options.some((o) => o.id === input.optionId)) {
          throw new AgentError("INVALID_INPUT", "Такого варианта нет.", { optionId: input.optionId });
        }
        answer = { questionId: q.id, forkId: q.forkId, optionId: input.optionId, byRecommendation: false };
      } else {
        const text = input.text?.trim() ?? "";
        if (!q.allowCustom || text.length === 0 || text.length > 500) {
          throw new AgentError("INVALID_INPUT", "Свой вариант — до 500 символов.");
        }
        answer = { questionId: q.id, forkId: q.forkId, text, byRecommendation: false };
      }
      const remaining = s.questions.length - s.answers.length - 1;
      s.state = transition(s.state, { type: "ANSWER", remaining });
      if (answer.text !== undefined) this.dlp(s, out, answer.text);
      s.answers.push(answer);
      if (s.state === "carding") await this.card(s, out);
    });
  }

  /** «Остальное — по рекомендациям». */
  restByRecommendation(session: OrchSession, opts: TurnOptions = {}): Promise<TurnResult> {
    return this.turn(session, opts, async (s, out) => {
      s.state = transition(s.state, { type: "REST_BY_RECOMMENDATION" });
      for (const q of s.questions) {
        if (s.answers.some((a) => a.questionId === q.id)) continue;
        const rec = q.options.find((o) => o.recommended) ?? q.options[0];
        if (rec)
          s.answers.push({ questionId: q.id, forkId: q.forkId, optionId: rec.id, byRecommendation: true });
      }
      await this.card(s, out);
    });
  }

  /** CARD_EDIT: S5 again with the wishes; after 5 versions — offer to start over. */
  editCard(session: OrchSession, text: string, opts: TurnOptions = {}): Promise<TurnResult> {
    return this.turn(session, opts, async (s, out) => {
      if (s.state === "awaiting_approval" && s.cardVersion >= MAX_CARD_VERSIONS) {
        out.push(this.text(MSG.restart, "restart"));
        return;
      }
      s.state = transition(s.state, { type: "CARD_EDIT", cardVersion: s.cardVersion });
      this.dlp(s, out, text);
      s.edits.push(text.trim().slice(0, 1000));
      await this.card(s, out);
    });
  }

  /** S6 APPROVE: the only approval point (D7). balanceCredits — M1+. */
  approve(session: OrchSession, opts: TurnOptions & { balanceCredits?: number } = {}): Promise<TurnResult> {
    return this.turn(session, opts, async (s, out, res) => {
      const card = s.card;
      if (!card || s.state !== "awaiting_approval") {
        transition(s.state, { type: "APPROVE" });
        return;
      }
      const balanceOk =
        opts.balanceCredits === undefined ? undefined : opts.balanceCredits >= card.cap.credits;
      if (balanceOk === false) {
        out.push(this.text(MSG.topup, "topup"));
        res.insufficientCredits = true;
        return;
      }
      s.state = transition(s.state, { type: "APPROVE", ...(balanceOk !== undefined ? { balanceOk } : {}) });
      res.handoff = { card, cardVersion: card.cardVersion, cap: card.cap.credits, mode: s.mode };
    });
  }

  cancel(session: OrchSession, opts: TurnOptions = {}): Promise<TurnResult> {
    return this.turn(session, opts, async (s) => {
      s.state = transition(s.state, { type: "CANCEL" });
    });
  }

  /** Build lifecycle events from the host: BUILD_STARTED, BUILDER_NEEDS_USER, USER_CHOICE, BUILD_DONE. */
  dispatch(session: OrchSession, event: OrchEvent, opts: TurnOptions = {}): Promise<TurnResult> {
    return this.turn(session, opts, async (s) => {
      s.state = transition(s.state, event);
    });
  }

  /** change_requests: style_only → hint; small_edit → ≤2 questions + mini-card; big_change → S2–S6 with the spec. */
  requestChange(
    session: OrchSession,
    text: string,
    current: ChangeContext,
    opts: TurnOptions = {},
  ): Promise<TurnResult> {
    return this.turn(session, opts, async (s, out, res) => {
      if (isStyleOnly(text)) {
        if (s.state !== "done") transition(s.state, { type: "CHANGE_REQUESTED" });
        res.changeKind = "style_only";
        out.push(this.text(MSG.style, "style"));
        return;
      }
      s.state = transition(s.state, { type: "CHANGE_REQUESTED" });
      Object.assign(s, {
        mode: "change",
        brief: text,
        analysis: null,
        selection: null,
        questions: [],
        answers: [],
        card: null,
        cardVersion: 0,
        edits: [],
      } satisfies Partial<OrchSession>);
      this.dlp(s, out, text);
      const tool = defineTool({
        name: "submit_change",
        description: "Classify the change request: small_edit (≤2 questions) or big_change.",
        input: changeClassSchema,
        check: (v) => checkQuestions(v.questions, FORK_IDS, { plan: this.org.plan }, { requireAll: false }),
      });
      const r = await callTool({
        ...this.base("interview", s),
        messages: buildMessages({
          org: this.org,
          brief: text,
          currentSpec: current.specDigest,
          task: "Это правка готовой системы. Классифицируй её и вызови submit_change.",
        }),
        tool,
      });
      this.count(s, r.stats);
      if (!r.ok) throw new InvalidOutput(r.issues);
      res.changeKind = r.value.kind;
      s.change = { ...current, kind: r.value.kind, summary: r.value.summary };
      if (r.value.kind === "big_change") {
        await this.analyze(s, out);
        return;
      }
      const qs = r.value.questions.map((q, i) => ({ ...q, id: `q${i + 1}` }));
      s.questions = qs;
      s.state = transition(s.state, { type: "ANALYSIS_DONE", forks: qs.length });
      if (qs.length > 0) out.push(this.questionsOutput(qs));
      else await this.card(s, out);
    });
  }

  // ------------------------------------------------------------------ steps

  private async analyze(s: OrchSession, out: OrchOutput[]): Promise<TurnResult | undefined> {
    const brief = s.brief ?? "";
    const specDigest = s.change?.specDigest;
    const r = await callTool({
      ...this.base("interview", s),
      messages: buildMessages({
        org: this.org,
        brief,
        ...(specDigest ? { currentSpec: specDigest } : {}),
        task: "Разбери задачу и вызови submit_analysis.",
      }),
      tool: defineTool({
        name: "submit_analysis",
        description:
          "Structured analysis of the brief: goals, segment, roles, data, integrations, resolved forks.",
        input: analysisSchema,
      }),
    });
    this.count(s, r.stats);
    if (!r.ok) throw new InvalidOutput(r.issues);
    // pii_notice.rules: values found in the brief never reach Analysis.
    const analysis = scrubJson(r.value).value;
    s.analysis = analysis;
    const sel = selectForks(analysis);
    s.selection = sel;
    if (sel.asked.length === 0) {
      s.state = transition(s.state, { type: "ANALYSIS_DONE", forks: 0 });
      await this.card(s, out);
      return;
    }
    const selected = sel.asked.map((x) => x.forkId);
    const q = await callTool({
      ...this.base("interview", s),
      messages: buildMessages({
        org: this.org,
        brief,
        analysis,
        forkList: sel.asked,
        task: "Сформулируй вопросы по развилкам и вызови ask_questions.",
      }),
      tool: defineTool({
        name: "ask_questions",
        description: "Questions for the selected forks: 2–4 options each, exactly one recommended.",
        input: askQuestionsSchema,
        check: (v) => checkQuestions(v.questions, selected, { plan: this.org.plan }),
      }),
    });
    this.count(s, q.stats);
    if (!q.ok) throw new InvalidOutput(q.issues);
    s.questions = q.value.questions;
    s.state = transition(s.state, { type: "ANALYSIS_DONE", forks: s.questions.length });
    out.push(this.questionsOutput(s.questions, this.summary(analysis, sel)));
  }

  private async card(s: OrchSession, out: OrchOutput[]): Promise<void> {
    if (s.mode === "change" && s.change?.kind === "small_edit") return this.changeCard(s, out);
    const analysis = s.analysis;
    const answersMap = new Map(
      s.answers.filter((a) => a.optionId !== undefined).map((a) => [a.forkId, a.optionId as string]),
    );
    const defaults = analysis && s.selection ? finalDefaults(analysis, s.selection, answersMap) : [];
    const prev = s.card && !isChangeCard(s.card) ? s.card : undefined;
    const r = await callTool({
      ...this.base("card", s),
      messages: buildMessages({
        org: this.org,
        brief: s.brief ?? "",
        ...(s.change?.specDigest ? { currentSpec: s.change.specDigest } : {}),
        ...(analysis ? { analysis } : {}),
        questions: s.questions,
        answers: s.answers,
        defaults,
        ...(prev ? { previousCard: prev } : {}),
        edits: s.edits,
        task: "Собери карточку системы и вызови submit_card.",
      }),
      tool: defineTool({
        name: "submit_card",
        description: "System card for the owner's approval (estimate and cap are computed by code).",
        input: cardDraftSchema,
        check: (v) => checkCard(v, { plan: this.org.plan }),
      }),
    });
    this.count(s, r.stats);
    if (!r.ok) throw new InvalidOutput(r.issues);
    const draft = { ...r.value, forkAnswers: s.answers };
    const est = estimateCard(draft, { ...this.estimateOpts(), kind: "create" });
    const cardVersion = s.cardVersion + 1;
    const card = systemCardSchema.parse({ ...draft, cardVersion, estimate: est.estimate, cap: est.cap });
    s.card = card;
    s.cardVersion = cardVersion;
    s.state = transition(s.state, { type: "CARD_READY" });
    out.push(this.cardOutput(card, MSG.card(cardVersion)));
  }

  private async changeCard(s: OrchSession, out: OrchOutput[]): Promise<void> {
    const change = s.change as ChangeContext & { kind: ChangeKind; summary?: string };
    const prev = s.card && isChangeCard(s.card) ? s.card : undefined;
    const r = await callTool({
      ...this.base("card", s),
      messages: buildMessages({
        org: this.org,
        brief: s.brief ?? "",
        currentSpec: change.specDigest,
        questions: s.questions,
        answers: s.answers,
        ...(prev ? { previousCard: prev } : {}),
        edits: s.edits,
        task: "Собери мини-карточку правки (только то, что меняется) и вызови submit_change_card.",
      }),
      tool: defineTool({
        name: "submit_change_card",
        description: "Mini-card of a change: summary of what changes plus only the affected card sections.",
        input: changeDraftSchema,
        check: (v) => checkChangeDraft(v, change, { plan: this.org.plan }),
      }),
    });
    this.count(s, r.stats);
    if (!r.ok) throw new InvalidOutput(r.issues);
    const est = estimateCard(r.value, { ...this.estimateOpts(), kind: "change" });
    const cardVersion = s.cardVersion + 1;
    const card = changeCardSchema.parse({
      ...r.value,
      kind: "change",
      cardVersion,
      estimate: est.estimate,
      cap: est.cap,
    });
    s.card = card;
    s.cardVersion = cardVersion;
    s.state = transition(s.state, { type: "CARD_READY" });
    out.push(this.cardOutput(card, MSG.change));
  }

  // ------------------------------------------------------------------ helpers

  private async turn(
    session: OrchSession,
    opts: TurnOptions,
    body: (s: OrchSession, out: OrchOutput[], res: TurnResult) => Promise<unknown>,
  ): Promise<TurnResult> {
    if (opts.idempotencyKey !== undefined && session.seenKeys.includes(opts.idempotencyKey)) {
      return { session, outputs: [] };
    }
    const s = structuredClone(session);
    const outputs: OrchOutput[] = [];
    const res: TurnResult = { session: s, outputs };
    try {
      await body(s, outputs, res);
    } catch (e) {
      if (e instanceof InvalidOutput) this.invalid(s, res, e.issues);
      else if (e instanceof LlmError) this.llmFailed(s, res, e);
      else throw e;
    }
    if (opts.idempotencyKey !== undefined) s.seenKeys.push(opts.idempotencyKey);
    for (const o of outputs) {
      const kind =
        o.kind === "text" ? "answer" : o.kind === "card" && isChangeCard(o.card) ? "change_proposal" : o.kind;
      await this.deps.emit?.("chat_output", {
        kind,
        messageId: o.id,
        ...(o.kind === "card" ? { cardVersion: o.payload.cardVersion } : {}),
      });
    }
    if (res.failure) {
      await this.deps.emit?.("run_failed", {
        code: res.failure.code,
        message_ru: res.failure.message_ru,
        retryable: res.failure.retryable,
        lastGoodRevision: null,
      });
    }
    return res;
  }

  private base(callType: "interview" | "card", s: OrchSession): CallBase {
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

  private estimateOpts() {
    return {
      orgPolicy: this.deps.orgPolicy,
      ...(this.deps.registry ? { registry: this.deps.registry } : {}),
    };
  }

  private count(s: OrchSession, stats: { calls: number; creditsCharged: number }): void {
    s.llmCalls += stats.calls;
    s.creditsCharged = Math.round((s.creditsCharged + stats.creditsCharged) * 1000) / 1000;
  }

  private fail(s: OrchSession, res: TurnResult, failure: TurnFailure): void {
    s.state = transition(s.state, { type: "LLM_FAILED" });
    res.failure = failure;
  }

  private invalid(s: OrchSession, res: TurnResult, issues: ToolIssue[]): void {
    this.fail(s, res, { code: "ORCH_INVALID_OUTPUT", message_ru: MSG.invalid, retryable: true, issues });
  }

  private llmFailed(s: OrchSession, res: TurnResult, e: LlmError): void {
    const budget = e.code === "BUDGET_EXCEEDED";
    this.fail(s, res, {
      code: budget ? "BUDGET_STOPPED" : "LLM_UNAVAILABLE",
      message_ru: budget ? MSG.budget : MSG.unavailable,
      retryable: !budget,
      cause: e.code,
    });
  }

  /** S1_dlp / custom answers / edits: one notice per session. */
  private dlp(s: OrchSession, out: OrchOutput[], text: string): void {
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

  private summary(a: Analysis, sel: ForkSelection): AnalysisSummary {
    const forks: AnalysisSummary["forks"] = [
      ...sel.decided
        .filter((d) => d.source === "brief")
        .map((d) => ({ forkId: d.forkId, status: "resolved" as const })),
      ...sel.asked.map((x) => ({ forkId: x.forkId, status: "asking" as const })),
      ...sel.decided
        .filter((d) => d.source === "default")
        .map((d) => ({ forkId: d.forkId, status: "pending" as const })),
    ];
    return scrubJson({
      title: a.goals[0] ?? "",
      roles: a.roles.map((r) => r.label),
      skeleton: [...a.skeleton],
      constraints: [...a.constraints],
      forks,
    }).value;
  }

  private questionsOutput(questions: Question[], analysis?: AnalysisSummary): OrchOutput {
    return {
      id: this.id(),
      role: "assistant",
      kind: "questions",
      text: MSG.questions(questions.length),
      payload: { questionIds: questions.map((q) => q.id), ...(analysis ? { analysis } : {}) },
      questions,
    };
  }

  private cardOutput(card: SystemCard | ChangeCard, text: string): OrchOutput {
    return {
      id: this.id(),
      role: "assistant",
      kind: "card",
      text,
      payload: { cardVersion: card.cardVersion },
      card,
    };
  }

  private text(text: string, hint?: "style" | "restart" | "topup"): OrchOutput {
    return { id: this.id(), role: "assistant", kind: "text", text, ...(hint ? { payload: { hint } } : {}) };
  }

  private id(): string {
    return (this.deps.newId ?? randomUUID)();
  }
}

class InvalidOutput extends Error {
  readonly issues: ToolIssue[];
  constructor(issues: ToolIssue[]) {
    super("ORCH_INVALID_OUTPUT");
    this.issues = issues;
  }
}

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  return new Orchestrator(deps);
}
