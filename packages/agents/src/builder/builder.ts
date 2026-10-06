// runBuild(host, {card, cap, mode}): agents/builder.yaml#loop — plan → ops → code → verify (G0, QA, G1) → fix,
// budgets (#budgets), escalation (#escalation); events — platform/workflows.yaml#events.
import { createHash } from "node:crypto";
import { type AppSpec, generateTypes } from "@wizard/appspec";
import { type Check, checkCode, checkFile, type GateReport, type QaCheck } from "@wizard/gates";
import {
  type CallType,
  LlmError,
  type LlmErrorCode,
  type LlmMessage,
  type RouteInput,
  type RouteOutput,
} from "@wizard/llm";
import { callTool, runToolLoop, type ToolLoopResult } from "../core/index.js";
import { type CapabilityGap, gapMessage, type RecordDevelopmentRequest } from "../gaps.js";
import { raiseStep, upperBoundCredits } from "./budget.js";
import { BuilderContext, MAX_CHARS, MIN_CHARS } from "./context.js";
import { humanDiff } from "./diff.js";
import { maskSpec } from "./digest.js";
import { sdkDocs, uiKitDocs } from "./docs.js";
import {
  BRIEF_TEXT,
  type BriefTask,
  type BuildMetrics,
  checksForFunction,
  emptyMetrics,
  FINDINGS_TEXT,
  KIND_ORDER,
  LIB_FILE_RE,
  REJECTIONS_MAX,
  REVIEW_SYSTEM,
  reviewFindings,
  reviewMessage,
  runWave,
  submitBriefTool,
  submitReviewTool,
  TASK_MAX_TURNS,
  taskMessage,
  taskOrder,
  WAVE_SIZE,
  WRITE_NUDGE,
} from "./harness.js";
import { gateReportText, PHASE_TEXT, STATIC_PROMPT, sessionMessage } from "./prompt.js";
import { droppedPageNote, dropReservedPages, isStub, pageStub, pagesOnReservedRoutes } from "./scaffold.js";
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
  HostRouteInput,
  InputOption,
  RouteBatchItem,
} from "./types.js";

export const DEFAULT_LIMITS: BuildLimits = {
  maxSteps: 64,
  maxWallClockMs: 45 * 60_000,
  escalationThreshold: 5,
  /** D75: at most 2 rounds of fixes per gate, blockers only. */
  gateIterations: 2,
  maxChars: MAX_CHARS,
  minChars: MIN_CHARS,
};
/** builder.yaml#point_and_edit: max_steps 12. */
export const POINT_EDIT_MAX_STEPS = 12;
export const RETRY_EXTRA_STEPS = 8;
/** builder.yaml#harness.verify: new QA attempts per build for scenarios QA could not write (check_invalid). */
export const QA_REGENERATIONS = 2;
/** builder.yaml#scaffold: extra code rounds when page stubs are still left after the code phase. */
export const STUB_ROUNDS = 2;

/** builder.yaml#escalation.buttons. */
export const ESCALATION_OPTIONS: InputOption[] = [
  { id: "retry", label: "Попробовать ещё раз", recommended: true },
  { id: "simplify", label: "Упростить: убрать то, что не получается" },
  { id: "rollback", label: "Вернуть последнюю рабочую версию" },
  { id: "rephrase", label: "Объяснить по-другому", freeText: true },
];

const STEP_LABELS: Record<Phase, string> = {
  plan: "Составляю техническое задание",
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

/** Tools of an executor task (builder.yaml#harness.stages.tasks.tools). */
const TASK_TOOLS = new Set([
  "write_file",
  "read_file",
  "list_files",
  "get_ui_kit_docs",
  "get_sdk_docs",
  "get_capability",
]);
const CODE_FILE_RE = /^(ui|functions)\//;

/** A reviewer failure the build may skip: a model error other than budget or abort. */
const skippableReviewError = (e: unknown) =>
  e instanceof LlmError && e.code !== "BUDGET_EXCEEDED" && e.code !== "ABORTED";

interface TaskResult {
  task: BriefTask;
  passed: boolean;
  firstPass: boolean;
}

/**
 * NOT_FOUND of read_file. Paths outside the system (platform specs and docs the prompts cite, such as runtime/sdk.md)
 * are not files of the workspace: the answer names the tools that hold that reference, so no turn is spent guessing
 * more paths (D67 eval 06.10.2026: up to 10 such reads per build).
 */
function notFound(path: string): never {
  const own = CODE_FILE_RE.test(path);
  return fail(
    "NOT_FOUND",
    own
      ? `Файла ${path} нет.`
      : `${path} — не файл системы. Читать можно только ui/**, functions/**, spec.json, card.json и _generated/wizard.d.ts; справка платформы — get_sdk_docs, get_ui_kit_docs и get_capability.`,
    [{ path, message: own ? "нет файла" : "не файл системы" }],
  );
}

/** Checks QA could not write (empty steps, G1 reports check_invalid). */
const qaInvalid = (cs: readonly QaCheck[]) =>
  cs.filter((c) => c.invalid !== undefined || (c.scenario !== undefined && c.scenario.steps.length === 0));

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
  #qaRegenerations = 0;
  #pending = new Map<string, { action: "create" | "update"; sha256: string; size: number }>();
  #opsIndex = 0;
  #acUnlocked = false;
  #messages = 0;
  // harness v2 (builder.yaml#harness)
  #brief: BriefTask[] | null = null;
  #harness = false;
  #reviewed = false;
  #metrics: BuildMetrics = emptyMetrics();
  /** ui/** and functions/** of the run as the builder wrote them: tasks read and check without host steps. */
  #files: Map<string, string> | null = null;
  #specNow: AppSpec | null = null;
  #checkChain: Promise<unknown> = Promise.resolve();
  #inWave = false;
  /** LLM calls of waves (executors, reviewer): bounded per task, not by the builder loop's max_steps. */
  #harnessSteps = 0;

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
    let outcome: BuildOutcome | undefined;
    try {
      outcome = await this.#runInner();
      return outcome;
    } finally {
      // Before run_finished/run_failed, also when the run is cancelled from the host (best effort then).
      if (this.#harness) {
        const emitted = this.#host.emit("build_metrics", {
          stages: this.#metrics,
          creditsUsed: this.#credits(),
          durationMs: Math.max(0, Math.round(this.#now() - this.#startedAt)),
        });
        if (outcome) await emitted;
        else await Promise.resolve(emitted).catch(() => undefined);
      }
    }
  }

  async #runInner(): Promise<BuildOutcome> {
    this.#startedAt = this.#now();
    try {
      const mode = this.#p.mode;
      if ((mode === "create" || mode === "change") && this.#p.pipeline === "single") {
        await this.#phaseStep("plan", () => this.#planPhase());
        await this.#phaseStep("ops", async () => {
          const { version } = await this.#host.store.getSpec();
          await this.#toolPhase(
            "build_ops",
            mode === "create" ? PHASE_TEXT.opsFromPlan(version) : PHASE_TEXT.change(version),
          );
        });
        await this.#phaseStep("code", async () => {
          const stubs = await this.#scaffoldPages();
          await this.#toolPhase("build_code", PHASE_TEXT.code(stubs));
          for (let i = 0; i < STUB_ROUNDS; i++) {
            const left = await this.#stubPages();
            if (left.length === 0) break;
            await this.#toolPhase("build_code", PHASE_TEXT.stubs(left));
          }
        });
      } else if (mode === "create" || mode === "change") {
        this.#harness = true;
        await this.#phaseStep("ops", async () => {
          const { version } = await this.#host.store.getSpec();
          const text = mode === "create" ? PHASE_TEXT.ops(version) : PHASE_TEXT.change(version);
          const before = this.#steps;
          try {
            await this.#toolPhase("build_ops", text);
          } finally {
            this.#metrics.ops.calls = this.#steps - before;
          }
        });
        const stubs = await this.#scaffoldPages();
        await this.#phaseStep("plan", () => this.#briefPhase(mode));
        await this.#phaseStep("code", async () => {
          const brief = this.#brief;
          if (brief) {
            await this.#checksUpfront(brief);
            await this.#runTasks(brief.map((task) => ({ task })));
            return;
          }
          // No valid brief: the single-agent code phase (builder.yaml#loop.phases.code).
          await this.#toolPhase("build_code", PHASE_TEXT.code(stubs));
          for (let i = 0; i < STUB_ROUNDS; i++) {
            const left = await this.#stubPages();
            if (left.length === 0) break;
            await this.#toolPhase("build_code", PHASE_TEXT.stubs(left));
          }
        });
      } else if (mode === "fix") {
        this.#harness = true;
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

  /** builder.yaml#scaffold: a stub for every declared page whose file does not exist yet; returns their paths. */
  async #scaffoldPages(): Promise<string[]> {
    const { spec } = await this.#host.store.getSpec();
    const out: string[] = [];
    for (const page of spec.pages ?? []) {
      if (out.includes(page.file) || (await this.#host.store.readFile(page.file)) !== null) continue;
      await this.#stage(page.file, pageStub(page), null);
      out.push(page.file);
    }
    await this.#flushFiles();
    return out;
  }

  /** Declared page files that still hold the stub. */
  async #stubPages(): Promise<string[]> {
    const { spec } = await this.#host.store.getSpec();
    const out: string[] = [];
    for (const page of spec.pages ?? [])
      if (!out.includes(page.file) && isStub(await this.#host.store.readFile(page.file))) out.push(page.file);
    return out;
  }

  /** One LLM step per iteration until the model answers without tool calls. */
  async #toolPhase(callType: CallType, instruction: string): Promise<string | undefined> {
    await this.#refreshSession();
    this.#ctx.push({ role: "user", content: instruction });
    for (;;) {
      if (this.#steps - this.#harnessSteps >= this.#maxSteps) await this.#escalate("steps");
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
      if (this.#brief && !this.#reviewed) {
        this.#reviewed = true;
        if (await this.#phaseStep("verify", () => this.#review())) continue;
      }
      const { version } = await this.#host.store.getSpec();
      const title = this.#card.title ? `«${this.#card.title}» ` : "";
      const target = this.#p.mode === "point_edit" ? this.#p.target : undefined;
      return {
        status: "succeeded",
        resultRevision: version,
        creditsUsed: this.#credits(),
        summary_ru: target
          ? `Правка по клику внесена в ${target.file}; проверки G0 и G1 пройдены.`
          : `Система ${title}собрана и прошла проверки G0 и G1.`,
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
    // Harness v2 (builder.yaml#harness.stages.verify.fix): findings in code files go to tasks by file; the rest
    // (spec, permissions, checks without a file) — to the builder's fix phase.
    // D75: only blockers are fixed; warnings (QA scenarios, coverage of scenario ACs) wait for the founder's review.
    const failed = failedChecks(report).filter(isBlocking);
    const byFile = new Map<string, Check[]>();
    // Repeated findings (the cause may be in the spec) and anything after an escalation answer (simplify, the
    // user's own words) go to the builder's fix phase, which sees the whole report and can apply_ops.
    if (this.#harness && this.#gateIters[level] === 1 && this.#escalations === 0)
      for (const c of failed)
        if (c.file && CODE_FILE_RE.test(c.file)) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
    if (byFile.size > 0) {
      await this.#phaseStep("fix", () =>
        this.#runTasks(
          [...byFile].map(([file, findings]) => ({
            task: this.#taskFor(file),
            fix: { findings, ...(report.explanations?.length ? { explanations: report.explanations } : {}) },
          })),
        ),
      );
    }
    const rest = failed.filter((c) => !(c.file && byFile.has(c.file)));
    if (rest.length === 0 && byFile.size > 0) return;
    const text = gateReportText({ ...report, checks: rest }, report.explanations);
    this.#ctx.pinGateReport(text);
    this.#metrics.verify.fixPhases += 1;
    await this.#phaseStep("fix", () => this.#toolPhase("fix", text));
  }

  // ------------------------------------------------------------------------------------------ harness v2

  /** Architect (builder.yaml#harness.stages.brief): submit_brief; an invalid brief → the single-agent code phase. */
  async #briefPhase(mode: "create" | "change"): Promise<void> {
    await this.#refreshSession();
    const { spec } = await this.#host.store.getSpec();
    const existing = new Set<string>();
    if (mode === "change")
      for (const f of [...(spec.functions ?? []), ...(spec.pages ?? [])].map((x) => x.file)) {
        const src = await this.#host.store.readFile(f);
        if (src !== null && !isStub(src)) existing.add(f);
      }
    const title = this.#card.title ?? this.#card.summary ?? "система";
    const r = await callTool({
      route: this.#router("plan"),
      callType: "plan",
      orgPolicy: null,
      ctx: { orgId: "" },
      messages: [...this.#ctx.render(), { role: "user", content: BRIEF_TEXT(title, mode) }],
      tool: submitBriefTool({ spec, card: this.#card, mode, existing }),
    });
    this.#metrics.brief.retries = Math.max(0, r.stats.calls - 1);
    if (!r.ok) {
      this.#metrics.brief.fallback = true;
      return;
    }
    this.#brief = taskOrder(r.value.tasks);
    this.#metrics.brief.tasks = this.#brief.length;
    await this.#host.emit("plan_ready", {
      steps: this.#brief.slice(0, 20).map((t) => ({ id: t.id, kind: "code", title: t.title })),
    });
  }

  /** QA before code (builder.yaml#harness.stages.checks); a failure leaves generation to the first G1. */
  async #checksUpfront(brief: readonly BriefTask[]): Promise<void> {
    const { spec, version } = await this.#host.store.getSpec();
    this.#specNow = spec;
    try {
      this.#qaChecks = await this.#host.runStep("qa_generate", () =>
        this.#host.qa.generate({ card: this.#card, spec, specVersion: version, files: new Map() }),
      );
    } catch (e) {
      if (!(e instanceof LlmError) || e.code === "BUDGET_EXCEEDED" || e.code === "ABORTED") throw e;
      this.#qaChecks = null;
      return;
    }
    const checks = this.#qaChecks ?? [];
    this.#noteQaInvalid(checks);
    this.#metrics.checks.total = checks.length;
    const attached = new Set<string>();
    for (const t of brief)
      if (t.kind === "function") for (const c of this.#fileChecks(t.file)) attached.add(c.id);
    this.#metrics.checks.attached = attached.size;
  }

  /** The reasons QA could not write scenarios (check_invalid) go to build_metrics.checks.qaInvalid, deduplicated. */
  #noteQaInvalid(checks: readonly QaCheck[]): void {
    const seen = this.#metrics.checks.qaInvalid;
    for (const c of qaInvalid(checks)) {
      const line = `${c.id}: ${(c.invalid ?? ["нет шагов"]).slice(0, 2).join("; ")}`.slice(0, 300);
      if (seen.length < REJECTIONS_MAX && !seen.includes(line)) seen.push(line);
    }
  }

  /** QA scenarios calling any function declared in this file (a file may hold several). */
  #fileChecks(file: string): QaCheck[] {
    const names = (this.#specNow?.functions ?? []).filter((f) => f.file === file).map((f) => f.name);
    const seen = new Set<string>();
    return names
      .flatMap((n) => checksForFunction(this.#qaChecks ?? [], n))
      .filter((c) => !seen.has(c.id) && seen.add(c.id));
  }

  /** The brief task of a file, or a minimal one for a file outside the brief (fix mode, helper files). */
  #taskFor(file: string): BriefTask {
    const known = this.#brief?.find((t) => t.file === file);
    if (known) return known;
    const page = this.#specNow?.pages?.find((p) => p.file === file);
    return {
      id: "T0",
      kind: LIB_FILE_RE.test(file) ? "lib" : file.startsWith("functions/") ? "function" : "page",
      file,
      title: page?.title ?? file,
      goal: "Исправь ошибки проверок в этом файле, не меняя его назначения.",
      details: [],
      uses: [],
      acRefs: [],
    };
  }

  /** Spec and the files of the run, read once per group of waves (sequential host steps). */
  async #loadWorkspace(): Promise<void> {
    await this.#flushFiles();
    this.#specNow = (await this.#host.store.getSpec()).spec;
    if (this.#files) return;
    const files = new Map<string, string>();
    for (const p of await this.#host.store.listFiles()) {
      if (!CODE_FILE_RE.test(p)) continue;
      const src = await this.#host.store.readFile(p);
      if (src !== null) files.set(p, src);
    }
    this.#files = files;
  }

  /** Executor tasks in waves of WAVE_SIZE (builder.yaml#harness.stages.tasks). */
  async #runTasks(
    items: readonly {
      task: BriefTask;
      fix?: { findings: readonly Check[]; explanations?: readonly unknown[] };
    }[],
  ): Promise<void> {
    await this.#loadWorkspace();
    // Kinds never share a wave: shared modules are written before the files that import them.
    const waves = KIND_ORDER.flatMap((k) => {
      const of = items.filter((it) => it.task.kind === k);
      const out: (typeof items)[number][][] = [];
      for (let i = 0; i < of.length; i += WAVE_SIZE) out.push(of.slice(i, i + WAVE_SIZE));
      return out;
    });
    for (const wave of waves) {
      this.#inWave = true;
      const settled = await runWave(
        wave.map((it) => (route: (input: RouteInput) => Promise<RouteOutput>) => this.#taskJob(it, route)),
        (inputs) =>
          this.#dispatch(
            inputs,
            wave.map((it) => `task:${it.task.id}:${it.task.file}`),
          ),
      );
      await this.#flushFiles();
      this.#inWave = false;
      const stopping = settled.find(
        (r) =>
          r.status === "rejected" &&
          !(r.reason instanceof LlmError && !["BUDGET_EXCEEDED", "ABORTED"].includes(r.reason.code)),
      );
      if (stopping?.status === "rejected") throw stopping.reason;
      // Every call of the wave failed on the models: they are unavailable, not one task.
      if (settled.every((r) => r.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
      for (const [k, r] of settled.entries()) {
        const m = this.#metrics.tasks;
        if (r.status === "rejected") {
          // The file keeps its stub or previous text; verify sends it to a fix task.
          if (wave[k]?.fix) this.#metrics.verify.fixTasks += 1;
          else {
            m.total += 1;
            m.failed += 1;
          }
          continue;
        }
        if (wave.find((w) => w.task === r.value.task)?.fix) {
          this.#metrics.verify.fixTasks += 1;
          continue;
        }
        m.total += 1;
        if (r.value.passed) m.passed += 1;
        else m.failed += 1;
        if (r.value.firstPass) m.firstPass += 1;
      }
    }
    this.#dirty = true;
  }

  async #taskJob(
    it: { task: BriefTask; fix?: { findings: readonly Check[]; explanations?: readonly unknown[] } },
    route: (input: RouteInput) => Promise<RouteOutput>,
  ): Promise<TaskResult> {
    const { task } = it;
    const spec = this.#specNow as AppSpec;
    let messages: LlmMessage[] = [
      { role: "system", content: STATIC_PROMPT },
      {
        role: "user",
        content: taskMessage({
          card: this.#card,
          spec,
          task,
          checks: task.kind === "function" ? this.#fileChecks(task.file) : [],
          current: this.#files?.get(task.file) ?? null,
          libs: (this.#brief ?? [])
            .filter(
              (l) =>
                l.kind === "lib" &&
                l.file !== task.file &&
                (task.uses.includes(l.file) || task.kind === "lib"),
            )
            .map((l) => ({ task: l, content: this.#files?.get(l.file) ?? null })),
          ...(it.fix ? { fix: it.fix } : {}),
        }),
      },
    ];
    const tools = this.#taskTools(task.file);
    let writes = 0;
    for (let turn = 1; turn <= TASK_MAX_TURNS; turn++) {
      const r = await runToolLoop({
        route,
        callType: it.fix ? "fix" : "build_code",
        orgPolicy: null,
        ctx: { orgId: "" },
        messages,
        tools,
        maxTurns: 1,
      });
      messages = r.messages;
      this.#metrics.tasks.calls += 1;
      const wrote = r.results.some((x) => x.ok && x.call.name === "write_file");
      if (wrote) writes += 1;
      const cur = this.#files?.get(task.file) ?? null;
      // A fix task is done only by a new text of the file: its findings come from checks checkCode does not run.
      if (!wrote && (cur === null || isStub(cur) || (it.fix && writes === 0))) {
        messages.push({ role: "user", content: WRITE_NUDGE(task.file) });
        continue;
      }
      if (!wrote && r.reason !== "stop") continue;
      const findings = await this.#checkTaskFile(task.file);
      if (findings.length === 0) return { task, passed: true, firstPass: writes === 1 };
      messages.push({ role: "user", content: FINDINGS_TEXT(task.file, findings) });
    }
    return { task, passed: false, firstPass: false };
  }

  /** Code checks of G0 for one file, one at a time (tsc is heavy), on the builder's own copy of the files. */
  #checkTaskFile(file: string): Promise<Check[]> {
    const run = () =>
      checkCode({ spec: this.#specNow as AppSpec, files: this.#files ?? new Map(), file }).then((cs) =>
        cs.filter((c) => c.severity === "blocker"),
      );
    const p = this.#checkChain.then(run, run);
    this.#checkChain = p.catch(() => undefined);
    return p;
  }

  #taskTools(file: string): AnyTool[] {
    const env: ToolEnv = {
      applyOps: async () => fail("NOT_ALLOWED", "В задаче исполнителя спеку не меняют."),
      writeFile: (path, content) => {
        if (path !== file)
          fail("TASK_FILE_ONLY", `В этой задаче можно писать только ${file}.`, [
            { path, message: "другой файл" },
          ]);
        return this.#writeChecked(path, content, this.#specNow as AppSpec, this.#files?.get(path) ?? null);
      },
      readFile: async (path) => this.#readWorkspace(path),
      listFiles: async (prefix) => ({
        files: [...(this.#files ?? new Map<string, string>())]
          .filter(([p]) => !prefix || p.startsWith(prefix))
          .map(([path, c]) => ({ path, bytes: Buffer.byteLength(c) })),
      }),
      runGate: async () => fail("NOT_ALLOWED", "Проверки запускает харнесс после записи файла."),
      uiKitDocs: (c) => uiKitDocs(c),
      sdkDocs: (t) => sdkDocs(t),
      askOrchestrator: async (q) => answerFromCard(this.#card, q),
    };
    return builderTools(env, { applyOps: false }).filter((t) => TASK_TOOLS.has(t.name));
  }

  async #readWorkspace(path: string): Promise<{ content: string }> {
    const spec = this.#specNow as AppSpec;
    if (path === "spec.json") return { content: JSON.stringify(maskSpec(spec), null, 1) };
    if (path === "_generated/wizard.d.ts") return { content: generateTypes(spec) };
    if (path === "card.json") return { content: JSON.stringify(this.#card, null, 1) };
    const content = this.#files?.get(path) ?? null;
    if (content === null) notFound(path);
    return { content };
  }

  /**
   * One wave's LLM calls (builder.yaml#harness.tasks.parallel): one host.routeBatch (one durable step, one budget
   * check) or route() one by one in job order.
   */
  async #dispatch(
    inputs: RouteInput[],
    names: readonly string[],
  ): Promise<({ ok: true; out: RouteOutput } | { ok: false; error: Error })[]> {
    this.#checkAlive();
    await this.#flushFiles();
    const ubs = inputs.map((i) => upperBoundCredits(i.callType as CallType, i.messages, i.tools ?? []));
    const total = ubs.reduce((a, b) => a + b, 0);
    if (!this.#host.managesBudget) while (this.#used + total > this.#cap) await this.#budgetExceeded();
    const hostInputs: HostRouteInput[] = inputs.map((input, i) => {
      this.#steps += 1;
      this.#harnessSteps += 1;
      return {
        callType: input.callType,
        messages: input.messages,
        tools: input.tools ?? [],
        ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
        step: `${names[i] ?? "task"}#${this.#steps}`,
        upperBoundCredits: ubs[i] ?? 0,
      };
    });
    let items: RouteBatchItem[];
    const batch = this.#host.routeBatch?.bind(this.#host);
    if (batch && hostInputs.length > 1) {
      items = await this.#host.runStep(`batch:${hostInputs.map((h) => h.step).join(",")}`, () =>
        batch(hostInputs),
      );
      for (const it of items) if (it.ok) this.#account(it.out);
      if (!this.#host.managesBudget)
        await this.#host.emit("budget_update", { used: this.#credits(), cap: this.#cap });
    } else {
      items = [];
      for (const h of hostInputs) {
        try {
          const out = await this.#host.runStep(h.step as string, () => this.#host.route(h));
          items.push({ ok: true, out });
          this.#account(out);
        } catch (e) {
          if (!(e instanceof LlmError)) throw e;
          items.push({ ok: false, code: e.code, message: e.message });
        }
        if (!this.#host.managesBudget)
          await this.#host.emit("budget_update", { used: this.#credits(), cap: this.#cap });
      }
    }
    return items.map((it) =>
      it.ok ? it : { ok: false as const, error: new LlmError(it.code as LlmErrorCode, it.message) },
    );
  }

  #account(out: RouteOutput): void {
    this.#used = Math.round((this.#used + out.creditsCharged) * 1000) / 1000;
    this.#stepRuFallback ||= out.ruFallback;
  }

  /** Reviewer (builder.yaml#harness.stages.review): critical findings → one round of page fix tasks. */
  async #review(): Promise<boolean> {
    await this.#loadWorkspace();
    const declared = new Set((this.#specNow?.pages ?? []).map((p) => p.file));
    const pages = (this.#brief ?? []).filter(
      (t) => t.kind === "page" && declared.has(t.file) && this.#files?.has(t.file),
    );
    this.#metrics.review.pages = pages.length;
    for (let i = 0; i < pages.length; i += WAVE_SIZE) {
      const wave = pages.slice(i, i + WAVE_SIZE);
      let settled: PromiseSettledResult<Awaited<ReturnType<typeof callTool>>>[];
      try {
        settled = await runWave(
          wave.map(
            (task) => (route: (input: RouteInput) => Promise<RouteOutput>) =>
              callTool({
                route,
                callType: "audit",
                orgPolicy: null,
                ctx: { orgId: "" },
                messages: [
                  { role: "system", content: REVIEW_SYSTEM },
                  {
                    role: "user",
                    content: reviewMessage({
                      card: this.#card,
                      task,
                      source: this.#files?.get(task.file) ?? "",
                    }),
                  },
                ],
                tool: submitReviewTool(),
              }),
          ),
          (inputs) =>
            this.#dispatch(
              inputs,
              wave.map((t) => `review:${t.id}:${t.file}`),
            ),
        );
      } catch (e) {
        if (!skippableReviewError(e)) throw e;
        this.#metrics.review.skipped = true;
        return false;
      }
      for (const [k, r] of settled.entries()) {
        if (r.status === "rejected") {
          // Cancel, budget stop and anything that is not a model failure stop the build (never a "success").
          if (!skippableReviewError(r.reason)) throw r.reason;
          // The reviewer is a second opinion: when its models are unavailable the build goes on (metrics note it).
          this.#metrics.review.skipped = true;
          continue;
        }
        if (!r.value.ok) {
          this.#metrics.review.skipped = true;
          continue;
        }
        const review = r.value.value as import("./harness.js").Review;
        const task = wave[k] as BriefTask;
        const critical = reviewFindings(review);
        this.#metrics.review.minor += review.issues.filter((x) => x.severity === "minor").length;
        if (critical.length === 0) this.#metrics.review.ok += 1;
        else this.#metrics.review.critical += critical.length;
      }
    }
    // D75: the reviewer's findings are warnings for the founder's review (build_metrics.review), not a fix round.
    return false;
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
        const err = (
          content as {
            error: {
              code: string;
              message: string;
              issues?: { path: string; code?: string; message?: string }[];
            };
          }
        ).error;
        const key = `${err.code}|${err.issues?.[0]?.path ?? ""}`;
        errKeys.add(key);
        // The escalation text names what failed, not the generic «batch not applied».
        this.#lastError = err.issues?.[0]?.message ?? err.message;
        if (this.#metrics.rejections.length < REJECTIONS_MAX)
          this.#metrics.rejections.push({
            phase: this.#phase,
            tool: call.name,
            code: err.code,
            issues: (err.issues ?? []).slice(0, 6).map((i) => `${i.code ?? err.code}@${i.path}`),
          });
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
      // QA could not write some scenarios (check_invalid): not the builder's to fix. QA is asked again right away
      // (QA_REGENERATIONS per build at most; failures are not cached) instead of failing G1 on the same empty checks.
      while (
        this.#qaChecks === null ||
        (qaInvalid(this.#qaChecks).length > 0 && this.#qaRegenerations < QA_REGENERATIONS)
      ) {
        if (this.#qaChecks !== null) this.#qaRegenerations += 1;
        const { spec, version } = await this.#host.store.getSpec();
        const files = new Map<string, string>();
        for (const p of await this.#host.store.listFiles("functions/")) {
          const src = await this.#host.store.readFile(p);
          if (src !== null) files.set(p, src);
        }
        this.#qaChecks = await this.#host.runStep("qa_generate", () =>
          this.#host.qa.generate({ card: this.#card, spec, specVersion: version, files }),
        );
        this.#noteQaInvalid(this.#qaChecks);
      }
      checks = this.#qaChecks;
    }
    if (level === "G0") this.#metrics.verify.g0Runs += 1;
    else this.#metrics.verify.g1Runs += 1;
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
    // In waves tasks stage files concurrently: the events then go out sorted, in a stable order.
    const pending = [...this.#pending];
    if (this.#inWave) pending.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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

  async applyOps(
    input: ApplyOpsArgs,
  ): Promise<{ ok: true; version: number; humanDiff: string[]; notes?: string[] }> {
    const before = await this.#host.store.getSpec();
    const { ops, dropped } = dropReservedPages(input.ops, before.spec);
    const notes = dropped.map(droppedPageNote);
    if (ops.length === 0) return { ok: true, version: before.version, humanDiff: [], notes };
    // The run holds the system's lock: no other writer can move the draft, so a stale expectedVersion of the model
    // (it does not see revisions made by file commits) is replaced by the current one — no VERSION_CONFLICT turns
    // (D67 eval 06.10.2026: 4 per build in the fix phase).
    const args = { ...input, ops, expectedVersion: before.version };
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
    // A page declared earlier may end up on the policy page set by this batch: the runtime serves that route.
    let version = r.version;
    const taken = pagesOnReservedRoutes(r.spec);
    if (taken.length > 0) {
      const fix = taken.map((p) => ({ op: "remove_page", route: p.route }));
      const r2 = await this.#host.store.applyOps(fix, r.version, `${key}:reserved`);
      if (r2.ok) {
        version = r2.version;
        const diff2 = humanDiff(fix, r.spec, r2.spec);
        diff.push(...diff2);
        notes.push(...taken.map(droppedPageNote));
        await this.#host.emit("ops_applied", {
          revision: r2.version,
          opsCount: fix.length,
          opTypes: ["remove_page"],
          summary_ru: diff2,
        });
      }
    }
    return { ok: true, version, humanDiff: diff, ...(notes.length ? { notes } : {}) };
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
    const { spec } = await this.#host.store.getSpec();
    const prev = this.#files?.has(path)
      ? (this.#files.get(path) ?? null)
      : await this.#host.store.readFile(path);
    return this.#writeChecked(path, content, spec, prev);
  }

  /** write_file rules (builder.yaml#tools.write_file) on a given spec; stages the file. */
  async #writeChecked(
    path: string,
    content: string,
    spec: AppSpec,
    prev: string | null,
  ): Promise<{ ok: true; bytes: number; warnings: string[] }> {
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
    await this.#stage(path, content, prev);
    this.#ctx.touch(path);
    const warnings = checks.filter((c) => c.status === "warn").map((c) => c.message_ru);
    const lines = content.split("\n").length;
    if (lines > SOFT_MAX_LINES)
      warnings.push(`В файле ${lines} строк: лучше разбить на компоненты до 400 строк.`);
    return { ok: true, bytes, warnings };
  }

  /** Stages a file in the store; file_written goes out on the next flush. */
  async #stage(path: string, content: string, prev: string | null): Promise<void> {
    await this.#host.store.writeFile(path, content);
    this.#files?.set(path, content);
    const known = this.#pending.get(path);
    this.#pending.set(path, {
      action: known?.action ?? (prev === null ? "create" : "update"),
      sha256: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    });
    this.#dirty = true;
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
    if (content === null) notFound(path);
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

  get recordDevelopmentRequest(): RecordDevelopmentRequest | undefined {
    const host = this.#host;
    return host.recordDevelopmentRequest
      ? (input) => host.recordDevelopmentRequest?.(input) as Promise<void>
      : undefined;
  }

  /** report_capability_gap during the build: the owner gets the honest answer as an agent message (M2-77). */
  async onCapabilityGap(gap: CapabilityGap): Promise<void> {
    await this.#say(gapMessage([gap]));
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
