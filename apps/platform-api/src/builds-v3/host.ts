// A build by the system brief on the harness v3 (V3-11; specs/agents/builder-v3.md §3 C6, product.yaml D77_v3 (10)):
// the V3Host over the run's durable BuildHost — the latest brief (V3-02 getLatestBrief) before each stage, checkpoints
// in platform.system_build_checkpoints, draft revisions through commitCompiled, the live preview (G0 → bundle →
// preview revision), the browser check of a scenario (G0, then G1 with the scenario's goal scenarios in the process
// Chromium of B2-28), «Запросы на развитие», the ready notice by e-mail and the niche memory of the art director.
// platform-api runs it behind WIZARD_BUILD_PIPELINE=v3 (agents/executors.ts).
import {
  createPageComposer,
  erroredBlockers,
  failedBlockers,
  type PageComposer,
  type PhotoHost,
  runBuildV3,
  type ScenarioCheckInput,
  type ScenarioCheckResult,
  seedHintsFromBrief,
  V3_BUILD_LIMITS,
  type V3GateLevel,
  type V3Host,
  type V3ReadyNotice,
  type V3StageHook,
} from "@wizard/agents/builder";
import type { ModuleRegistry } from "@wizard/agents/planner";
import type { AppSpec } from "@wizard/appspec";
import type { GateReport, GoalScenarioInput, SeedHint } from "@wizard/gates";
import { createRegistry } from "@wizard/llm";
import type { FileStorage } from "@wizard/runtime";
import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import type postgres from "postgres";
import type { GoalBrowserProvider } from "../agents/goal-browser.js";
import type { Mailer } from "../auth/mailer.js";
import { getLatestBrief } from "../briefs/store.js";
import { buildPipelineOf } from "../config.js";
import type { DB, Db } from "../db/index.js";
import { integrationsBuildHook } from "../integrations-v3/service.js";
import { claimOpsAlert } from "../ops/alert.js";
import type { EventType } from "../runs/events.js";
import { type BuildHost, type BuildParams, RunFailure } from "../runs/types.js";
import { withKeyWindow } from "../secrets-v3/agent.js";
import { loadBrief } from "../services/plans.js";
import { type DurableRead, pgCheckpointStore, recentArchetypes } from "./checkpoints.js";
import { criticLibraryPhotos, platformCritic } from "./critic.js";
import { liveStats, withLiveProgress } from "./progress.js";
import { platformTechreview } from "./techreview.js";
import { templateGateHooks } from "./template-gate.js";

/** ₽ per credit of the platform (models.yaml#credits.rub_per_credit). */
const RUB_PER_CREDIT = createRegistry().rubPerCredit;

/** Credits cap of a v3 build run: the build cap of D77 (11) — 500 ₽. */
export const V3_BUILD_CAP_CREDITS = Math.ceil(V3_BUILD_LIMITS.capRub / RUB_PER_CREDIT);

/** WIZARD_BUILD_PIPELINE=v3 (V3-11): builds of systems with a brief and without a card or plan go to the harness v3. */
export const v3PipelineOn = (env: Record<string, string | undefined>): boolean =>
  buildPipelineOf(env.WIZARD_BUILD_PIPELINE) === "v3";

export interface V3BuildOptions {
  /** On without the env (tests); default WIZARD_BUILD_PIPELINE=v3. */
  enabled?: boolean;
  /** The page writer (default: the V3-12 composer on the ui-kit pattern library, createPageComposer()). */
  composer?: PageComposer;
  /** Stages of V3-13…15 (critic, template_gate, techreview); absent — skipped (techreview: platformTechreview). */
  hooks?: Partial<Record<"critic" | "template_gate" | "techreview", V3StageHook>>;
  /** The ready notice by e-mail (default: the platform mailer of the config). */
  mailer?: Mailer;
}

/** Kysely over the executors' connection (no pool of its own: never destroyed). */
export const kyselyOver = (pg: postgres.Sql): Db =>
  new Kysely<DB>({ dialect: new PostgresJSDialect({ postgres: pg }) });

/**
 * A build run is a v3 one: the pipeline is on, the run has no card and no plan (a card build is v1, a plan build v2 —
 * a system keeps the pipeline it started with), it is not a point edit and the system has a brief.
 */
export async function isV3Build(
  db: Db,
  systemId: string,
  params: Pick<BuildParams, "card" | "plan" | "mode">,
  enabled: boolean,
): Promise<boolean> {
  if (!enabled || params.plan || params.mode === "point_edit" || Object.keys(params.card).length > 0)
    return false;
  return (await getLatestBrief(db, systemId)) !== null;
}

/**
 * V3-18: seed hints of the draft of a system with a brief — the names of the offer its latest brief (else the owner's
 * first words) lists, for the preview's demo rows; [] without a brief or when reading it fails (the seed goes on).
 */
export async function draftSeedHints(db: Db, systemId: string, spec: AppSpec): Promise<SeedHint[]> {
  try {
    const brief = await getLatestBrief(db, systemId);
    if (!brief) return [];
    return seedHintsFromBrief(spec, brief.brief, await loadBrief(db, systemId));
  } catch {
    return [];
  }
}

/** G1 with the goal scenarios in a slot of the process browser (B2-28); without one — G1 without the browser checks. */
async function runGates(
  host: BuildHost,
  provider: GoalBrowserProvider | null,
  withBrowser: boolean,
  level: V3GateLevel,
  goalScenarios?: readonly GoalScenarioInput[],
) {
  if (!goalScenarios?.length || !provider || !withBrowser) return host.runGates(level, undefined);
  const lease = await provider.acquire(host.signal);
  try {
    return await host.runGates(level, { goalScenarios, ...(lease ? { browser: lease.browser } : {}) });
  } finally {
    lease?.release();
  }
}

/**
 * V3-15: G0 of the final gates on a revision this run has already passed G0 on (the last scenario's check, nothing
 * changed since — the techreview made no fix): a revision is immutable, its report, bundle and preview stand.
 */
async function passedG0(pg: postgres.Sql, runId: string, systemId: string): Promise<GateReport | null> {
  const [r] = await pg<{ report: GateReport }[]>`
    select g.report from platform.gate_reports g
      join platform.systems s on s.id = g.system_id and g.revision = s.draft_revision
     where g.run_id = ${runId} and g.system_id = ${systemId} and g.level = 'G0' and g.passed`;
  return r?.report ?? null;
}

/**
 * V3-18: a gate run once more when its blockers are only checks that could not run (status error: the browser, a
 * timeout, a process) — the infrastructure, not the system.
 */
export async function gateWithRetry(run: () => Promise<GateReport>): Promise<GateReport> {
  const r = await run();
  return failedBlockers(r).length === 0 && erroredBlockers(r).length > 0 ? run() : r;
}

/**
 * Browser check of one brief scenario on the committed draft: G0 (it also bundles the revision for the live preview),
 * then G1 with the scenario's goal scenarios in the browser (renders only without one). Failed blockers are the
 * problems; checks that could not run even after a retry make the check `unavailable` (V3-18: not the scenario's fault).
 */
export async function checkScenario(
  host: BuildHost,
  provider: GoalBrowserProvider | null,
  withBrowser: boolean,
  input: ScenarioCheckInput,
): Promise<ScenarioCheckResult> {
  const r0 = await gateWithRetry(() => host.runGates("G0"));
  const g0 = failedBlockers(r0);
  if (g0.length) return { ok: false, problems: g0.map((c) => c.message_ru), browser: false };
  const e0 = erroredBlockers(r0);
  if (e0.length)
    return { ok: false, problems: e0.map((c) => c.message_ru), browser: false, unavailable: true };
  const r1 = await gateWithRetry(() =>
    runGates(host, provider, withBrowser, "G1", withBrowser ? input.goalScenarios : undefined),
  );
  const g1 = failedBlockers(r1);
  if (g1.length) return { ok: false, problems: g1.map((c) => c.message_ru), browser: withBrowser };
  const e1 = erroredBlockers(r1);
  if (e1.length)
    return { ok: false, problems: e1.map((c) => c.message_ru), browser: withBrowser, unavailable: true };
  return { ok: true, problems: [], browser: withBrowser };
}

/** The ready notice (D77 (10)): one letter per run to the one who started the build, with the link to the system. */
export async function notifyReady(
  db: Db,
  mailer: Mailer,
  o: { runId: string; systemId: string; platformOrigin: string; notice: V3ReadyNotice },
  log?: (msg: string, err: unknown) => void,
): Promise<void> {
  try {
    if (!(await claimOpsAlert(db, `v3_ready:${o.runId}`))) return;
    const row = await db
      .selectFrom("platform.runs as r")
      .innerJoin("platform.users as u", "u.id", "r.started_by")
      .innerJoin("platform.systems as s", "s.id", "r.system_id")
      .select(["u.email", "s.name"])
      .where("r.id", "=", o.runId)
      .where("u.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) return;
    await mailer.send({
      kind: "notice",
      to: row.email,
      subject: `Система «${row.name}» собрана`,
      text: [
        o.notice.summary_ru,
        `Готово сценариев брифа: ${o.notice.scenariosDone} из ${o.notice.scenariosTotal}.`,
        `Посмотреть и поправить: ${o.platformOrigin}/s/${encodeURIComponent(o.systemId)}`,
      ].join("\n\n"),
    });
  } catch (e) {
    // The notice never fails a finished build.
    log?.("v3 ready notice failed", e);
  }
}

/** The ₽ this run may still spend by its credits cap (null — no cap). */
async function runCapRub(pg: postgres.Sql, runId: string): Promise<number | null> {
  const [r] = await pg<{ cap: string | null; used: string }[]>`
    select r.credits_cap_milli as cap, r.credits_used_milli as used from platform.runs r where r.id = ${runId}`;
  if (!r || r.cap === null) return null;
  return ((Number(r.cap) - Number(r.used)) / 1000) * RUB_PER_CREDIT;
}

/** Runs the harness v3 for a build run of a system with a brief (agents/executors.ts, WIZARD_BUILD_PIPELINE=v3). */
export async function buildByBrief(
  host: BuildHost,
  o: {
    pg: postgres.Sql;
    db: Db;
    composer?: PageComposer;
    hooks?: V3BuildOptions["hooks"];
    mailer: Mailer;
    platformOrigin: string;
    browser?: GoalBrowserProvider | null;
    registry?: ModuleRegistry;
    log?: (msg: string, err: unknown) => void;
    /** V3-18: the stock photos of the site (the photos host of plan builds); absent — no stock photos. */
    photos?: PhotoHost | null;
    /** V3-40: the shared file storage (the photo library wz_photos/*) — the critic's browser shows the real photos. */
    files?: FileStorage | null;
  },
): Promise<{ status: "succeeded"; summary_ru: string }> {
  // V3-12: the page composer on the pattern library (skeleton without a model; scenarios through host.route).
  const composer = o.composer ?? createPageComposer();
  const systemId = host.run.systemId;
  const provider = o.browser ?? null;
  // V3-18: reads that steer the stages are durable (BuildHost.once): a replay after a worker restart takes the same path.
  const once: DurableRead = host.once ? (name, fn) => (host.once as DurableRead)(name, fn) : (_n, fn) => fn();
  // The browser starts here (once per process): the build knows before its stages whether scenarios run in it.
  const withBrowser = provider ? await once("v3_browser", () => provider.available()) : false;
  const current = await host.store.getSpec();
  const cap = await once("v3_run_cap", () => runCapRub(o.pg, host.run.id));
  // V3-18: the owner's first words about the business — the skeleton's heading, lead and SEO read them.
  const request = await once("v3_request", () => loadBrief(o.db, systemId));
  const v3: V3Host = {
    route: host.route,
    runStep: host.runStep,
    emit: (type, payload) => host.emit(type as EventType, payload),
    signal: host.signal,
    run: { id: host.run.id },
    systemId,
    brief: () =>
      once("v3_brief", async () => {
        const v = await getLatestBrief(o.db, systemId);
        return v ? { version: v.version, brief: v.brief } : null;
      }),
    checkpoints: pgCheckpointStore(o.pg, systemId, host.run.id, once),
    currentSpec: () => host.store.getSpec(),
    commit: (input) => host.store.commitCompiled(input),
    runGates: async (level, ov) =>
      (level === "G0" ? await once("v3_passed_g0", () => passedG0(o.pg, host.run.id, systemId)) : null) ??
      runGates(host, provider, withBrowser, level, ov?.goalScenarios),
    composer,
    preview: async () => {
      const r = await gateWithRetry(() => host.runGates("G0"));
      const failed = failedBlockers(r);
      const errored = erroredBlockers(r);
      if (failed.length) return { ok: false, problems: failed.map((c) => c.message_ru) };
      if (errored.length) return { ok: false, problems: errored.map((c) => c.message_ru), unavailable: true };
      return { ok: true, problems: [] };
    },
    checkScenario: (input) => checkScenario(host, provider, withBrowser, input),
    goalBrowser: withBrowser,
    // V3-13: the visual critic in the process Chromium by default — with the platform's composer (its site model).
    // V3-14: the template gate with the process browser (without one the stage stays skipped); o.hooks override.
    hooks: {
      // V3-40: the critic sees the site's real library photos (not the platform's stand-ins) when the shared storage is
      // given — stand-ins read as «фейковые скриншоты» and pulled every score down.
      ...(!o.composer && provider && withBrowser
        ? { critic: platformCritic(provider, o.files ? { photo: criticLibraryPhotos(o.files) } : {}) }
        : {}),
      ...templateGateHooks({
        pg: o.pg,
        runId: host.run.id,
        browser: withBrowser ? provider : null,
        signal: host.signal,
        ...(o.log ? { log: o.log } : {}),
      }),
      // V3-15: the techreview (deterministic part + a reviewer of another family, T0).
      techreview: platformTechreview(host, {
        pg: o.pg,
        db: o.db,
        once,
        ...(o.registry ? { registry: o.registry } : {}),
      }),
      ...o.hooks,
    },
    recordDevelopmentRequest: (input) => host.recordDevelopmentRequest(input),
    notifyReady: (notice) =>
      notifyReady(
        o.db,
        o.mailer,
        { runId: host.run.id, systemId, platformOrigin: o.platformOrigin, notice },
        o.log,
      ),
    recentArchetypes: (niche) => once("v3_recent_archetypes", () => recentArchetypes(o.pg, systemId, niche)),
    ...(o.photos ? { photos: o.photos } : {}),
    once,
    // V3-20: the brief's integrations (stored contracts: mock until the key check, then live) over the backend;
    // V3-21: window keys stay within their hosts, and the agent opens key windows for the keys still missing.
    integrations: withKeyWindow(integrationsBuildHook(o.pg, systemId), {
      pg: o.pg,
      systemId,
      runId: host.run.id,
      ...(o.log ? { log: o.log } : {}),
    }),
  };
  // V3-17: build_stage / step_started / step_finished carry the structured progress for the canvas.
  const live = withLiveProgress(v3, {
    rubPerCredit: RUB_PER_CREDIT,
    stats: () => liveStats(o.pg, host.run.id, RUB_PER_CREDIT),
  });
  const out = await runBuildV3(live, {
    ...(o.registry ? { registry: o.registry } : {}),
    appName: current.spec.app.name,
    ...(request ? { request } : {}),
    platformUrl: o.platformOrigin,
    ...(cap !== null ? { runCapRub: cap } : {}),
  });
  if (out.status === "succeeded") return { status: "succeeded", summary_ru: out.summary_ru };
  throw new RunFailure(out.code, out.message_ru, out.retryable);
}
