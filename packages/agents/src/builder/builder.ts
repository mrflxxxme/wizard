// runBuild(host, {card, cap, mode}): agents/builder.yaml#loop — plan → ops → code → verify (G0, QA, G1) → fix,
// budgets (#budgets), escalation (#escalation); events — platform/workflows.yaml#events.
import { createHash } from "node:crypto";
import { type AppSpec, generateTypes } from "@wizard/appspec";
import { type Check, checkFile, type GateReport, type QaCheck } from "@wizard/gates";
import { type CallType, LlmError, type RouteInput, type RouteOutput } from "@wizard/llm";
import { callTool, runToolLoop, type ToolLoopResult } from "../core/index.js";
import { raiseStep, upperBoundCredits } from "./budget.js";
import { BuilderContext, MAX_CHARS, MIN_CHARS } from "./context.js";
import { humanDiff } from "./diff.js";
import { maskSpec } from "./digest.js";
import { sdkDocs, uiKitDocs } from "./docs.js";
import { gateReportText, PHASE_TEXT, STATIC_PROMPT, sessionMessage } from "./prompt.js";
import {
  type AnyTool,
  type ApplyOpsArgs,
  builderTools,
  fail,
  type GateToolResult,
  MAX_FILE_BYTES,
  type PlanStep,
  SOFT_MAX_LINES,
  submitPlanTool,
  type ToolEnv,
  WRITE_PATH_RE,
} from "./tools.js";
import type {
  BuildCard,
  BuilderGateLevel,
  BuildHost,
  BuildLimits,
  BuildOutcome,
  BuildParams,
  InputOption,
} from "./types.js";

export const DEFAULT_LIMITS: BuildLimits = {
  maxSteps: 64,
  maxWallClockMs: 45 * 60_000,
  escalationThreshold: 5,
  gateIterations: 3,
  maxChars: MAX_CHARS,
  minChars: MIN_CHARS,
};
/** builder.yaml#point_and_edit: max_steps 12. */
export const POINT_EDIT_MAX_STEPS = 12;
export const RETRY_EXTRA_STEPS = 8;

/** builder.yaml#escalation.buttons. */
export const ESCALATION_OPTIONS: InputOption[] = [
  { id: "retry", label: "Попробовать ещё раз", recommended: true },
  { id: "simplify", label: "Упростить: убрать то, что не получается" },
  { id: "rollback", label: "Вернуть последнюю рабочую версию" },
  { id: "rephrase", label: "Объяснить по-другому", freeText: true },
];

const STEP_LABELS: Record<Phase, string> = {
  plan: "Составляю план",
  ops: "Собираю модель данных",
  code: "Пишу код",
  verify: "Проверяю",
  fix: "Исправляю ошибки",
};

type Phase = "plan" | "ops" | "code" | "verify" | "fix";

class BuildStop extends Error {
  constructor(readonly outcome: BuildOutcome) {
    super(outcome.status);
  }
}

const isBlocking = (c: Check) => (c.status === "fail" || c.status === "error") && c.severity === "blocker";
const failedChecks = (r: GateReport) => r.checks.filter((c) => c.status === "fail" || c.status === "error");

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export async function runBuild(host: BuildHost, params: BuildParams): Promise<BuildOutcome> {
  return new Builder(host, params).run();
}

class Builder implements ToolEnv {
  readonly #host: BuildHost;
  readonly #p: BuildParams;
  readonly #card: BuildCard;
  readonly #limits: BuildLimits;
  readonly #now: () => number;
  readonly #runId: string;
  readonly #ctx: BuilderContext;
  readonly #tools: AnyTool[];
  #cap: number;
  #used = 0;
  #steps = 0;
  #maxSteps: number;
  #startedAt = 0;
  #plan: PlanStep[] | null = null;
  #phase: Phase = "plan";
  #stepRuFallback = false;
  // escalation
  #consecutive = 0;
  #escalations = 0;
  #prevErrKeys = new Set<string>();
  #recentCalls: string[] = [];
  #lastFailed = new Map<BuilderGateLevel, number>();
  #gateIters: Record<BuilderGateLevel, number> = { G0: 0, G1: 0 };
  #lastError = "";
  // state
  #dirty = true;
  #lastG0: GateReport | null = null;
  #lastReports = new Map<BuilderGateLevel, GateReport>();
  #qaChecks: QaCheck[] | null = null;
  #pending = new Map<string, { action: "create" | "update"; sha256: string; size: number }>();
  #opsIndex = 0;
  #acUnlocked = false;
  #messages = 0;

  constructor(host: BuildHost, p: BuildParams) {
    this.#host = host;
    this.#p = p;
    this.#card = p.card;
    this.#limits = { ...DEFAULT_LIMITS, ...p.limits };
    if (p.mode === "point_edit" && p.limits?.maxSteps === undefined)
      this.#limits.maxSteps = POINT_EDIT_MAX_STEPS;
    this.#maxSteps = this.#limits.maxSteps;
    this.#cap = p.cap;
    this.#now = p.now ?? Date.now;
    this.#runId = host.run?.id ?? "run";
    this.#ctx = new BuilderContext(STATIC_PROMPT, this.#limits.maxChars, this.#limits.minChars);
    this.#tools = builderTools(this, { applyOps: p.mode !== "point_edit" });
    if (p.mode === "point_edit" && !p.target) throw new Error("point_edit requires target");
  }

  async run(): Promise<BuildOutcome> {
    this.#startedAt = this.#now();
    try {
      const mode = this.#p.mode;
      if (mode === "create" || mode === "change") {
        await this.#phaseStep("plan", () => this.#planPhase());
        await this.#phaseStep("ops", async () => {
          const { version } = await this.#host.store.getSpec();
          const text = mode === "create" ? PHASE_TEXT.ops(version) : PHASE_TEXT.change(version);
          await this.#toolPhase("build_ops", text);
        });
        await this.#phaseStep("code", () => this.#toolPhase("build_code", PHASE_TEXT.code()));
      } else if (mode === "point_edit") {
        const t = this.#p.target;
        if (t) {
          this.#ctx.touch(t.file);
          await this.#phaseStep("code", () =>
            this.#toolPhase("build_code", PHASE_TEXT.pointEdit(t.file, t.instruction)),
          );
        }
      }
      return await this.#verify();
    } catch (e) {
      if (e instanceof BuildStop) return e.outcome;
      if (e instanceof LlmError) {
        return this.#failed(
          e.code === "BUDGET_EXCEEDED" ? "BUDGET_STOPPED" : "LLM_UNAVAILABLE",
          e.code === "BUDGET_EXCEEDED"
            ? "Лимит кредитов сборки исчерпан."
            : "Модели сейчас недоступны. Попробуйте запустить сборку позже.",
          e.code !== "BUDGET_EXCEEDED",
        );
      }
      throw e;
    }
  }

  // ------------------------------------------------------------------------------------------ phases

  async #phaseStep<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
    this.#phase = phase;
    this.#stepRuFallback = false;
    const t0 = this.#now();
    await this.#host.emit("step_started", { step: phase, label_ru: STEP_LABELS[phase], attempt: 1 });
    const out = await fn();
    await this.#host.emit("step_finished", {
      step: phase,
      durationMs: Math.max(0, Math.round(this.#now() - t0)),
      ruFallback: this.#stepRuFallback,
    });
    return out;
  }

  async #refreshSession(): Promise<void> {
    const { spec } = await this.#host.store.getSpec();
    const { files } = await this.listFiles();
    this.#ctx.session = sessionMessage({ card: this.#card, spec, files, plan: this.#plan });
    await this.#ctx.refreshRelevant((p) => this.#host.store.readFile(p));
  }

  async #planPhase(): Promise<void> {
    await this.#refreshSession();
    const tool = submitPlanTool(new Set(this.#card.acceptance.map((a) => a.id)));
    const title = this.#card.title ?? this.#card.summary ?? "система";
    const r = await callTool({
      route: this.#router("plan"),
      callType: "plan",
      orgPolicy: null,
      ctx: { orgId: "" },
      messages: [...this.#ctx.render(), { role: "user", content: PHASE_TEXT.plan(title) }],
      tool,
    });
    if (!r.ok)
      throw new BuildStop(
        this.#failed(
          "CONSECUTIVE_ERRORS",
          "Строитель не смог составить план сборки. Попробуйте ещё раз.",
          true,
        ),
      );
    this.#plan = r.value.steps;
    await this.#host.emit("plan_ready", {
      steps: r.value.steps.map((s) => ({ id: s.id, kind: s.kind, title: s.title })),
    });
  }

  /** One LLM step per iteration until the model answers without tool calls. */
  async #toolPhase(callType: CallType, instruction: string): Promise<string | undefined> {
    await this.#refreshSession();
    this.#ctx.push({ role: "user", content: instruction });
    for (;;) {
      if (this.#steps >= this.#maxSteps) await this.#escalate("steps");
      await this.#ctx.maybeCollapse((p) => this.#host.store.readFile(p));
      this.#opsIndex = 0;
      const messages = this.#ctx.render();
      const r = await runToolLoop({
        route: this.#router(callType),
        callType,
        orgPolicy: null,
        ctx: { orgId: "" },
        messages,
        tools: this.#tools,
        maxTurns: 1,
      });
      this.#ctx.push(...r.messages.slice(messages.length));
      await this.#flushFiles();
      if (r.reason === "stop") {
        if (r.text) await this.#say(r.text);
        return r.text;
      }
      await this.#afterTurn(r);
    }
  }

  async #verify(): Promise<BuildOutcome> {
    for (;;) {
      const g0 = await this.#phaseStep("verify", () => this.#gate("G0"));
      if (!g0.passed) {
        await this.#fixRound("G0", g0);
        continue;
      }
      const g1 = await this.#phaseStep("verify", () => this.#gate("G1"));
      if (!g1.passed) {
        await this.#fixRound("G1", g1);
        continue;
      }
      const { version } = await this.#host.store.getSpec();
      const title = this.#card.title ? `«${this.#card.title}» ` : "";
      return {
        status: "succeeded",
        resultRevision: version,
        creditsUsed: this.#credits(),
        summary_ru: `Система ${title}собрана и прошла проверки G0 и G1.`,
        steps: this.#steps,
      };
    }
  }

  async #fixRound(level: BuilderGateLevel, report: GateReport): Promise<void> {
    await this.#checkEscalation();
    this.#gateIters[level] += 1;
    if (this.#gateIters[level] > this.#limits.gateIterations) {
      await this.#escalate("gates", level);
      this.#gateIters[level] = 1;
    }
    const text = gateReportText(report, report.explanations);
    this.#ctx.pinGateReport(text);
    await this.#phaseStep("fix", () => this.#toolPhase("fix", text));
  }

  // ------------------------------------------------------------------------------------------ LLM calls

  #router(callType: CallType) {
    return async (input: RouteInput): Promise<RouteOutput> => {
      this.#checkAlive();
      const tools = input.tools ?? [];
      const ub = upperBoundCredits(callType, input.messages, tools);
      if (!this.#host.managesBudget) {
        while (this.#used + ub > this.#cap) await this.#budgetExceeded();
      }
      this.#steps += 1;
      const step = `${this.#phase}#${this.#steps}`;
      const out = await this.#host.runStep(step, () =>
        this.#host.route({
          callType,
          messages: input.messages,
          tools,
          ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
          step,
          upperBoundCredits: ub,
        }),
      );
      this.#used = Math.round((this.#used + out.creditsCharged) * 1000) / 1000;
      this.#stepRuFallback ||= out.ruFallback;
      if (!this.#host.managesBudget)
        await this.#host.emit("budget_update", { used: this.#credits(), cap: this.#cap });
      return out;
    };
  }

  #credits(): number {
    return Math.round(this.#used * 1000) / 1000;
  }

  #checkAlive(): void {
    if (this.#host.signal?.aborted)
      throw new BuildStop({
        status: "cancelled",
        reason: "aborted",
        creditsUsed: this.#credits(),
        summary_ru: "Сборка отменена",
        steps: this.#steps,
      });
    if (this.#now() - this.#startedAt > this.#limits.maxWallClockMs)
      throw new BuildStop(this.#failed("BUDGET_STOPPED", "Сборка идёт дольше 45 минут и остановлена.", true));
  }

  async #budgetExceeded(): Promise<void> {
    await this.#flushFiles();
    await this.#host.emit("budget_exceeded", {
      used: this.#credits(),
      cap: this.#cap,
      nextStep: this.#phase,
    });
    const n = raiseStep(this.#cap);
    const ans = await this.#host.needsInput({
      kind: "decision",
      decisionId: "budget",
      prompt_ru: `Лимит сборки (${this.#cap} кр.) исчерпан. Увеличить лимит на ${n} кр. или остановить?`,
      options: [
        { id: `raise_cap_${n}`, label: `Увеличить на ${n} кр.`, recommended: true },
        { id: "stop", label: "Остановить, оставить как есть" },
      ],
    });
    const m = /^raise_cap_(\d+)$/.exec(ans.choice);
    if (!m)
      throw new BuildStop({
        status: "cancelled",
        reason: "budget_stop",
        creditsUsed: this.#credits(),
        summary_ru: "Сборка остановлена по лимиту кредитов",
        steps: this.#steps,
      });
    this.#cap += Number(m[1]);
  }

  async #say(text: string): Promise<void> {
    this.#messages += 1;
    await this.#host.emit("agent_message", {
      agent: "builder",
      messageId: `${this.#runId}:builder:${this.#messages}`,
      text,
    });
  }

  // ------------------------------------------------------------------------------------------ escalation

  async #afterTurn(r: ToolLoopResult): Promise<void> {
    let failedTurn = false;
    const errKeys = new Set<string>();
    for (const { call, ok, content } of r.results) {
      this.#recentCalls.push(`${call.name}:${stable(call.args)}`);
      if (this.#recentCalls.length > 3) this.#recentCalls.shift();
      if (this.#recentCalls.length === 3 && new Set(this.#recentCalls).size === 1) {
        failedTurn = true;
        this.#recentCalls = [];
      }
      if (!ok) {
        const err = (content as { error: { code: string; message: string; issues?: { path: string }[] } })
          .error;
        const key = `${err.code}|${err.issues?.[0]?.path ?? ""}`;
        errKeys.add(key);
        this.#lastError = err.message;
        if (this.#prevErrKeys.has(key)) failedTurn = true;
      }
    }
    this.#prevErrKeys = errKeys;
    if (failedTurn) this.#consecutive += 1;
    await this.#checkEscalation();
  }

  #noteGate(level: BuilderGateLevel, report: GateReport): void {
    const failed = report.checks.filter(isBlocking).length;
    const prev = this.#lastFailed.get(level);
    if (report.passed || (prev !== undefined && failed < prev)) this.#consecutive = 0;
    else this.#consecutive += 1;
    this.#lastFailed.set(level, failed);
    const files = failedChecks(report)
      .map((c) => c.file)
      .filter((f): f is string => typeof f === "string");
    this.#ctx.setPriority(files);
  }

  async #checkEscalation(): Promise<void> {
    if (this.#consecutive >= this.#limits.escalationThreshold) await this.#escalate("errors");
  }

  async #escalate(kind: "errors" | "gates" | "steps", level?: BuilderGateLevel): Promise<void> {
    if (this.#escalations >= 1) {
      const reports = [...this.#lastReports.values()];
      throw new BuildStop(
        kind === "gates"
          ? {
              ...this.#failed("GATES_FAILED", "Проверки так и не прошли после исправлений.", true),
              ...(reports.length ? { reports } : {}),
            }
          : this.#failed(
              "CONSECUTIVE_ERRORS",
              "Строитель несколько раз подряд не смог исправить ошибки.",
              true,
            ),
      );
    }
    this.#escalations += 1;
    await this.#flushFiles();
    const ans = await this.#host.needsInput({
      kind: "decision",
      decisionId: "escalation",
      prompt_ru: this.#escalationText(kind, level),
      options: ESCALATION_OPTIONS,
    });
    if (ans.choice === "rollback")
      throw new BuildStop({
        status: "cancelled",
        reason: "rollback",
        creditsUsed: this.#credits(),
        summary_ru: "Возвращена последняя рабочая версия",
        steps: this.#steps,
      });
    this.#consecutive = 0;
    this.#gateIters = { G0: 0, G1: 0 };
    this.#prevErrKeys.clear();
    this.#recentCalls = [];
    if (ans.choice === "simplify") {
      this.#acUnlocked = true;
      this.#ctx.push({ role: "user", content: PHASE_TEXT.simplify() });
    } else if (ans.choice === "rephrase" && ans.text) {
      this.#ctx.push({ role: "user", content: PHASE_TEXT.escalationRephrase(ans.text) });
    } else {
      this.#maxSteps = Math.max(this.#maxSteps, this.#steps) + RETRY_EXTRA_STEPS;
      this.#ctx.push({ role: "user", content: PHASE_TEXT.retry() });
    }
  }

  /** Short Russian explanation (≤ 400 chars), built by code: no extra LLM call after the threshold. */
  #escalationText(kind: "errors" | "gates" | "steps", level?: BuilderGateLevel): string {
    const last = [...this.#lastReports.values()].at(-1);
    const problems = last && !last.passed ? failedChecks(last).map((c) => c.message_ru) : [];
    if (problems.length === 0 && this.#lastError) problems.push(this.#lastError);
    const head =
      kind === "gates"
        ? `Проверки ${level ?? ""} не проходят после ${this.#limits.gateIterations} попыток исправления.`
        : kind === "steps"
          ? "Сборка заняла больше шагов, чем рассчитано."
          : "Не получается исправить ошибки: несколько попыток подряд без результата.";
    const detail = problems.length ? ` Что не получается: ${problems.slice(0, 2).join("; ")}.` : "";
    const text = `${head}${detail} Что делаем?`.replace(/\s+/g, " ");
    return text.length > 400 ? `${text.slice(0, 390)}… Что делаем?` : text;
  }

  #failed(
    code: Extract<BuildOutcome, { status: "failed" }>["code"],
    message_ru: string,
    retryable: boolean,
  ): BuildOutcome {
    return {
      status: "failed",
      code,
      message_ru,
      retryable,
      creditsUsed: this.#credits(),
      steps: this.#steps,
    };
  }

  // ------------------------------------------------------------------------------------------ gates

  async #gate(level: BuilderGateLevel): Promise<GateReport> {
    await this.#flushFiles();
    if (level === "G0" && !this.#dirty && this.#lastG0) return this.#lastG0;
    let checks: QaCheck[] | undefined;
    if (level === "G1") {
      if (this.#qaChecks === null) {
        const { spec, version } = await this.#host.store.getSpec();
        this.#qaChecks = await this.#host.runStep("qa_generate", () =>
          this.#host.qa.generate({ card: this.#card, spec, specVersion: version }),
        );
      }
      checks = this.#qaChecks;
    }
    let report = await this.#host.runStep(`gate_${level}`, () =>
      this.#host.runGates(level, checks ? { checks } : undefined),
    );
    if (level === "G0") {
      this.#lastG0 = report;
      this.#dirty = false;
    }
    if (level === "G1" && !report.passed && !report.explanations?.length) {
      const { spec } = await this.#host.store.getSpec();
      const explanations = await this.#host.runStep("qa_explain", () =>
        this.#host.qa.explain({ card: this.#card, spec, report }),
      );
      if (explanations.length) report = { ...report, explanations };
    }
    this.#lastReports.set(level, report);
    this.#noteGate(level, report);
    return report;
  }

  async #flushFiles(): Promise<void> {
    if (this.#pending.size === 0) return;
    const committed = await this.#host.store.commitFiles();
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const [path, f] of pending)
      await this.#host.emit("file_written", {
        path,
        action: f.action,
        sha256: f.sha256,
        size: f.size,
        revision: committed?.revision ?? null,
      });
  }

  // ------------------------------------------------------------------------------------------ tools (ToolEnv)

  async applyOps(args: ApplyOpsArgs): Promise<{ ok: true; version: number; humanDiff: string[] }> {
    const before = await this.#host.store.getSpec();
    const issues = this.#lockIssues(args.ops);
    if (issues.length > 0) {
      const code = issues[0]?.code ?? "ACCEPTANCE_LOCKED";
      fail(code, "Батч не применён: он ослабляет требования карточки.", issues);
    }
    const i = this.#opsIndex++;
    const key = args.idempotencyKey
      ? `${this.#runId}:${args.idempotencyKey}`
      : `${this.#runId}:${this.#steps}:${i}`;
    const r = await this.#host.store.applyOps(args.ops, args.expectedVersion, key);
    if (!r.ok) {
      const first = r.errors[0];
      fail(
        first?.code ?? "SCHEMA_INVALID",
        "Батч не применён, спека не изменилась. Исправь ошибки и отправь батч целиком.",
        r.errors.map((e) => ({
          path: e.path,
          code: e.code,
          message: `${e.message_ru}${e.allowed ? ` (допустимо: ${e.allowed.join(", ")})` : ""}${e.hint ? `. ${e.hint}` : ""}`,
        })),
        { errors: r.errors },
      );
    }
    const diff = humanDiff(args.ops, before.spec, r.spec);
    this.#dirty = true;
    await this.#host.emit("ops_applied", {
      revision: r.version,
      opsCount: args.ops.length,
      opTypes: [...new Set(args.ops.map((o) => String(o.op)))],
      summary_ru: diff,
    });
    return { ok: true, version: r.version, humanDiff: diff };
  }

  /** ACCEPTANCE_LOCKED (create|change) and PERMISSION_WIDENING (create) — builder.yaml#tools.apply_ops.rules. */
  #lockIssues(ops: Record<string, unknown>[]): { path: string; code: string; message: string }[] {
    const out: { path: string; code: string; message: string }[] = [];
    const mode = this.#p.mode;
    const cardAc = this.#card.acceptance;
    ops.forEach((op, i) => {
      if (op.op === "set_acceptance" && (mode === "create" || mode === "change") && !this.#acUnlocked) {
        const list = Array.isArray(op.acceptance) ? (op.acceptance as Record<string, unknown>[]) : [];
        for (const ac of cardAc) {
          const got = list.find((a) => a.id === ac.id);
          const check = (got?.check ?? {}) as Record<string, unknown>;
          const same = Object.entries(ac.check).every(([k, v]) => v === undefined || check[k] === v);
          if (!got || !same)
            out.push({
              path: `/ops/${i}/acceptance`,
              code: "ACCEPTANCE_LOCKED",
              message: `Критерий ${ac.id} из карточки нельзя ${got ? "ослаблять" : "удалять"}: «${ac.text}».`,
            });
        }
      }
      if (op.op === "set_permission" && mode === "create") {
        const role = String(op.role);
        const entity = String(op.entity);
        const granted = Array.isArray(op.ops) ? op.ops.map(String) : [];
        if (!this.#card.roles.some((r) => r.name === role))
          out.push({
            path: `/ops/${i}/role`,
            code: "PERMISSION_WIDENING",
            message: `Роли «${role}» нет в карточке: права ей выдавать нельзя.`,
          });
        const filtered = (o: string) => {
          const rf = op.rowFilter as Record<string, unknown> | undefined;
          if (!rf || Object.keys(rf).length === 0) return false;
          const rfo = Array.isArray(op.rowFilterOps) ? op.rowFilterOps.map(String) : null;
          return rfo === null || rfo.includes(o);
        };
        for (const ac of cardAc) {
          const c = ac.check;
          if (
            c.type !== "permission" ||
            c.expect !== "deny" ||
            c.role !== role ||
            c.entity !== entity ||
            !c.op
          )
            continue;
          if (granted.includes(c.op) && !filtered(c.op))
            out.push({
              path: `/ops/${i}/ops`,
              code: "PERMISSION_WIDENING",
              message: `Критерий ${ac.id} запрещает роли «${role}» операцию ${c.op} над «${entity}».`,
            });
        }
      }
    });
    return out;
  }

  async writeFile(path: string, content: string): Promise<{ ok: true; bytes: number; warnings: string[] }> {
    const target = this.#p.target;
    if (this.#p.mode === "point_edit" && target && path !== target.file)
      fail("TARGET_ONLY", `В этом режиме можно менять только ${target.file}.`, [
        { path, message: "другой файл" },
      ]);
    if (!WRITE_PATH_RE.test(path))
      fail("PATH_FORBIDDEN", "Путь должен быть ui/<имя>.tsx или functions/<имя>.ts.", [
        { path, message: "недопустимый путь" },
      ]);
    if (content.trim() === "") fail("EMPTY_FILE", "Файл пустой: пришли полный текст файла.");
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE_BYTES)
      fail("FILE_TOO_LARGE", `Файл больше 48 КБ (${bytes} Б): разбей на компоненты.`, [
        { path, message: "размер" },
      ]);
    const { spec } = await this.#host.store.getSpec();
    const checks = checkFile(path, content, spec);
    const bad = checks.filter((c) => c.status === "fail" || c.status === "error");
    if (bad.length > 0)
      fail(
        "STATIC_CHECK_FAILED",
        "Файл не записан: запрещённый импорт или API.",
        bad.map((c) => ({ path: c.line ? `${path}:${c.line}` : path, code: c.id, message: c.message_ru })),
        {
          checks: bad.map((c) => ({ id: c.id, message_ru: c.message_ru, line: c.line, fixHint: c.fixHint })),
        },
      );
    const prev = await this.#host.store.readFile(path);
    await this.#host.store.writeFile(path, content);
    const known = this.#pending.get(path);
    this.#pending.set(path, {
      action: known?.action ?? (prev === null ? "create" : "update"),
      sha256: createHash("sha256").update(content).digest("hex"),
      size: bytes,
    });
    this.#dirty = true;
    this.#ctx.touch(path);
    const warnings = checks.filter((c) => c.status === "warn").map((c) => c.message_ru);
    const lines = content.split("\n").length;
    if (lines > SOFT_MAX_LINES)
      warnings.push(`В файле ${lines} строк: лучше разбить на компоненты до 400 строк.`);
    return { ok: true, bytes, warnings };
  }

  async readFile(path: string): Promise<{ content: string }> {
    if (path === "spec.json") {
      const { spec } = await this.#host.store.getSpec();
      return { content: JSON.stringify(maskSpec(spec), null, 1) };
    }
    if (path === "_generated/wizard.d.ts") {
      const { spec } = await this.#host.store.getSpec();
      return { content: generateTypes(spec as AppSpec) };
    }
    if (path === "card.json") return { content: JSON.stringify(this.#card, null, 1) };
    const content = /^(ui|functions)\//.test(path) ? await this.#host.store.readFile(path) : null;
    if (content === null) fail("NOT_FOUND", `Файла ${path} нет.`, [{ path, message: "нет файла" }]);
    this.#ctx.touch(path);
    return { content };
  }

  async listFiles(prefix?: "ui/" | "functions/"): Promise<{ files: { path: string; bytes: number }[] }> {
    const paths = await this.#host.store.listFiles(prefix);
    const files: { path: string; bytes: number }[] = [];
    for (const path of paths) {
      const c = await this.#host.store.readFile(path);
      if (c !== null) files.push({ path, bytes: Buffer.byteLength(c) });
    }
    return { files };
  }

  async runGate(level: BuilderGateLevel): Promise<GateToolResult> {
    if (level === "G1") {
      await this.#flushFiles();
      if (this.#dirty || !this.#lastG0?.passed)
        fail(
          "GATE_PRECONDITION",
          "G1 запускается только после G0 passed на последней ревизии: сначала run_gate G0.",
        );
    }
    const report = await this.#gate(level);
    return {
      passed: report.passed,
      failed: failedChecks(report)
        .slice(0, 20)
        .map((c) => ({
          id: c.id,
          message_ru: c.message_ru,
          ...(c.file ? { file: c.file } : {}),
          ...(c.line ? { line: c.line } : {}),
          ...(c.path ? { path: c.path } : {}),
          ...(c.fixHint ? { fixHint: c.fixHint } : {}),
        })),
      ...(report.explanations?.length ? { explanations: report.explanations } : {}),
    };
  }

  uiKitDocs(components?: string[]) {
    return uiKitDocs(components);
  }

  sdkDocs(topic?: Parameters<typeof sdkDocs>[0]) {
    return sdkDocs(topic);
  }

  async askOrchestrator(q: { question: string; options?: string[] }) {
    if (this.#host.askOrchestrator) return this.#host.askOrchestrator(q);
    return answerFromCard(this.#card, q);
  }
}

/** Card/defaults answer (builder.yaml#tools.ask_orchestrator) when the host has no orchestrator bridge. */
export function answerFromCard(
  card: BuildCard,
  q: { question: string; options?: string[] },
): { answer: string; source: "card" | "defaults" } {
  const stems = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-zа-яё0-9]+/)
        .filter((w) => w.length >= 4)
        .map((w) => w.slice(0, 5)),
    );
  const want = stems(q.question);
  const facts = [
    ...(card.assumptions ?? []),
    ...(card.automations ?? []).map((a) => `${a.name}: ${a.when} → ${a.then}`),
    ...card.roles.map((r) => `${r.label}: ${(r.can ?? []).join("; ")}`),
    ...(card.screens ?? []).map((s) => `${s.title}: ${s.purpose}`),
    ...(card.data ?? []).map((d) => `${d.label}: ${d.fields.map((f) => f.label).join(", ")}`),
    ...card.acceptance.map((a) => `${a.id}: ${a.text}`),
  ];
  const scored = facts
    .map((f) => ({ f, n: [...stems(f)].filter((w) => want.has(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  if (scored.length > 0)
    return {
      answer: scored
        .slice(0, 3)
        .map((x) => x.f)
        .join("\n"),
      source: "card",
    };
  if (q.options?.length)
    return { answer: `${q.options[0]} (по умолчанию: в карточке ответа нет)`, source: "defaults" };
  return {
    answer:
      "В карточке ответа нет: выбери самый простой вариант, не расширяя права и не собирая лишних данных.",
    source: "defaults",
  };
}
