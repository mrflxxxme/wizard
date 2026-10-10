// Real run executors (M0-26): orchestrator for interview turns, runBuild with a QA agent routed through host.route,
// gates G0/G1/G2 (@wizard/gates; G1 and G2 on an in-process runtime in test mode) and the post-G0 draft steps.

import { dirname, join } from "node:path";
import type { CapabilityGap } from "@wizard/agents";
import {
  type BuildCard,
  type PhotoHost,
  runBuild,
  runBuildV2,
  specDigest,
  type V2Host,
} from "@wizard/agents/builder";
import { AgentError } from "@wizard/agents/core";
import { createHostQa, hostRouteFn } from "@wizard/agents/host";
import { isInterviewV3Session } from "@wizard/agents/interview-v3";
import {
  createOrchestrator,
  newSession,
  type OrchOutput,
  type OrchSession,
  type TurnResult,
} from "@wizard/agents/orchestrator";
import {
  createGoalInterview,
  type GoalOutput,
  type GoalTurnResult,
  isGoalSession,
  type ModuleRegistry,
  newGoalSession,
} from "@wizard/agents/planner";
import { type RuntimeHandle, runGates } from "@wizard/gates";
import { createLogger } from "@wizard/pii/log";
import {
  closeExecutors,
  createFileStorage,
  createRuntimeApp,
  type FileStorage,
  MemoryFileStorage,
  MemoryRegistry,
  type RuntimeApp,
  readEnv,
  testModeSecrets,
} from "@wizard/runtime";
import type postgres from "postgres";
import { platformMailer } from "../auth/smtp-mailer.js";
import { phoneOtpAllowed } from "../billing/plans.js";
import {
  buildByBrief,
  draftSeedHints,
  isV3Build,
  kyselyOver,
  type V3BuildOptions,
} from "../builds-v3/host.js";
import { type Config, pipelineOrgsOn } from "../config.js";
import { recordInterviewFallback } from "../ops/metrics.js";
import type { EventType } from "../runs/events.js";
import {
  type BuildHost,
  type BuildParams,
  type InterviewHost,
  type InterviewOutput,
  RunCancelled,
  type RunExecutors,
  RunFailure,
} from "../runs/types.js";
import { orgPipeline } from "../services/plans.js";
import { isAutoName } from "../services/slug.js";
import { withConsentText } from "./consent.js";
import { g1PlatformConfig } from "./g1-platform.js";
import { type G1Sandbox, g1RuntimeLogLine, startG1Sandbox } from "./g1-sandbox.js";
import { chromiumProvider, type GoalBrowser, type GoalBrowserProvider } from "./goal-browser.js";
import { type InterviewV3Options, interviewV3Turn } from "./interview-v3.js";
import { createPhotoHost, stockModeOf } from "./stock.js";

/** Sandbox events of the G1 host (allowlisted fields only). */
const g1Logger = createLogger({ svc: "worker" });

import { bundleDraft, MIGRATOR_ROLE, migrateDraft, RUNTIME_ROLE, seedDraft } from "./draft.js";

export interface AgentExecutorsOptions {
  /** Platform connection: gates (shadow/ephemeral schemas), draft migrations (switching to migratorRole), registry. */
  pg: postgres.Sql;
  /** B2-20: module registry of the beta v2 path (default — @wizard/modules CATALOG). */
  modules?: ModuleRegistry;
  config: Config;
  migratorRole?: string;
  runtimeRole?: string;
  /** Runtime for G1 (default: created on first G1 — outbox connectors, test-mode secrets). */
  runtime?: RuntimeApp;
  /**
   * M2-19: sandbox of G1 (functions and page renders in workerd pods). Default: started on the first G1 from
   * WIZARD_SANDBOX=k8s (null without it — local unsafe-exec only); tests pass one or null.
   */
  g1Sandbox?: G1Sandbox | null;
  /**
   * B2-21/B2-28: Chromium for the goal scenarios of a plan build (gates.yaml#G1.browser.platform) — the provider owns it
   * (launch, slots, close). Default: chromiumProvider when config.g1Browser is "chromium" (closed with the executors);
   * null: G1 of a plan build runs without the browser checks (build_metrics goals.checked=false).
   */
  goalBrowser?: GoalBrowserProvider | null;
  /** B2-38: platform secrets (stock keys secret://platform/stock/*). */
  secrets?: { getPlatform(ref: string): string | null };
  /**
   * B2-38: stock photos of a plan build. Default: createPhotoHost by WIZARD_STOCK_MODE (fixture without the network unless
   * the models are live) over the shared file storage; null — no photos (landings keep the theme graphic).
   */
  photos?: PhotoHost | null;
  /** B2-38: the shared file storage of systems (photo library wz_photos/*); default — createFileStorage(process.env). */
  files?: FileStorage;
  /** V3-03: research of the v3 interview (default — web tools only with WIZARD_RESEARCH_MODE=live; null — none). */
  research?: InterviewV3Options["research"];
  /**
   * V3-11: builds by the system brief on the harness v3 (builds-v3/host.ts) — on with WIZARD_BUILD_PIPELINE=v3 or
   * v3.enabled; the page composer of V3-12 and the hooks of V3-13…15 come here; null — off.
   */
  v3?: V3BuildOptions | null;
}

export type { GoalBrowser, GoalBrowserProvider };

/**
 * B2-21: a build of the modules pipeline — the approved system plan in stages (builder v2, agents/builder.yaml#v2):
 * texts and design by models, compilation without models, custom code within the limits (B2-23; a part that fails is
 * rolled back and goes to «Запросы на развитие»), gates G0–G2; checkpoints with the plan revision, so «Исправить» continues from the last stage done.
 */
export async function buildByPlan(
  host: BuildHost,
  params: BuildParams & { plan: NonNullable<BuildParams["plan"]> },
  o: {
    registry?: ModuleRegistry;
    browser?: GoalBrowserProvider | null;
    platformUrl?: string;
    photos?: PhotoHost | null;
  } = {},
): Promise<{ status: "succeeded"; summary_ru: string }> {
  if (!host.checkpoints) throw new RunFailure("INTERNAL", "Нет хранилища этапов сборки", true);
  const current = await host.store.getSpec();
  const provider = o.browser ?? null;
  // The browser starts here (once per process): a build knows before its stages whether G1 checks the goal scenarios.
  const withBrowser = provider ? await provider.available() : false;
  const v2: V2Host = {
    route: host.route,
    runStep: host.runStep,
    emit: (type, payload) => host.emit(type as EventType, payload),
    signal: host.signal,
    run: { id: host.run.id },
    checkpoints: host.checkpoints,
    currentSpec: () => host.store.getSpec(),
    commitCompiled: (input) => host.store.commitCompiled(input),
    runGates: async (level, overrides) => {
      if (!overrides?.goalScenarios || !provider || !withBrowser) return host.runGates(level, undefined);
      // A slot of the process browser for this G1 only; without one (crash, wait ran out) G1 reports the browser
      // checks as errors and the build fails retryably.
      const lease = await provider.acquire(host.signal);
      try {
        return await host.runGates(level, {
          goalScenarios: overrides.goalScenarios,
          ...(lease ? { browser: lease.browser } : {}),
        });
      } finally {
        lease?.release();
      }
    },
    goalBrowser: withBrowser,
    recordDevelopmentRequest: (input) => host.recordDevelopmentRequest(input),
    ...(o.photos ? { photos: o.photos } : {}),
  };
  const out = await runBuildV2(v2, {
    plan: params.plan.plan,
    planRevision: params.plan.revision,
    ...(o.registry ? { registry: o.registry } : {}),
    // B2-44: the draft's name stays unless it is still the one derived from the brief — then the plan names it.
    ...(isAutoName(current.spec.app.name, params.brief) ? {} : { appName: current.spec.app.name }),
    ...(o.platformUrl ? { platformUrl: o.platformUrl, systemId: host.run.systemId } : {}),
  });
  if (out.status === "succeeded") return { status: "succeeded", summary_ru: out.summary_ru };
  throw new RunFailure(out.code, out.message_ru, out.retryable);
}

const ASKING_HINT = "Ответьте на вопросы выше или нажмите «Остальное — по рекомендациям».";

function lastUserText(host: InterviewHost): string {
  const m = [...host.context.messages].reverse().find((x) => x.role === "user" && x.kind === "text");
  return m?.text ?? "";
}

/** B2-44: the brief of the system — its first user text message (createSystem). */
function briefOf(host: InterviewHost): string | null {
  return host.context.messages.find((x) => x.role === "user" && x.kind === "text")?.text ?? null;
}

/**
 * B2-29 («ткни и скажи»): the last wish with the canvas block it is about (messages.payload.block) — the planner sees
 * which section or module screen the client means. Without a block — the text as is.
 */
export function lastUserWish(host: InterviewHost): string {
  const m = [...host.context.messages].reverse().find((x) => x.role === "user" && x.kind === "text");
  const text = m?.text ?? "";
  const b = m?.payload?.block as { title?: unknown; module?: unknown; sectionIndex?: unknown } | undefined;
  if (!b || typeof b.title !== "string") return text;
  const where = [
    typeof b.sectionIndex === "number" ? `секция страницы №${b.sectionIndex + 1}` : null,
    typeof b.module === "string" ? `модуль ${b.module}` : null,
  ].filter(Boolean);
  return `Пожелание к блоку «${b.title}»${where.length ? ` (${where.join(", ")})` : ""}: ${text}`;
}

/** OrchOutput[] of one turn → the single InterviewOutput platform-api persists (+ notice). */
function toOutput(res: TurnResult): InterviewOutput {
  let main: InterviewOutput | undefined;
  let notice: { categories: string[] } | undefined;
  const gaps: CapabilityGap[] = [];
  for (const o of res.outputs as OrchOutput[]) {
    const g = (o.payload as { gaps?: CapabilityGap[] } | undefined)?.gaps;
    if (g?.length) gaps.push(...g);
    if (o.kind === "notice") notice = { categories: o.payload.categories };
    else if (o.kind === "questions")
      main = {
        kind: "questions",
        text: o.text,
        questions: o.questions as unknown as Record<string, unknown>[],
        ...(o.payload.analysis ? { analysis: o.payload.analysis as unknown as Record<string, unknown> } : {}),
      };
    else if (o.kind === "card")
      main = { kind: "card", text: o.text, card: o.card as unknown as Record<string, unknown> };
    else main = { kind: "answer", text: o.text };
  }
  return {
    ...(main ?? { kind: "answer", text: "Готово." }),
    ...(notice ? { notice } : {}),
    ...(gaps.length > 0 ? { gaps } : {}),
    state: res.session as unknown as Record<string, unknown>,
  };
}

/** Plan as the orchestrator sees it: pilot → free (phone_otp is blocked like on Free). */
export const agentPlan = (plan: string): "free" | "start" | "business" =>
  plan === "start" || plan === "business" ? plan : "free";

async function turn(host: InterviewHost): Promise<TurnResult> {
  const c = host.context;
  const orch = createOrchestrator({
    route: hostRouteFn(host.route, { step: "orchestrate" }),
    orgPolicy: c.org.policy,
    ctx: { orgId: c.org.id, runId: host.run.id, systemId: c.system.id },
    // The orchestrator knows free/start/business; pilot has the free login methods (no phone_otp, billing.yaml#plans.pilot).
    org: { plan: agentPlan(c.org.plan), ruOnly: c.org.policy.ruOnly },
    runStep: host.runStep,
    // Only the internal orch_invalid (why the answer did not parse, for diagnose): chat_output and run_failed are the
    // platform's own events of this run (persist_output, the run's failure).
    emit: async (type, payload) => {
      if (type === "orch_invalid") await host.emit("orch_invalid", payload);
    },
    // D73: honest capability gaps → «Запросы на развитие» (org, system and run of this host).
    recordDevelopmentRequest: (input) => host.recordDevelopmentRequest(input),
  });
  let session = (c.state as OrchSession | null) ?? newSession();
  if (c.trigger === "create") return orch.submitBrief(newSession(), lastUserText(host));
  if (c.trigger === "answers") {
    const answers = (c.answers ?? []) as {
      questionId: string;
      optionId?: string;
      text?: string;
      byRecommendation?: boolean;
    }[];
    let res: TurnResult = { session, outputs: [] };
    const outputs: OrchOutput[] = [];
    for (const a of answers.filter((x) => !x.byRecommendation)) {
      res = await orch.answer(res.session, {
        questionId: a.questionId,
        ...(a.optionId !== undefined ? { optionId: a.optionId } : {}),
        ...(a.text !== undefined ? { text: a.text } : {}),
      });
      outputs.push(...res.outputs);
      if (res.failure) return { ...res, outputs };
    }
    if (answers.some((x) => x.byRecommendation) && res.session.state === "asking") {
      res = await orch.restByRecommendation(res.session);
      outputs.push(...res.outputs);
    }
    return { ...res, outputs };
  }
  const text = lastUserText(host);
  if (c.system.previewRevision !== null && c.system.stage !== "card") {
    // The system is built: platform stages are the source of truth for the build lifecycle.
    if (session.state !== "done") session = { ...session, state: "done" };
    return orch.requestChange(session, text, {
      specDigest: specDigest(c.spec),
      roles: c.spec.roles.map((r) => r.name),
      entities: c.spec.entities.map((e) => e.name),
    });
  }
  if (session.state === "awaiting_approval") return orch.editCard(session, text);
  if (session.state === "asking")
    return { session, outputs: [{ id: "hint", role: "assistant", kind: "text", text: ASKING_HINT }] };
  return orch.submitBrief(newSession(), text);
}

/** GoalOutput[] of one beta v2 turn → the InterviewOutput platform-api persists (+ notice, gaps, state). */
function goalOutput(res: GoalTurnResult): InterviewOutput {
  let main: InterviewOutput | undefined;
  let notice: { categories: string[] } | undefined;
  const gaps: CapabilityGap[] = [];
  for (const o of res.outputs as GoalOutput[]) {
    if (o.kind === "notice") {
      notice = { categories: o.payload.categories };
      continue;
    }
    if (o.gaps?.length) gaps.push(...o.gaps);
    if (o.kind === "questions")
      main = {
        kind: "questions",
        text: o.text,
        questions: o.questions as unknown as Record<string, unknown>[],
        sketch: o.sketch as unknown as Record<string, unknown>,
      };
    else if (o.kind === "plan")
      main = {
        kind: "plan",
        text: o.text,
        plan: o.plan as unknown as Record<string, unknown>,
        errors: o.errors as unknown as Record<string, unknown>[],
        sketch: o.sketch as unknown as Record<string, unknown>,
        fingerprint: o.sketch.fingerprint,
      };
    else main = { kind: "answer", text: o.text };
  }
  return {
    ...(main ?? { kind: "answer", text: "Готово." }),
    ...(notice ? { notice } : {}),
    ...(gaps.length > 0 ? { gaps } : {}),
    state: res.session as unknown as Record<string, unknown>,
  };
}

export interface PlanInterviewOptions {
  /** Module registry (default — @wizard/modules CATALOG). */
  registry?: ModuleRegistry;
}

/**
 * B2-20: an interview turn of the beta v2 path (WIZARD_BUILD_PIPELINE=modules) — goal interview with button questions,
 * the planner and a plan awaiting approval; a message after the plan re-plans with the client's wish.
 */
export async function planInterviewTurn(
  host: InterviewHost,
  o: PlanInterviewOptions = {},
): Promise<InterviewOutput> {
  const c = host.context;
  const gi = createGoalInterview({
    route: hostRouteFn(host.route, { step: "orchestrate" }),
    orgPolicy: c.org.policy,
    ctx: { orgId: c.org.id, runId: host.run.id, systemId: c.system.id },
    ...(o.registry ? { registry: o.registry } : {}),
    // B2-44: a system still named after its brief compiles with the plan's short name (planSiteName).
    ...(isAutoName(c.system.name, briefOf(host)) ? {} : { appName: c.system.name }),
    runStep: host.runStep,
    // B2-41: what did not pass and what replaced it — the internal event for the diagnosis and the metric.
    emit: async (type, payload) => {
      if (type !== "orch_invalid") return;
      recordInterviewFallback(payload as { step?: unknown; fallback?: unknown });
      await host.emit("orch_invalid", payload);
    },
    recordDevelopmentRequest: (input) => host.recordDevelopmentRequest(input),
    phoneLogin: phoneOtpAllowed(c.org.plan),
  });
  const session = isGoalSession(c.state) ? c.state : newGoalSession();
  let res: GoalTurnResult;
  try {
    if (c.trigger === "create") res = await gi.submitBrief(newGoalSession(), lastUserText(host));
    else if (c.trigger === "answers") {
      const answers = (c.answers ?? []) as {
        questionId: string;
        optionId?: string;
        text?: string;
        byRecommendation?: boolean;
      }[];
      res = await gi.answer(
        session,
        answers
          .filter((a) => !a.byRecommendation)
          .map((a) => ({
            questionId: a.questionId,
            ...(a.optionId !== undefined ? { optionId: a.optionId } : {}),
            ...(a.text !== undefined ? { text: a.text } : {}),
          })),
        { restByRecommendation: answers.some((a) => a.byRecommendation) },
      );
    } else if (session.state === "planned") res = await gi.revise(session, lastUserWish(host));
    else if (session.state === "asking")
      return { kind: "answer", text: ASKING_HINT, state: session as unknown as Record<string, unknown> };
    else res = await gi.submitBrief(newGoalSession(), lastUserText(host));
  } catch (e) {
    if (e instanceof AgentError) return { kind: "answer", text: e.message };
    throw e;
  }
  if (res.failure) throw new RunFailure(res.failure.code, res.failure.message_ru, res.failure.retryable);
  return goalOutput(res);
}

/** Loads a system into the G1 runtime and remembers it, so the pinned G1 system is unloaded after the gate. */
function trackingHandle(
  rt: RuntimeApp,
  loaded: { slug: string; env: "draft" | "prod"; systemKey: string }[],
  sandbox: G1Sandbox | null,
): RuntimeHandle {
  return {
    fetch: (req) => rt.fetch(req),
    loadSystem: async (input) => {
      loaded.push({ slug: input.slug ?? input.systemKey, env: input.env, systemKey: input.systemKey });
      return rt.loadSystem(input);
    },
    outbox: () => rt.outbox(),
    runJobs: (input) => rt.runJobs(input),
    warmFunctions: (input) => rt.warmFunctions(input),
    ...(sandbox ? { renderer: (input: { key: string; code: string }) => sandbox.renderer(input) } : {}),
    env: rt.env,
  };
}

export function createAgentExecutors(o: AgentExecutorsOptions): RunExecutors & { close(): Promise<void> } {
  const runtimeRole = o.runtimeRole ?? RUNTIME_ROLE;
  const migratorRole = o.migratorRole ?? MIGRATOR_ROLE;
  let rt: RuntimeApp | undefined = o.runtime;
  let ownRuntime = false;
  // B2-38: the shared file storage (photo library) and the stock photos of plan builds, made on first use.
  let files: FileStorage | undefined = o.files;
  const sharedFiles = (): FileStorage => {
    files ??= createFileStorage(process.env, { defaultDir: join(dirname(o.config.artifactsDir), "files") });
    return files;
  };
  let photos: PhotoHost | null | undefined = o.photos;
  const photoHost = (): PhotoHost | null => {
    photos ??=
      createPhotoHost({
        mode: stockModeOf(process.env),
        secrets: o.secrets ?? null,
        storage: sharedFiles(),
      }) ?? null;
    return photos;
  };
  // B2-28: one Chromium per process for the goal scenarios of plan builds, started on the first such G1.
  let browserProvider: GoalBrowserProvider | null | undefined = o.goalBrowser;
  const ownBrowser = o.goalBrowser === undefined;
  const goalBrowser = (): GoalBrowserProvider | null => {
    if (browserProvider === undefined)
      browserProvider =
        o.config.g1Browser === "chromium"
          ? chromiumProvider({
              slots: o.config.g1BrowserSlots,
              log: (msg, fields) => g1Logger.line({ svc: "worker", msg: `g1_${msg}`, ...fields }),
            })
          : null;
    return browserProvider;
  };
  // V3-11: builds by the brief (harness v3) when the pipeline is on; its db handle is made on first use.
  // The same switch as the v3 interview (V3-03): config.buildPipeline (WIZARD_BUILD_PIPELINE=v3), or V3-18 orgs of
  // WIZARD_BUILD_PIPELINE_ORGS (isV3Build still asks for a brief: card and plan builds keep their pipelines).
  const v3 =
    o.v3 === null
      ? null
      : { ...o.v3, enabled: o.v3?.enabled ?? (o.config.buildPipeline === "v3" || pipelineOrgsOn(o.config)) };
  let v3Db: ReturnType<typeof kyselyOver> | undefined;
  const db = () => {
    v3Db ??= kyselyOver(o.pg);
    return v3Db;
  };
  let sandbox: Promise<G1Sandbox | null> | undefined;
  const g1Sandbox = (): Promise<G1Sandbox | null> => {
    sandbox ??=
      o.g1Sandbox !== undefined
        ? Promise.resolve(o.g1Sandbox)
        : startG1Sandbox(process.env, { log: (line) => g1Logger.line({ svc: "worker", ...line }) });
    return sandbox;
  };
  const g1Runtime = (sb: G1Sandbox | null): RuntimeApp => {
    if (!rt) {
      rt = createRuntimeApp({
        ...(sb ? { sandbox: sb.orchestrator, rpc: sb.rpc } : {}),
        // Platform failures of the G1 runtime (functions_load_failed, job_failed, …) reach the worker log in a fixed
        // shape; log lines and texts of the systems under test never do (g1RuntimeLogLine).
        log: (line) => {
          const out = g1RuntimeLogLine(line);
          if (out) g1Logger.line({ ...out, svc: "worker" });
        },
        db: o.pg,
        registry: new MemoryRegistry(),
        dbRole: runtimeRole,
        connectors: "outbox",
        secrets: testModeSecrets(),
        // B2-28: drafts' mail stays in the outbox; the sender domain must be an address (not noreply@localhost).
        platform: g1PlatformConfig(process.env),
        artifactsRoot: o.config.artifactsDir,
        // G1 systems are ephemeral: their uploads (probes of required file fields) never reach the shared storage.
        files: new MemoryFileStorage(),
        // …but their landings show the stock photos the builder copied into the shared photo library (B2-38).
        photoLibrary: sharedFiles(),
        env: {
          ...readEnv(),
          authModeDev: true,
          devLogin: false,
          unsafeLocalExec: o.config.unsafeLocalExec,
          publicScheme: "http",
          platformOrigin: o.config.platformOrigin,
          systemsDomain: "localhost",
        },
      });
      ownRuntime = true;
    }
    return rt;
  };

  return {
    async interviewTurn(host) {
      // B2-20: a system stays on the pipeline it started with; a new one follows WIZARD_BUILD_PIPELINE.
      const state = host.context.state;
      // V3-18: …or v3 when its org is in WIZARD_BUILD_PIPELINE_ORGS (by id or kind).
      const fresh = state === null ? await orgPipeline(db(), o.config, host.run.orgId) : null;
      // V3-03: the grill interview of v3 and the system brief (WIZARD_BUILD_PIPELINE=v3).
      if (isInterviewV3Session(state) || fresh === "v3")
        return interviewV3Turn(host, {
          ...(o.modules ? { registry: o.modules } : {}),
          ...(o.research !== undefined ? { research: o.research } : {}),
        });
      if (isGoalSession(state) || fresh === "modules")
        return planInterviewTurn(host, o.modules ? { registry: o.modules } : {});
      let res: TurnResult;
      try {
        res = await turn(host);
      } catch (e) {
        if (e instanceof AgentError) return { kind: "answer", text: e.message };
        throw e;
      }
      if (res.failure) throw new RunFailure(res.failure.code, res.failure.message_ru, res.failure.retryable);
      return toOutput(res);
    },

    async build(host, params) {
      // B2-21: a build by an approved system plan (approveSystemPlan, or «Исправить» of such a system) — builder v2.
      if (params.plan) {
        const browser = goalBrowser();
        return buildByPlan(
          host,
          { ...params, plan: params.plan },
          {
            ...(o.modules ? { registry: o.modules } : {}),
            browser,
            platformUrl: o.config.platformOrigin,
            photos: photoHost(),
          },
        );
      }
      // V3-11: a system with a brief and without a card or plan, WIZARD_BUILD_PIPELINE=v3 — the harness v3.
      if (v3?.enabled) {
        if (await isV3Build(db(), host.run.systemId, params, true))
          return buildByBrief(host, {
            pg: o.pg,
            db: db(),
            ...(v3.composer ? { composer: v3.composer } : {}),
            ...(v3.hooks ? { hooks: v3.hooks } : {}),
            mailer: v3.mailer ?? platformMailer(o.config),
            platformOrigin: o.config.platformOrigin,
            browser: goalBrowser(),
            ...(o.modules ? { registry: o.modules } : {}),
            log: (msg, err) => g1Logger.error(msg.replace(/\s+/g, "_"), err),
            // V3-18: the stock photos of the site, as plan builds get them (WIZARD_STOCK_MODE; library on the pilot).
            photos: photoHost(),
            // V3-40: the critic's browser shows the library's real photos from the shared storage.
            files: sharedFiles(),
          });
      }
      const qa = createHostQa(host, { milestone: o.config.milestone });
      const out = await runBuild(
        { ...host, qa },
        {
          card: params.card as unknown as BuildCard,
          cap: params.cap,
          mode: params.mode,
          ...(params.target ? { target: params.target } : {}),
        },
      );
      if (out.status === "succeeded") return { status: "succeeded", summary_ru: out.summary_ru };
      if (out.status === "cancelled") {
        if (out.reason === "aborted") throw new RunCancelled();
        return { status: "cancelled", summary_ru: out.summary_ru };
      }
      throw new RunFailure(out.code, out.message_ru, out.retryable);
    },

    async gates(level, ctx) {
      if (level === "G0") return runGates(level, ctx);
      // G1 and G2 (permission matrix G2-PERM-01…04) run against the same in-process runtime and runtime role.
      const sb = await g1Sandbox();
      const runtime = g1Runtime(sb);
      const loaded: { slug: string; env: "draft" | "prod"; systemKey: string }[] = [];
      try {
        return await runGates(level, {
          ...ctx,
          // compliance.consentText from the template (owner-only field, filled by the platform, never stored).
          spec: withConsentText(ctx.spec),
          runtime: trackingHandle(runtime, loaded, sb),
          runtimeRole,
        });
      } finally {
        for (const l of loaded) runtime.unloadSystem(l);
        // The outbox of the long-lived G1 runtime keeps only what other gates still read.
        runtime.dropOutbox(loaded.map((l) => l.systemKey));
        // M2-19: the sandbox pods of this gate's systems go with them.
        await sb?.release(loaded.map((l) => l.systemKey)).catch(() => {});
      }
    },

    async onG0Passed(a) {
      const { created } = await migrateDraft(o.pg, {
        systemKey: a.systemKey,
        spec: a.spec,
        prevSpec: a.prevSpec,
        migratorRole,
        runtimeRole,
      });
      if (created) {
        // V3-18: a system with a brief seeds its preview with the names of the offer the brief lists.
        const hints = await draftSeedHints(db(), a.systemId, a.spec);
        await seedDraft(o.pg, { systemKey: a.systemKey, spec: a.spec, migratorRole, hints });
      }
      // platform.deployments.spec_hash of this revision: the runtime compares it with manifest.specHash.
      const [row] = await o.pg<{ h: string }[]>`
        select encode(sha256(convert_to(spec::text, 'UTF8')), 'hex') as h
        from platform.revisions where system_id = ${a.systemId} and version = ${a.revision}`;
      if (!row) throw new RunFailure("INTERNAL", "Ревизия не найдена", true);
      const { bundleKey } = await bundleDraft({
        artifactsDir: o.config.artifactsDir,
        systemKey: a.systemKey,
        revision: a.revision,
        spec: withConsentText(a.spec),
        files: a.files,
        platformOrigin: o.config.platformOrigin,
        specHash: row.h,
      });
      return { bundleKey };
    },

    async close() {
      if (ownBrowser) await browserProvider?.close();
      if (ownRuntime) await closeExecutors();
      if (sandbox && o.g1Sandbox === undefined) await (await sandbox)?.close();
    },
  };
}
