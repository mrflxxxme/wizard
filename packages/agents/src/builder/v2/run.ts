// Builder v2 (B2-21, specs/agents/builder.yaml#v2, docs/plans/2026-10-06-beta-v2.md §2): an approved system plan is
// built in stages plan → texts → design → compile → custom → gates. Only texts and design call models; compile is
// deterministic (@wizard/modules compilePlan), the module code is never written by a model. After each stage its
// result is saved as a checkpoint of the plan revision: a repeated build of the same plan («Исправить» after a
// failure) reuses the stages already done and does not pay for them again. Each stage has a budget in ₽ and the
// whole build without custom code ≤ 15 ₽ (D76 (9)); a call that would not fit stops the build with a clear reason.
import { createHash } from "node:crypto";
import { type AppSpec, OWNER_ONLY_COMPLIANCE_FIELDS, type SystemPlan } from "@wizard/appspec";
import type { GateReport } from "@wizard/gates";
import { createRegistry } from "@wizard/llm";
import {
  type CompileSuccess,
  canonical,
  compiledFingerprint,
  compilePlan,
  type ModuleRegistry,
} from "@wizard/modules";
import { scrubJson } from "@wizard/pii";
import type { CallStats } from "../../core/loop.js";
import { DEFAULT_REGISTRY } from "../../planner/catalog.js";
import { runDesignStage } from "./design.js";
import { DEFAULT_V2_BUDGETS, remainingSec, STAGE_LABELS } from "./stages.js";
import { runTextsStage } from "./texts.js";
import {
  type CustomStageFn,
  type StageCheckpoint,
  type StageMetric,
  V2_STAGES,
  type V2Budgets,
  type V2FailureCode,
  type V2Host,
  type V2Outcome,
  type V2Params,
  type V2Stage,
} from "./types.js";
import { milliToRub, StageBudgetError, StageWallet } from "./wallet.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Offered text of a custom item deferred to «Запросы на развитие» until the custom-code stage (B2-23). */
export const CUSTOM_DEFERRED_RU = "Дописывание кодом ИИ — будет в B2-23; пока система собрана без этой части";

/** Default custom stage: every custom item becomes a development request, the system is built without it. */
export const deferCustom: CustomStageFn = async ({ host, plan }) => {
  const recorded: string[] = [];
  for (const c of plan.custom) {
    await host.recordDevelopmentRequest?.({
      category: "other",
      quote: `${c.title}: ${c.description}`,
      offered: CUSTOM_DEFERRED_RU,
    });
    recorded.push(c.id);
  }
  return {
    data: { deferred: true, recorded },
    costMilli: 0,
    notes_ru: plan.custom.map(
      (c) => `«${c.title}» пока не вошло в систему — мы записали это в запросы на развитие.`,
    ),
  };
};

class V2Failure extends Error {
  constructor(
    readonly code: V2FailureCode,
    readonly message_ru: string,
    readonly retryable: boolean,
    readonly reports?: GateReport[],
  ) {
    super(`${code}: ${message_ru}`);
  }
}

/** Owner-only compliance fields (operator, consent text, retention waiver) of the current draft survive a rebuild. */
export function withOwnerFields(spec: AppSpec, current: AppSpec | null): AppSpec {
  const cur = current?.compliance as Record<string, unknown> | undefined;
  if (!cur) return spec;
  const keep = Object.fromEntries(
    OWNER_ONLY_COMPLIANCE_FIELDS.filter((k) => cur[k] !== undefined).map((k) => [k, cur[k]]),
  );
  if (Object.keys(keep).length === 0) return spec;
  return { ...spec, compliance: { ...(spec.compliance ?? {}), ...keep } } as AppSpec;
}

function compileOrFail(plan: unknown, registry: ModuleRegistry, appName?: string): CompileSuccess {
  const r = compilePlan(plan, registry, appName ? { appName } : {});
  if (r.ok) return r;
  const bug = r.errors.find((e) => e.code === "MODULE_BUG" || e.code === "CATALOG_INVALID");
  if (bug)
    throw new V2Failure(
      "MODULE_BUG",
      `Ошибка в модуле платформы: ${bug.message_ru}. Мы её исправим; план сохранён.`,
      false,
    );
  throw new V2Failure(
    "PLAN_INVALID",
    `План больше не собирается: ${r.errors[0]?.message_ru ?? "ошибка плана"}. Откройте план и поправьте его — сборка начнётся заново.`,
    false,
  );
}

/**
 * G2 checks only the owner can satisfy (operator of personal data — owner-only compliance fields, filled before the
 * publication; publish runs its own G2 and refuses without them, specPublishBlockers): they stay in the report but do
 * not fail the build (builder.yaml#v2.stages.gates).
 */
export const OWNER_INPUT_CHECKS: ReadonlySet<string> = new Set(["G2-PII-06"]);

/** Blockers that fail the build: failed or errored blocker checks, except the owner-input ones of G2. */
export function buildBlockers(r: GateReport): GateReport["checks"] {
  return r.checks.filter(
    (c) =>
      c.severity === "blocker" &&
      (c.status === "fail" || c.status === "error") &&
      !(r.level === "G2" && OWNER_INPUT_CHECKS.has(c.id)),
  );
}

const OWNER_INPUT_NOTE_RU =
  "Перед публикацией укажите данные оператора персональных данных (название и контакт) — без них систему с персональными данными опубликовать нельзя.";

/** Builds an approved system plan (builder.yaml#v2). */
export async function runBuildV2(host: V2Host, p: V2Params): Promise<V2Outcome> {
  const registry = p.registry ?? DEFAULT_REGISTRY;
  const now = p.now ?? Date.now;
  const t0 = now();
  const budgets: V2Budgets = { ...DEFAULT_V2_BUDGETS, ...p.budgets };
  const llmRegistry = createRegistry();
  const rpc = p.rubPerCredit ?? llmRegistry.rubPerCredit;
  const metrics: Partial<Record<V2Stage, StageMetric>> = {};
  let runMilli = 0;
  let goals = { scenarios: 0, checked: false };

  const emitMetrics = async (status: "succeeded" | "failed") => {
    await host.emit("build_metrics", {
      stages: { pipeline: "modules", planRevision: p.planRevision, status, ...metrics, goals },
      creditsUsed: runMilli / 1000,
      durationMs: Math.max(0, now() - t0),
    });
  };

  // Base plan: the approved revision compiled again (versions of the manifests written in), and its hash.
  let base: CompileSuccess;
  try {
    base = compileOrFail(p.plan, registry, p.appName);
  } catch (e) {
    if (!(e instanceof V2Failure)) throw e;
    metrics.plan = { status: "failed", costRub: 0, durationMs: 0, note: e.code };
    await emitMetrics("failed");
    return {
      status: "failed",
      code: e.code,
      message_ru: e.message_ru,
      retryable: e.retryable,
      costRub: 0,
      stages: metrics,
    };
  }
  const planHash = sha256(canonical(base.plan));
  const saved = new Map<V2Stage, StageCheckpoint>();
  for (const cp of await host.checkpoints.load())
    if (cp.planHash === planHash && V2_STAGES.includes(cp.stage)) saved.set(cp.stage, cp);
  const customOn = base.plan.custom.length > 0;
  // Stages reuse a checkpoint only as a prefix: once one stage runs again, the later ones run again too.
  let chain = true;
  // ₽ already spent on this plan by earlier runs (excluding custom) — the build budget covers them.
  const priorRub = milliToRub(
    [...saved.values()].filter((c) => c.stage !== "custom").reduce((s, c) => s + c.costMilli, 0),
    rpc,
  );
  let spentRub = 0;
  const totalLeft = () => budgets.total - priorRub - spentRub;

  const stageEvent = async (stage: V2Stage, status: "started" | "done" | "reused" | "skipped") => {
    const i = V2_STAGES.indexOf(stage);
    await host.emit("build_stage", {
      stage,
      status,
      index: i + 1,
      total: V2_STAGES.length,
      label_ru: STAGE_LABELS[stage],
      remainingSec: remainingSec(V2_STAGES, status === "started" ? i : i + 1, customOn),
    });
  };

  /** Runs one stage: reuse its checkpoint, or run it, save the checkpoint and the metric. */
  async function stage<T extends Record<string, unknown>>(
    id: V2Stage,
    o: {
      reuse?: (cp: StageCheckpoint) => T | null;
      skip?: boolean;
      run: (
        wallet: StageWallet,
      ) => Promise<{ data: T; stats?: CallStats; fallback?: boolean; note?: string }>;
    },
  ): Promise<T> {
    const cp = saved.get(id);
    const reused = chain && cp ? (o.reuse?.(cp) ?? null) : null;
    if (reused) {
      metrics[id] = { status: "reused", costRub: 0, durationMs: 0 };
      await stageEvent(id, "reused");
      return reused;
    }
    chain = false;
    const started = now();
    const budget =
      id === "texts"
        ? budgets.texts
        : id === "design"
          ? budgets.design
          : id === "custom"
            ? budgets.custom
            : 0;
    const wallet = new StageWallet(id, budget, id === "custom" ? budgets.custom : totalLeft(), rpc);
    if (o.skip) {
      const out = await o.run(wallet);
      metrics[id] = { status: "skipped", costRub: 0, durationMs: 0 };
      await host.checkpoints.save({
        stage: id,
        planHash,
        data: out.data,
        costMilli: 0,
        durationMs: 0,
        runId: host.run.id,
      });
      await stageEvent(id, "skipped");
      return out.data;
    }
    await stageEvent(id, "started");
    await host.emit("step_started", { step: id, label_ru: STAGE_LABELS[id], attempt: 1 });
    let out: Awaited<ReturnType<typeof o.run>>;
    try {
      out = await host.runStep(`v2:${id}`, () => o.run(wallet));
    } catch (e) {
      metrics[id] = {
        status: "failed",
        costRub: wallet.spentRub,
        durationMs: Math.max(0, now() - started),
        ...(wallet.calls ? { calls: wallet.calls } : {}),
      };
      throw e;
    } finally {
      runMilli += wallet.spentMilli;
      if (id !== "custom") spentRub += wallet.spentRub;
    }
    const durationMs = Math.max(0, now() - started);
    metrics[id] = {
      status: "done",
      costRub: wallet.spentRub,
      durationMs,
      ...(wallet.calls ? { calls: wallet.calls } : {}),
      ...(out.fallback ? { fallback: true } : {}),
      ...(out.note ? { note: out.note } : {}),
    };
    await host.checkpoints.save({
      stage: id,
      planHash,
      data: out.data,
      costMilli: wallet.spentMilli,
      durationMs,
      runId: host.run.id,
    });
    await host.emit("step_finished", {
      step: id,
      durationMs,
      ...(out.stats?.ruFallback ? { ruFallback: true } : {}),
    });
    await stageEvent(id, "done");
    return out.data;
  }

  /** A stored plan of a checkpoint, if it still compiles. */
  const planOf = (cp: StageCheckpoint): { plan: SystemPlan } | null => {
    const r = compilePlan(cp.data.plan, registry, p.appName ? { appName: p.appName } : {});
    return r.ok ? { plan: r.plan } : null;
  };

  /** A model stage over the plan: a budget stop before the first call fails the build, later — the plan stays. */
  async function modelStage(
    id: "texts" | "design",
    wallet: StageWallet,
    plan: SystemPlan,
  ): Promise<{ data: { plan: SystemPlan }; stats?: CallStats; fallback?: boolean; note?: string }> {
    const args = {
      route: wallet.route(host, llmRegistry),
      runStep: host.runStep,
      plan,
      registry,
      ...(host.signal ? { signal: host.signal } : {}),
    };
    try {
      const r = id === "texts" ? await runTextsStage(args) : await runDesignStage(args);
      const next = scrubJson(r.plan).value;
      // The stage's plan must compile; otherwise the plan before the stage stays.
      const ok = compilePlan(next, registry, p.appName ? { appName: p.appName } : {}).ok;
      return {
        data: { plan: ok ? next : plan },
        stats: r.stats,
        ...(r.fallback || !ok ? { fallback: true } : {}),
        ...("changed" in r ? { note: `изменено секций: ${r.changed}` } : {}),
      };
    } catch (e) {
      if (!(e instanceof StageBudgetError)) throw e;
      if (wallet.calls > 0)
        return { data: { plan }, fallback: true, note: "бюджет этапа исчерпан на исправлениях" };
      const what =
        e.scope === "stage"
          ? `этап «${STAGE_LABELS[id]}» (до ${budgets[id]} ₽)`
          : `сборку (до ${budgets.total} ₽)`;
      throw new V2Failure(
        "STAGE_BUDGET_EXCEEDED",
        `Сборка остановлена: следующий шаг мог стоить ${e.needRub} ₽, а на ${what} осталось ${Math.max(0, e.leftRub)} ₽. Готовые этапы сохранены — повторная сборка их не оплачивает. Напишите команде, если это повторяется.`,
        false,
      );
    }
  }

  let revision = 0;
  let notes: string[] = [];
  try {
    // 1. Plan: the approved revision, compiled again (paid in the interview — free here).
    await stage("plan", {
      reuse: () => ({ fingerprint: sha256(compiledFingerprint(base)) }),
      run: async () => ({ data: { fingerprint: sha256(compiledFingerprint(base)) } }),
    });
    let plan: SystemPlan = base.plan;

    // 2. Texts of the landing sections (skipped without a landing).
    plan = (
      await stage("texts", {
        reuse: planOf,
        skip: !plan.landing,
        run: async (w) => (plan.landing ? modelStage("texts", w, plan) : { data: { plan } }),
      })
    ).plan;

    // 3. Design: direction, theme, fonts, accent, photo style, layouts.
    plan = (await stage("design", { reuse: planOf, run: (w) => modelStage("design", w, plan) })).plan;

    // 4. Compile (no models) and one draft revision with the spec and files.
    let compiled = compilePlan(plan, registry, p.appName ? { appName: p.appName } : {});
    if (!compiled.ok) {
      // A stage's plan that does not compile any more (catalog changed between runs): the approved plan stands.
      plan = base.plan;
      compiled = base;
    }
    const built = compiled;
    const fingerprint = sha256(compiledFingerprint(built));
    const current = await host.currentSpec();
    const done = await stage("compile", {
      reuse: (cp) =>
        cp.data.fingerprint === fingerprint && cp.data.revision === current.version
          ? { revision: current.version, fingerprint }
          : null,
      run: async () => {
        const spec = withOwnerFields(built.spec, current.version > 0 ? current.spec : null);
        const summary_ru = `Система собрана по плану: ${built.order.length} модулей, ${built.spec.pages?.length ?? 0} экранов`;
        const r = await host.commitCompiled({ spec, files: built.files, summary_ru });
        return { data: { revision: r.revision, fingerprint } };
      },
    });
    revision = Number(done.revision);

    // 5. Custom code (B2-23); without it the custom part goes to «Запросы на развитие».
    const custom = p.custom ?? deferCustom;
    const customData = await stage("custom", {
      reuse: (cp) => cp.data,
      skip: !customOn,
      run: async (w) => {
        if (!customOn) return { data: { skipped: true } };
        const r = await custom({ host, plan, budgetRub: w.budgetRub });
        w.spentMilli += r.costMilli;
        return { data: { ...r.data, notes_ru: r.notes_ru } };
      },
    });
    notes = Array.isArray(customData.notes_ru) ? (customData.notes_ru as string[]) : [];

    // 6. Gates G0 → G1 (goal scenarios of the plan in a browser when the host has one) → G2.
    goals = { scenarios: built.scenarios.length, checked: !!host.goalBrowser };
    let ownerInput = false;
    const gatesData = await stage("gates", {
      reuse: (cp) => (cp.data.revision === revision ? cp.data : null),
      run: async () => {
        const reports: GateReport[] = [];
        for (const level of ["G0", "G1", "G2"] as const) {
          const r = await host.runGates(
            level,
            level === "G1" && host.goalBrowser ? { goalScenarios: built.scenarios } : undefined,
          );
          reports.push(r);
          const blockers = r.passed ? [] : buildBlockers(r);
          if (!r.passed && blockers.length === 0) ownerInput = true;
          if (blockers.length > 0)
            throw new V2Failure(
              "GATES_FAILED",
              `Система собрана, но автоматическая проверка нашла ошибку: ${blockers[0]?.message_ru ?? "проверка не пройдена"}. Это ошибка модуля платформы, а не вашего плана. Готовые этапы сохранены — повторная сборка начнётся с проверки и не потратит их заново.`,
              true,
              reports,
            );
        }
        return { data: { revision, levels: ["G0", "G1", "G2"], ownerInput } };
      },
    });
    if (gatesData.ownerInput === true) notes = [...notes, OWNER_INPUT_NOTE_RU];
  } catch (e) {
    const costRub = milliToRub(runMilli, rpc);
    if (e instanceof V2Failure) {
      await emitMetrics("failed");
      return {
        status: "failed",
        code: e.code,
        message_ru: e.message_ru,
        retryable: e.retryable,
        costRub,
        stages: metrics,
        ...(e.reports ? { reports: e.reports } : {}),
      };
    }
    // Models unavailable, cancellation, infrastructure: the run fails as usual; checkpoints of done stages stay.
    await emitMetrics("failed").catch(() => {});
    throw e;
  }
  await emitMetrics("succeeded");
  const summary = ["Система собрана по утверждённому плану и прошла проверки.", ...notes].join(" ");
  return {
    status: "succeeded",
    revision,
    summary_ru: summary,
    costRub: milliToRub(runMilli, rpc),
    durationMs: Math.max(0, now() - t0),
    stages: metrics,
  };
}
