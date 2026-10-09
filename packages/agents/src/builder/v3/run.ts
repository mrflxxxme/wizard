// Build harness v3 (V3-11; specs/agents/builder-v3.md §3 C6, product.yaml D77_v3 (8)–(11), docs/plans/2026-10-08-v3.md
// §2): the latest brief is built in stages brief → design → backend → skeleton → scenarios → critic → template_gate →
// techreview → gates. Algorithms ahead of models: the brief re-read, the design system of a chosen direction, the
// backend (compilePlan {front: "backend"} + applyExtensions) and the skeleton of every page make no model call; the
// preview of the skeleton comes right after it. Then the brief's scenarios — «must» first — are brought up one by one
// by the page composer (V3-12) and checked in a browser; a scenario that fails is rolled back and the build goes on.
// The loop stops when every scenario was tried, at the time cap (30 min), at the cap (500 ₽) or — for «should»
// scenarios — at the target (300 ₽); what is left goes to «Запросы на развитие». A checkpoint after each stage and
// each scenario keyed by a fingerprint of what it read: a repeated build reuses them and does not pay again.
// Non-blocking questions are asked on the way; their answers (the brief's «вопрос → ответ» journal) are applied at
// the next step. Stages critic, template_gate and techreview are host hooks (V3-13…15), skipped while absent.
import { createHash } from "node:crypto";
import type { AppSpec, SystemBrief } from "@wizard/appspec";
import type { GateReport, GoalScenarioInput } from "@wizard/gates";
import { createRegistry } from "@wizard/llm";
import { canonical, type ModuleRegistry } from "@wizard/modules";
import { scrub } from "@wizard/pii";
import {
  archetype as archetypeById,
  type DesignSystemV3,
  designSystemV3,
  isArchetypeId,
} from "@wizard/ui-kit/v3/design";
import { DEFAULT_REGISTRY } from "../../planner/catalog.js";
import { buildBlockers } from "../v2/blockers.js";
import { withOwnerFields } from "../v2/run.js";
import { runArtDirector } from "./art-director.js";
import { readSite, withSitePages } from "./compose/index.js";
import type { V3BuildContext, V3ComposeResult } from "./contract.js";
import { type BackendBuilt, compileBackend, DESIGN_CSS_FILE, designCss } from "./harness/backend.js";
import { featureList, goalScenariosFor, type V3Feature } from "./harness/features.js";
import { type BriefPlan, briefNiche, briefPlan } from "./harness/plan.js";
import { briefAnswers, mergeAnswers, optionLabel, questionText } from "./harness/questions.js";
import {
  DEFAULT_V3_BUDGETS,
  minutesText,
  rubLabel,
  spendLine,
  V3_BUILD_LIMITS,
  V3_STAGE_ETA_SEC,
  V3_STAGE_LABELS,
} from "./harness/stages.js";
import {
  V3_HOOK_STAGES,
  V3_STAGES,
  type V3BriefVersion,
  type V3Budgets,
  type V3BuildQuestion,
  type V3Checkpoint,
  type V3FailureCode,
  type V3HookResult,
  type V3HookStage,
  type V3Host,
  type V3Limits,
  type V3Outcome,
  type V3Params,
  type V3QuestionAnswer,
  type V3ScenarioState,
  type V3Stage,
  type V3StageMetric,
  type V3StopReason,
} from "./harness/types.js";
import { milliRub, V3BudgetError, V3Wallet } from "./harness/wallet.js";

const sha256 = (v: unknown) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : (canonical(v) ?? "null"))
    .digest("hex");

class V3Failure extends Error {
  constructor(
    readonly code: V3FailureCode,
    readonly message_ru: string,
    readonly retryable: boolean,
    readonly reports?: GateReport[],
  ) {
    super(`${code}: ${message_ru}`);
  }
}

/** Files of a composer step as JSON (checkpoints): [path, source | null][]. */
type FileEntries = [string, string | null][];

const OWNER_INPUT_NOTE_RU =
  "Перед публикацией укажите данные оператора персональных данных (название и контакт) — без них систему с персональными данными опубликовать нельзя.";

const toEntries = (m: ReadonlyMap<string, string | null>): FileEntries =>
  [...m].sort(([a], [b]) => a.localeCompare(b));
const toMap = (e: unknown): Map<string, string | null> =>
  new Map(Array.isArray(e) ? (e as FileEntries).filter((x) => typeof x?.[0] === "string") : []);

/** The brief without the «вопрос → ответ» journal: what the pages are made of (answers apply through the plan). */
const briefForPages = ({ qa: _qa, ...rest }: SystemBrief) => rest;

/** Builds the latest brief of a system (builder-v3.md C6). */
export async function runBuildV3(host: V3Host, p: V3Params = {}): Promise<V3Outcome> {
  const registry: ModuleRegistry = p.registry ?? DEFAULT_REGISTRY;
  const now = p.now ?? Date.now;
  const t0 = now();
  const limits: V3Limits = { ...V3_BUILD_LIMITS, ...p.limits };
  const budgets: V3Budgets = { ...DEFAULT_V3_BUDGETS, ...p.budgets };
  const llm = createRegistry();
  const rpc = p.rubPerCredit ?? llm.rubPerCredit;
  const seed = p.seed ?? host.systemId;
  const hooks = host.hooks ?? {};
  const metrics: Partial<Record<V3Stage, V3StageMetric>> = {};
  const saved = new Map<string, V3Checkpoint>();
  for (const cp of await host.checkpoints.load()) saved.set(cp.key, cp);

  // Spend: this run's calls, and the steps reused from earlier runs (the cap covers both).
  let runMilli = 0;
  let priorMilli = 0;
  const spentRub = () => milliRub(runMilli + priorMilli, rpc);
  const capLeft = () =>
    Math.min(limits.capRub - spentRub(), (p.runCapRub ?? Number.POSITIVE_INFINITY) - milliRub(runMilli, rpc));
  /** ₽ the later paid stages keep for themselves (hooks the host gives). */
  const reserveRub = (from: V3Stage) =>
    (hooks.critic && V3_STAGES.indexOf(from) < V3_STAGES.indexOf("critic") ? budgets.critic : 0) +
    (hooks.techreview && V3_STAGES.indexOf(from) < V3_STAGES.indexOf("techreview") ? budgets.techreview : 0);
  const poolLeft = (priority: "must" | "should", from: V3Stage) =>
    (priority === "should" ? Math.min(capLeft(), limits.targetRub - spentRub()) : capLeft()) -
    reserveRub(from);

  // «Осталось» for the canvas: the expected seconds of the stages still to run.
  let scenariosLeft = 0;
  let scenarioSec = V3_STAGE_ETA_SEC.scenarios;
  const etaSec = (st: V3Stage) =>
    st === "scenarios"
      ? scenariosLeft * scenarioSec
      : (V3_HOOK_STAGES as readonly string[]).includes(st) && !hooks[st as V3HookStage]
        ? 0
        : V3_STAGE_ETA_SEC[st];
  const remainingSec = (from: number) => V3_STAGES.slice(from).reduce((s, st) => s + etaSec(st), 0);
  const stageEvent = async (stage: V3Stage, status: "started" | "done" | "reused" | "skipped") => {
    const i = V3_STAGES.indexOf(stage);
    await host.emit("build_stage", {
      stage,
      status,
      index: i + 1,
      total: V3_STAGES.length,
      label_ru: V3_STAGE_LABELS[stage],
      remainingSec: Math.round(remainingSec(status === "started" ? i : i + 1)),
    });
  };
  const say = async (messageId: string, text: string) => {
    await host.emit("agent_message", { agent: "builder", messageId, text });
  };
  const save = async (cp: Omit<V3Checkpoint, "runId">) => {
    const full = { ...cp, runId: host.run.id };
    saved.set(cp.key, full);
    await host.checkpoints.save(full);
  };

  /** Runs one stage: reuse its checkpoint when the fingerprint is the same, else run it and save the checkpoint. */
  async function stage<T extends Record<string, unknown>>(
    id: V3Stage,
    o: {
      fingerprint: string;
      reuse?: boolean;
      skip?: boolean;
      budgetRub?: number;
      run: (w: V3Wallet) => Promise<{ data: T; fallback?: boolean; note?: string; extraMilli?: number }>;
    },
  ): Promise<{ data: T; reused: boolean }> {
    const cp = saved.get(id);
    if (o.reuse !== false && cp && cp.fingerprint === o.fingerprint && !o.skip) {
      priorMilli += cp.costMilli;
      metrics[id] = { status: "reused", costRub: 0, durationMs: 0 };
      await stageEvent(id, "reused");
      return { data: cp.data as T, reused: true };
    }
    const started = now();
    const wallet = new V3Wallet(id, o.budgetRub ?? 0, poolLeft("must", id), rpc);
    if (o.skip) {
      const out = await o.run(wallet);
      metrics[id] = { status: "skipped", costRub: 0, durationMs: 0 };
      await save({ key: id, fingerprint: o.fingerprint, data: out.data, costMilli: 0, durationMs: 0 });
      await stageEvent(id, "skipped");
      return { data: out.data, reused: false };
    }
    await stageEvent(id, "started");
    await host.emit("step_started", { step: id, label_ru: V3_STAGE_LABELS[id], attempt: 1 });
    let out: Awaited<ReturnType<typeof o.run>>;
    try {
      out = await host.runStep(`v3:${id}`, () => o.run(wallet));
    } catch (e) {
      runMilli += wallet.spentMilli;
      metrics[id] = {
        status: "failed",
        costRub: wallet.spentRub,
        durationMs: Math.max(0, now() - started),
        ...(wallet.calls ? { calls: wallet.calls } : {}),
      };
      throw e;
    }
    const costMilli = wallet.spentMilli + (out.extraMilli ?? 0);
    runMilli += costMilli;
    const durationMs = Math.max(0, now() - started);
    metrics[id] = {
      status: "done",
      costRub: milliRub(costMilli, rpc),
      durationMs,
      ...(wallet.calls ? { calls: wallet.calls } : {}),
      ...(out.fallback ? { fallback: true } : {}),
      ...(out.note ? { note: out.note } : {}),
    };
    await save({ key: id, fingerprint: o.fingerprint, data: out.data, costMilli, durationMs });
    await host.emit("step_finished", { step: id, durationMs });
    await stageEvent(id, "done");
    return { data: out.data, reused: false };
  }

  // «Запросы на развитие», once per key across the runs of this system.
  const recorded = new Set<string>(
    Array.isArray(saved.get("requests")?.data.keys) ? (saved.get("requests")?.data.keys as string[]) : [],
  );
  const request = async (key: string, quote: string, offered: string | null) => {
    if (recorded.has(key) || !host.recordDevelopmentRequest) return;
    await host.recordDevelopmentRequest({
      category: "other",
      quote: scrub(quote).text.slice(0, 500),
      offered,
    });
    recorded.add(key);
    await save({
      key: "requests",
      fingerprint: "requests",
      data: { keys: [...recorded] },
      costMilli: 0,
      durationMs: 0,
    });
  };

  // The brief: re-read before each stage and each scenario (D77 (9)); a newer version applies from the next step.
  let bv: V3BriefVersion;
  let brief: SystemBrief;
  const readBrief = async (): Promise<V3BriefVersion> => {
    const v = await host.brief();
    if (!v)
      throw new V3Failure(
        "PLAN_INVALID",
        "У системы ещё нет брифа — ответьте на вопросы интервью, потом нажмите «Собрать».",
        false,
      );
    return v;
  };

  // Non-blocking questions, their answers and the plan that follows from them.
  let questions: V3BuildQuestion[] = [];
  let applied = new Map<string, string>();
  const asked = new Set<string>(
    Array.isArray(saved.get("questions")?.data.asked) ? (saved.get("questions")?.data.asked as string[]) : [],
  );
  const answersNow = async (qs: readonly V3BuildQuestion[]): Promise<V3QuestionAnswer[]> =>
    mergeAnswers(briefAnswers(brief, qs), (await host.questions?.answers?.()) ?? []);
  const planFor = async (): Promise<{ bp: BriefPlan; answers: V3QuestionAnswer[] }> => {
    const opts = p.appName ? { appName: p.appName } : {};
    const first = briefPlan(brief, registry, [], opts);
    if (!first)
      throw new V3Failure(
        "PLAN_INVALID",
        "По брифу не получилось собрать основу системы: в каталоге нет подходящих модулей. Поправьте бриф или напишите команде.",
        false,
      );
    const pending = (await host.questions?.pending?.()) ?? [];
    const qs = [...first.questions, ...pending.filter((q) => !first.questions.some((x) => x.id === q.id))];
    const answers = await answersNow(qs);
    const bp = answers.length ? (briefPlan(brief, registry, answers, opts) ?? first) : first;
    questions = qs;
    return { bp: { ...bp, questions: qs }, answers };
  };

  let previewMs: number | null = null;
  let design!: DesignSystemV3;
  let designFp = "";
  let bp!: BriefPlan;
  let backend!: BackendBuilt;
  let backendFp = "";
  let ownerSpec: AppSpec | null = null;
  // Layers of the system's files: backend → design CSS → skeleton → scenarios → hooks (null deletes a file).
  let skeleton = new Map<string, string | null>();
  const scenarioLayers = new Map<string, Map<string, string | null>>();
  const hookLayers = new Map<string, Map<string, string | null>>();
  let committed = null as { revision: number; hash: string } | null;
  let previewRevision: number | null = null;
  const states = new Map<string, V3ScenarioState>();
  let features: V3Feature[] = [];
  let stop: { reason: V3StopReason; message_ru: string } = { reason: "done", message_ru: "" };
  let revision = 0;
  let notes: string[] = [];

  const mergedFiles = (): Map<string, string> => {
    const out = new Map<string, string>(Object.entries(backend.files));
    out.set(DESIGN_CSS_FILE, designCss(design));
    for (const layer of [skeleton, ...scenarioLayers.values(), ...hookLayers.values()])
      for (const [path, src] of layer) src === null ? out.delete(path) : out.set(path, src);
    return out;
  };
  /** The spec of the merged files: the public pages of the composer's site model (ui/site.json, V3-12) on the backend. */
  const specOf = (files: ReadonlyMap<string, string>) => {
    const site = readSite(files);
    return withOwnerFields(site ? withSitePages(backend.spec, site) : backend.spec, ownerSpec);
  };
  const commit = async (summary_ru: string): Promise<number> => {
    const files = mergedFiles();
    const spec = specOf(files);
    const h = sha256({ spec, files: [...files].sort(([a], [b]) => a.localeCompare(b)) });
    if (committed?.hash === h) return committed.revision;
    const r = await host.commit({ spec, files: Object.fromEntries(files), summary_ru });
    committed = { revision: r.revision, hash: h };
    await saveDraft();
    return r.revision;
  };
  /** The draft this harness committed last and the revision the preview shows (a repeat commits nothing new). */
  const saveDraft = () =>
    save({
      key: "draft",
      fingerprint: "draft",
      data: { ...committed, previewRevision },
      costMilli: 0,
      durationMs: 0,
    });
  const ctxFor = (w: V3Wallet): V3BuildContext => {
    const files = mergedFiles();
    return {
      systemId: host.systemId,
      brief,
      briefVersion: bv.version,
      plan: backend.plan,
      spec: specOf(files),
      publicFront: backend.publicFront,
      design,
      files,
      route: w.route(host, llm),
      budgetRub: w.leftRub,
      ...(host.signal ? { signal: host.signal } : {}),
    };
  };

  /** Compiles the backend of the current plan (free); a rejected extension goes to «Запросы на развитие». */
  const buildBackend = async () => {
    const r = compileBackend({
      plan: bp.plan,
      registry,
      extensions: p.extensions ?? [],
      design,
      options: {
        ...(p.appName ? { appName: p.appName } : {}),
        ...(p.platformUrl ? { platformUrl: p.platformUrl, systemId: host.systemId } : {}),
      },
    });
    if (!r.ok) throw new V3Failure(r.code, r.message_ru, false);
    backend = r;
    backendFp = sha256({ plan: r.plan, ext: p.extensions ?? [], design: designFp });
    for (const x of r.rejected)
      await request(
        `ext:${sha256(x.op)}`,
        `Доработка системы: ${x.reasonRu}`,
        "Пока система работает без этой доработки — её можно обсудить с командой.",
      );
    for (const m of bp.unavailable)
      await request(`module:${m}`, `Модуль «${m}» для сценариев брифа`, "Пока нет: модуль ещё в разработке.");
  };

  /** Re-reads the brief before a stage (D77 (9)); true — a newer version, it applies from this step on. */
  const refreshBrief = async (): Promise<boolean> => {
    const next = await readBrief();
    if (next.version === bv.version) return false;
    bv = next;
    brief = next.brief;
    await say(
      `v3_brief_${bv.version}`,
      `Бриф обновился (версия ${bv.version}) — учитываю изменения со следующего шага.`,
    );
    return true;
  };

  /**
   * A step boundary after the backend: the latest brief, new answers to the build questions; a changed plan is
   * compiled again (free) and applies from this step on (D77 (8): the build does not wait for the answer).
   */
  const sync = async () => {
    const briefChanged = await refreshBrief();
    const answers = await answersNow(questions);
    const fresh = answers.filter((a) => applied.get(a.questionId) !== a.optionId);
    if (!briefChanged && fresh.length === 0) return;
    for (const a of fresh) {
      const q = questions.find((x) => x.id === a.questionId);
      if (q)
        await say(
          `v3_answer_${q.id}_${a.optionId}`,
          `Учёл ваш ответ: «${q.text}» — «${optionLabel(q, a.optionId)}».`,
        );
    }
    applied = new Map(answers.map((a) => [a.questionId, a.optionId]));
    const was = backendFp;
    ({ bp } = await planFor());
    await buildBackend();
    if (backendFp !== was)
      notes = [...new Set([...notes, "Основа системы пересобрана с учётом ваших ответов."])];
    features = mergeFeatures(features, featureList(brief));
    scenariosLeft = features.filter((f) => !states.has(f.id)).length;
  };

  try {
    // 1. Brief: the latest version and the feature list from its scenarios («must» first, then «should»).
    bv = await readBrief();
    brief = bv.brief;
    features = featureList(brief);
    scenariosLeft = features.length;
    await stage("brief", {
      fingerprint: sha256({ version: bv.version, brief }),
      run: async () => ({
        data: {
          version: bv.version,
          features: features.map((f) => ({ id: f.id, priority: f.priority, title: f.title })),
        },
      }),
    });

    // 2. Design: the direction the owner chose (brief.design, V3-09) by code, else the art director (one call).
    await refreshBrief();
    const niche = briefNiche(brief);
    designFp = sha256({ design: brief.design, niche, goals: brief.goals.map((g) => g.text), seed });
    const designed = await stage("design", {
      fingerprint: designFp,
      budgetRub: budgets.design,
      run: async (w) => {
        const chosen = brief.design.archetype;
        if (isArchetypeId(chosen)) {
          const ds = designSystemV3({ archetype: chosen, seed, niche });
          const name = archetypeById(chosen)?.name ?? chosen;
          return { data: { niche, archetype: chosen, source: "brief", styleName: name, design: ds } };
        }
        const recent = (await host.recentArchetypes?.(niche)) ?? [];
        const r = await runArtDirector({
          input: {
            niche,
            goals: brief.goals.map((g) => scrub(g.text).text),
            ...(brief.audience ? { audience: scrub(brief.audience).text } : {}),
            seed,
            recent,
            design: brief.design,
          },
          route: w.route(host, llm),
          runStep: host.runStep,
          ...(host.signal ? { signal: host.signal } : {}),
        });
        return {
          data: {
            niche,
            archetype: r.choice.archetype,
            source: r.choice.source,
            styleName: r.choice.styleName,
            design: r.design,
          },
          ...(r.fallback ? { fallback: true } : {}),
          ...(r.note ? { note: r.note } : {}),
        };
      },
    });
    design = designed.data.design as DesignSystemV3;
    if (!designed.reused)
      await say(
        "v3_design",
        `Стиль сайта — «${String(designed.data.styleName)}». Собираю каркас всех страниц в нём.`,
      );

    // 3. Backend: the plan of the brief (with the answers given so far) compiled without public pages, extensions.
    await refreshBrief();
    features = mergeFeatures(features, featureList(brief));
    ({ bp } = await planFor());
    applied = new Map((await answersNow(questions)).map((a) => [a.questionId, a.optionId]));
    const current = await host.currentSpec();
    ownerSpec = current.version > 0 ? current.spec : null;
    // The draft is still where an earlier run left it: its commit and preview stand.
    const draft = saved.get("draft")?.data;
    if (draft && draft.revision === current.version && typeof draft.hash === "string") {
      committed = { revision: current.version, hash: draft.hash };
      previewRevision = typeof draft.previewRevision === "number" ? draft.previewRevision : null;
    }
    await stage("backend", {
      fingerprint: sha256({ plan: bp.plan, ext: p.extensions ?? [], design: designFp }),
      reuse: false,
      run: async () => {
        await buildBackend();
        return {
          data: {
            modules: backend.plan.modules.map((m) => m.id),
            screens: backend.publicFront.screens.map((s) => s.route),
            rejected: backend.rejected.length,
          },
        };
      },
    });

    // Non-blocking questions: asked once per system, the build goes on with the recommended option.
    for (const q of questions) {
      if (asked.has(q.id) || applied.has(q.id)) continue;
      await say(`v3q_${q.id}`, questionText(q));
      await host.questions?.ask?.(q, optionLabel(q, q.recommended));
      asked.add(q.id);
    }
    await save({
      key: "questions",
      fingerprint: "questions",
      data: { asked: [...asked] },
      costMilli: 0,
      durationMs: 0,
    });

    const scenarioFp = (f: V3Feature) =>
      sha256({ scenario: f.scenario, design: designFp, front: backend.publicFront });
    /** A scenario an earlier run passed with the same inputs: its pages come from the checkpoint, nothing is paid. */
    const reuseScenario = (f: V3Feature): boolean => {
      const cp = saved.get(`scenario:${f.id}`);
      if (states.has(f.id) || cp?.fingerprint !== scenarioFp(f) || cp.data.status !== "passed") return false;
      priorMilli += cp.costMilli;
      scenarioLayers.set(f.id, toMap(cp.data.files));
      states.set(f.id, {
        id: f.id,
        title: f.title,
        priority: f.priority,
        status: "passed",
        costRub: 0,
        reused: true,
      });
      scenariosLeft -= 1;
      return true;
    };

    // 4. Skeleton: every page from library patterns with the brief's texts (no model), then the live preview.
    await sync();
    const sk = await stage("skeleton", {
      fingerprint: sha256({ design: designFp, front: backend.publicFront, brief: briefForPages(brief) }),
      run: async (w) => {
        let r: V3ComposeResult;
        try {
          r = await host.composer.skeleton(ctxFor(w));
        } catch (e) {
          if (!(e instanceof V3BudgetError)) throw e;
          // The skeleton is deterministic by contract (C6): a model call there is a bug of the page writer.
          throw new V3Failure(
            "INTERNAL",
            "Каркас страниц попытался обратиться к модели — это ошибка платформы. Мы её исправим.",
            false,
          );
        }
        return {
          data: { files: toEntries(r.files), pages: r.pages, notes: r.notes },
          extraMilli: Math.max(0, Math.round(((r.spentRub - w.spentRub) / rpc) * 1000)),
        };
      },
    });
    skeleton = toMap(sk.data.files);
    // Scenarios an earlier run brought up on the same inputs join the skeleton before its commit: a repeated build
    // makes no new revision for them and pays nothing.
    for (const f of features) reuseScenario(f);
    const before = committed?.revision ?? null;
    revision = await commit("Каркас страниц в выбранном стиле");
    if (host.preview && (revision !== before || previewRevision === null)) {
      const pr = await host.runStep("v3:preview", () => (host.preview as NonNullable<V3Host["preview"]>)());
      if (!pr.ok)
        throw new V3Failure(
          "GATES_FAILED",
          `Каркас страниц не прошёл проверку: ${pr.problems[0] ?? "проверка не пройдена"}. Это ошибка платформы, а не вашего брифа. Готовые этапы сохранены — повторная сборка их не оплачивает.`,
          true,
        );
      previewMs = Math.max(0, now() - t0);
      previewRevision = revision;
      await saveDraft();
      await say(
        "v3_preview",
        "Каркас всех страниц готов — его уже можно посмотреть в превью. Довожу сценарии по одному.",
      );
    }

    // 5. Scenarios one by one with a browser check; stop rules of D77 (10).
    await stageEvent("scenarios", "started");
    const scenariosStarted = now();
    const milliBefore = runMilli;
    const durations: number[] = [];
    let hardStop: V3StopReason | null = null;
    let targetHit = false;
    let calls = 0;
    for (;;) {
      await sync();
      const next = features.find((f) => !states.has(f.id));
      if (!next) break;
      const total = features.length;
      const k = states.size + 1;
      if (reuseScenario(next)) continue;
      const key = `scenario:${next.id}`;
      const fp = scenarioFp(next);
      // Time: this scenario and the stages after it must fit the cap.
      const avg = durations.length
        ? durations.reduce((s, x) => s + x, 0) / durations.length
        : V3_STAGE_ETA_SEC.scenarios * 1000;
      const tail = V3_STAGES.slice(V3_STAGES.indexOf("critic")).reduce((s, st) => s + etaSec(st), 0) * 1000;
      if (now() - t0 + avg + tail > limits.timeMs) {
        hardStop = "time";
        break;
      }
      // Budget: «must» up to the cap, «should» within the target; a scenario gets up to twice its fair share.
      const left = poolLeft(next.priority, "scenarios");
      if (left < budgets.scenarioMin) {
        if (next.priority === "must") {
          hardStop = "budget";
          break;
        }
        states.set(next.id, stopped(next, "target"));
        targetHit = true;
        scenariosLeft -= 1;
        continue;
      }
      const sameLeft = features.filter((f) => f.priority === next.priority && !states.has(f.id)).length;
      const allowance = Math.min(left, Math.max((2 * left) / Math.max(1, sameLeft), budgets.scenarioMin));
      const wallet = new V3Wallet(key, allowance, left, rpc);
      const started = now();
      await host.emit("step_started", {
        step: key,
        label_ru: `Сценарий ${k} из ${total}: ${next.title}`,
        attempt: 1,
      });
      let r: V3ComposeResult;
      try {
        r = await host.runStep(`v3:${key}`, () => host.composer.scenario(ctxFor(wallet), next.scenario));
      } catch (e) {
        runMilli += wallet.spentMilli;
        calls += wallet.calls;
        if (!(e instanceof V3BudgetError)) throw e;
        await host.emit("step_finished", { step: key, durationMs: Math.max(0, now() - started) });
        if (e.scope === "pool" && next.priority === "must") {
          hardStop = "budget";
          break;
        }
        states.set(next.id, stopped(next, e.scope === "pool" ? "target" : "budget"));
        if (e.scope === "pool") targetHit = true;
        scenariosLeft -= 1;
        await save({
          key,
          fingerprint: fp,
          data: { status: "stopped", reason: "budget" },
          costMilli: wallet.spentMilli,
          durationMs: Math.max(0, now() - started),
        });
        continue;
      }
      const extra = Math.max(0, Math.round(((r.spentRub - wallet.spentRub) / rpc) * 1000));
      const costMilli = wallet.spentMilli + extra;
      runMilli += costMilli;
      calls += wallet.calls;
      // Tentatively on top of the system; the browser check decides whether it stays.
      scenarioLayers.set(next.id, r.files);
      revision = await commit(`Сценарий: ${next.title}`);
      const routes = r.pages.map((pg) => pg.route);
      const goals = goalScenariosFor(next.scenario, brief, backend.scenarios);
      const check = host.checkScenario
        ? await host.runStep(`v3:check:${next.id}`, () =>
            (host.checkScenario as NonNullable<V3Host["checkScenario"]>)({
              scenario: next.scenario,
              goalScenarios: goals,
              routes,
              revision,
            }),
          )
        : { ok: true, problems: [], browser: false };
      const durationMs = Math.max(0, now() - started);
      durations.push(durationMs);
      scenarioSec = Math.round(durations.reduce((s, x) => s + x, 0) / durations.length / 1000);
      scenariosLeft -= 1;
      const costRub = milliRub(costMilli, rpc);
      if (check.ok) {
        states.set(next.id, {
          id: next.id,
          title: next.title,
          priority: next.priority,
          status: "passed",
          costRub,
        });
        await save({
          key,
          fingerprint: fp,
          data: { status: "passed", files: toEntries(r.files), pages: r.pages, notes: r.notes },
          costMilli,
          durationMs,
        });
        await say(
          `v3s_${next.id}`,
          `Готово: ${next.title}.${host.checkScenario ? ` Проверил в браузере.` : ""} Сейчас ${spendLine(spentRub(), limits.capRub)}.`,
        );
      } else {
        scenarioLayers.delete(next.id);
        const reason = `не прошёл проверку в браузере: ${check.problems[0] ?? "сценарий не выполняется"}`;
        states.set(next.id, {
          id: next.id,
          title: next.title,
          priority: next.priority,
          status: "failed",
          reason,
          costRub,
        });
        await save({
          key,
          fingerprint: fp,
          data: { status: "failed", problems: check.problems.slice(0, 5) },
          costMilli,
          durationMs,
        });
        await say(
          `v3s_${next.id}`,
          `Не получилось: ${next.title} — ${reason}. Собираю систему дальше без него. Сейчас ${spendLine(spentRub(), limits.capRub)}.`,
        );
      }
      await host.emit("step_finished", { step: key, durationMs });
    }
    for (const f of features) if (!states.has(f.id)) states.set(f.id, stopped(f, hardStop ?? "time"));
    const all = [...states.values()];
    const reason: V3StopReason = hardStop ?? (targetHit ? "target" : "done");
    stop = { reason, message_ru: stopMessage(reason, all, spentRub(), limits) };
    const scenariosMilli = runMilli - milliBefore;
    metrics.scenarios = {
      status: "done",
      costRub: milliRub(scenariosMilli, rpc),
      durationMs: Math.max(0, now() - scenariosStarted),
      ...(calls ? { calls } : {}),
      note: `готово ${all.filter((s) => s.status === "passed").length} из ${all.length}; стоп: ${reason}`,
    };
    await save({
      key: "scenarios",
      fingerprint: sha256(all.map((s) => [s.id, s.status])),
      data: { stop, scenarios: all },
      costMilli: scenariosMilli,
      durationMs: metrics.scenarios.durationMs,
    });
    await stageEvent("scenarios", "done");

    // 6–8. Critic (V3-13), template gate (V3-14), techreview (V3-15): host hooks, skipped while absent.
    for (const st of V3_HOOK_STAGES) {
      await sync();
      const hook = hooks[st];
      const stateFp = sha256({ files: [...mergedFiles()].sort(([a], [b]) => a.localeCompare(b)), st });
      const budget = st === "template_gate" ? 0 : budgets[st];
      const h = await stage<Record<string, unknown>>(st, {
        fingerprint: stateFp,
        skip: !hook,
        budgetRub: budget,
        run: async (w) => {
          if (!hook) return { data: { status: "skipped" } };
          let out: V3HookResult;
          try {
            out = await hook(ctxFor(w));
          } catch (e) {
            // A hook keeps to its budget itself; a call past it ends the stage with what is done (never the build).
            if (!(e instanceof V3BudgetError)) throw e;
            return { data: { status: "skipped" }, fallback: true, note: "бюджет этапа исчерпан" };
          }
          return {
            data: {
              status: out.status,
              files: toEntries(out.files ?? new Map()),
              notes: out.notes ?? [],
              blockers: out.blockers ?? [],
              ...(out.redesign ? { redesign: out.redesign } : {}),
            },
            ...(out.note ? { note: out.note } : {}),
            extraMilli: Math.round(((out.spentRub ?? 0) / rpc) * 1000),
          };
        },
      });
      if (h.data.status !== "done") continue;
      const layer = toMap(h.data.files);
      if (layer.size) hookLayers.set(st, layer);
      notes = [...notes, ...((h.data.notes as string[]) ?? [])];
      const redesign = h.data.redesign as { avoid?: string[] } | undefined;
      if (st === "template_gate" && redesign?.avoid?.length) {
        // Too close to past sites of the niche: the art director picks again without those archetypes (no model).
        const again = await runArtDirector({
          input: {
            niche: design.niche,
            goals: brief.goals.map((g) => g.text),
            seed,
            recent: [...redesign.avoid, design.archetype],
          },
        });
        design = again.design;
        await buildBackend();
        notes = [...notes, `Сменил стиль на «${again.choice.styleName}», чтобы сайт не был похож на шаблон.`];
      }
      const blockers = (h.data.blockers as string[]) ?? [];
      if (blockers.length)
        throw new V3Failure(
          "GATES_FAILED",
          `${st === "techreview" ? "Техревью нашло" : `Проверка «${V3_STAGE_LABELS[st]}» нашла`} ошибку, с которой систему нельзя публиковать: ${blockers[0]}. Готовые этапы сохранены — повторная сборка начнётся с проверки.`,
          true,
        );
    }

    // 9. Gates G0 → G1 (goal scenarios of the done brief scenarios, in a browser when the host has one) → G2.
    await sync();
    revision = await commit("Система собрана по брифу");
    const done = [...states.values()].filter((s) => s.status === "passed");
    const goalScenarios = dedupe(
      done.flatMap((s) => {
        const f = features.find((x) => x.id === s.id);
        return f ? goalScenariosFor(f.scenario, brief, backend.scenarios) : [];
      }),
    );
    let ownerInput = false;
    const gates = await stage("gates", {
      fingerprint: sha256({ revision, state: committed?.hash ?? "" }),
      run: async () => {
        const reports: GateReport[] = [];
        for (const level of ["G0", "G1", "G2"] as const) {
          const r = await host.runGates(
            level,
            level === "G1" && host.goalBrowser && goalScenarios.length ? { goalScenarios } : undefined,
          );
          reports.push(r);
          const blockers = r.passed ? [] : buildBlockers(r);
          if (!r.passed && blockers.length === 0) ownerInput = true;
          if (blockers.length > 0)
            throw new V3Failure(
              "GATES_FAILED",
              `Система собрана, но автоматическая проверка нашла ошибку: ${blockers[0]?.message_ru ?? "проверка не пройдена"}. Готовые этапы сохранены — повторная сборка начнётся с проверки и не потратит их заново.`,
              true,
              reports,
            );
        }
        return { data: { revision, levels: ["G0", "G1", "G2"], ownerInput } };
      },
    });
    if (gates.data.ownerInput === true) notes = [...notes, OWNER_INPUT_NOTE_RU];

    // What is left goes to «Запросы на развитие»; the substitute is the system without it.
    for (const s of states.values())
      if (s.status !== "passed")
        await request(
          `scenario:${s.id}:${sha256(features.find((f) => f.id === s.id)?.scenario ?? s.id).slice(0, 16)}`,
          `Сценарий брифа: ${s.title}`,
          s.status === "failed"
            ? "Пока система работает без этого сценария — его можно доделать правкой."
            : "Не успели в этой сборке — можно доделать правкой или следующей сборкой.",
        );
  } catch (e) {
    const costRub = milliRub(runMilli, rpc);
    if (e instanceof V3Failure) {
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
    // Models unavailable, cancellation, infrastructure: the run fails as usual; checkpoints of done steps stay.
    await emitMetrics("failed").catch(() => {});
    throw e;
  }

  const scenarios = [...states.values()];
  const passed = scenarios.filter((s) => s.status === "passed").length;
  const durationMs = Math.max(0, now() - t0);
  const costRub = milliRub(runMilli, rpc);
  await emitMetrics("succeeded");
  const summary_ru = [
    scenarios.length
      ? `Система собрана по брифу: готово ${passed} из ${scenarios.length} сценариев.`
      : "Система собрана по брифу: каркас всех страниц готов.",
    stop.message_ru,
    ...notes,
  ]
    .filter(Boolean)
    .join(" ");
  if (host.notifyReady)
    await host.runStep("v3:notify", () =>
      (host.notifyReady as NonNullable<V3Host["notifyReady"]>)({
        summary_ru,
        revision,
        scenariosDone: passed,
        scenariosTotal: scenarios.length,
        costRub,
        durationMs,
      }),
    );
  return {
    status: "succeeded",
    revision,
    summary_ru,
    costRub,
    durationMs,
    previewMs,
    stop,
    scenarios,
    stages: metrics,
  };

  async function emitMetrics(status: "succeeded" | "failed") {
    const all = [...states.values()];
    await host.emit("build_metrics", {
      stages: {
        pipeline: "v3",
        briefVersion: bv?.version ?? null,
        status,
        ...metrics,
        scenarios_summary: {
          total: all.length,
          passed: all.filter((s) => s.status === "passed").length,
          failed: all.filter((s) => s.status === "failed").length,
          stopped: all.filter((s) => s.status === "stopped").length,
        },
        stop: stop.reason,
        previewMs,
        spentRub: spentRub(),
      },
      creditsUsed: runMilli / 1000,
      durationMs: Math.max(0, now() - t0),
    });
  }
}

/** Russian reasons of a stopped scenario. */
const STOP_REASON_RU: Readonly<Record<Exclude<V3StopReason, "done">, string>> = {
  time: "не успели: вышло время сборки",
  budget: "не хватило бюджета сборки",
  target: "желательный сценарий — отложен, чтобы уложиться в целевой бюджет",
};

function stopped(f: V3Feature, reason: Exclude<V3StopReason, "done">): V3ScenarioState {
  return {
    id: f.id,
    title: f.title,
    priority: f.priority,
    status: "stopped",
    reason: STOP_REASON_RU[reason],
    costRub: 0,
  };
}

/** The owner's line about why the scenarios stopped (D77 (10): every stop has a reason). */
export function stopMessage(
  reason: V3StopReason,
  scenarios: readonly V3ScenarioState[],
  spentRub: number,
  limits: V3Limits,
): string {
  const total = scenarios.length;
  const passed = scenarios.filter((s) => s.status === "passed").length;
  const rest = "остальное записали в «Запросы на развитие» — его можно доделать правками";
  switch (reason) {
    case "time":
      return `Доводку сценариев остановил: вышло время сборки (${minutesText(limits.timeMs)}). Готово ${passed} из ${total}; ${rest}.`;
    case "budget":
      return `Доводку сценариев остановил: следующий шаг вышел бы за потолок сборки ${rubLabel(limits.capRub)} (${spendLine(spentRub, limits.capRub)}). Готово ${passed} из ${total}; ${rest}.`;
    case "target": {
      const must = scenarios.filter((s) => s.priority === "must");
      return `Желательные сценарии не доводил, чтобы уложиться в целевые ${rubLabel(limits.targetRub)} на сборку (${spendLine(spentRub, limits.capRub)}). Обязательные готовы: ${must.filter((s) => s.status === "passed").length} из ${must.length}; ${rest}.`;
    }
    default:
      if (total === 0) return "В брифе нет сценариев — собрал каркас страниц.";
      return passed === total
        ? `Все сценарии брифа готовы и проверены (${total} из ${total}).`
        : `Готово ${passed} из ${total} сценариев; остальные не прошли проверку — система собрана без них, мы записали их в «Запросы на развитие».`;
  }
}

/** Features after a brief edit: the done ones keep their place, new scenarios join in priority order. */
function mergeFeatures(prev: readonly V3Feature[], next: readonly V3Feature[]): V3Feature[] {
  const byId = new Map(next.map((f) => [f.id, f]));
  const kept = prev.filter((f) => byId.has(f.id)).map((f) => byId.get(f.id) as V3Feature);
  const added = next.filter((f) => !prev.some((x) => x.id === f.id));
  return [
    ...kept.filter((f) => f.priority === "must"),
    ...added.filter((f) => f.priority === "must"),
    ...kept.filter((f) => f.priority === "should"),
    ...added.filter((f) => f.priority === "should"),
  ];
}

function dedupe(list: readonly GoalScenarioInput[]): GoalScenarioInput[] {
  return [...new Map(list.map((s) => [s.id, s] as const)).values()];
}
