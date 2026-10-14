// A build by the system brief on the harness v3 (V3-11; specs/agents/builder-v3.md §3 C6, product.yaml D77_v3 (10)):
// the V3Host over the run's durable BuildHost — the latest brief (V3-02 getLatestBrief) before each stage, checkpoints
// in platform.system_build_checkpoints, draft revisions through commitCompiled, the live preview (G0 → bundle →
// preview revision), the browser check of a scenario (G0, then G1 with the scenario's goal scenarios in the process
// Chromium of B2-28), «Запросы на развитие», the ready notice by e-mail and the niche memory of the art director.
// platform-api runs it behind WIZARD_BUILD_PIPELINE=v3 (agents/executors.ts).
import { createHash } from "node:crypto";
import {
  createPageComposer,
  erroredBlockers,
  failedBlockers,
  familyOf,
  type LibraryIndex,
  type PageComposer,
  type PhotoHost,
  parseLibraryIndex,
  querySubject,
  runBuildV3,
  type ScenarioCheckInput,
  type ScenarioCheckResult,
  seedHintsFromBrief,
  V3_BUILD_LIMITS,
  type V3BuildQuestion,
  type V3GateLevel,
  type V3Host,
  type V3ReadyNotice,
  type V3StageHook,
} from "@wizard/agents/builder";
import type { ModuleRegistry } from "@wizard/agents/planner";
import type { PhotoPicker, SemanticPhotoSource } from "@wizard/agents/stock";
import type { AppSpec } from "@wizard/appspec";
import {
  type GateReport,
  type GoalScenarioInput,
  type KnownContacts,
  knownContacts,
  LIBRARY_PHOTO_HINT,
  SEED_HINT_MAX_VALUES,
  type SeedHint,
} from "@wizard/gates";
import { createRegistry } from "@wizard/llm";
import { createLogger } from "@wizard/pii/log";
import { type FileStorage, readLibraryIndex } from "@wizard/runtime";
import { Kysely, sql } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import type postgres from "postgres";
import type { GoalBrowserProvider } from "../agents/goal-browser.js";
import { loadBuildQuestions } from "../agents/interview-v3-store.js";
import { semanticPhotoSource } from "../agents/stock.js";
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
import {
  cardPhotosKey,
  pickerCardCheck,
  planNiche,
  SITE_PHOTO_ENTITY,
  semanticSeedHints,
} from "./card-photos.js";
import { type DurableRead, pgCheckpointStore, recentArchetypes } from "./checkpoints.js";
import {
  type CriticDemoRows,
  type CriticInspectorOptions,
  criticInspector,
  criticLibraryPhotos,
  draftDemoRows,
  platformCritic,
} from "./critic.js";
import { liveStats, withLiveProgress } from "./progress.js";
import { checkPromises, type PromiseCheck, scenarioPromises, siteViews } from "./promises.js";
import { isFounderBuild, startBuildReport } from "./report/index.js";
import { draftFiles } from "./report/shots.js";
import { platformTechreview } from "./techreview.js";
import { templateGateHooks } from "./template-gate.js";

/** ₽ per credit of the platform (models.yaml#credits.rub_per_credit). */
const RUB_PER_CREDIT = createRegistry().rubPerCredit;

/** The worker's allowlist logger (the critic's inspection lines). */
const workerLog = createLogger({ svc: "worker" });

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

export { planNiche, semanticSeedHints } from "./card-photos.js";

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

/** What the photos of the draft's rows start from: the brief's hints, the plan's photos and what the index covers. */
interface DraftPhotoContext {
  /** The brief's hints and the index photos (photoSeedHints). */
  hints: SeedHint[];
  used: Set<string>;
  covered: Set<string>;
  niche: string | null;
}

async function draftPhotoContext(
  db: Db,
  systemId: string,
  spec: AppSpec,
  storage: FileStorage | null | undefined,
): Promise<DraftPhotoContext> {
  let hints: SeedHint[] = [];
  try {
    const brief = await getLatestBrief(db, systemId);
    if (brief) hints = seedHintsFromBrief(spec, brief.brief, await loadBrief(db, systemId));
  } catch {}
  const r = await sql<{ photos: unknown }>`
    select c.checkpoint -> 'data' -> 'photos' as photos
      from platform.system_build_checkpoints c
     where c.system_id = ${systemId} and c.key = 'photos'`
    .execute(db)
    .catch(() => ({ rows: [] as { photos: unknown }[] }));
  const photos = r.rows[0]?.photos;
  const plan = Array.isArray(photos) ? photos : [];
  const library = storage ? parseLibraryIndex(await readLibraryIndex(storage).catch(() => null)) : null;
  // V4-23: the draft has no demo articles unless the brief names them — their covers take no photos then.
  const skip = new Set(hints.some((h) => h.entity === "article" && h.field === "title") ? [] : ["article"]);
  const fromIndex = photoSeedHints(spec, plan, library, skip);
  return {
    hints: [...hints, ...fromIndex],
    covered: new Set([...fromIndex.map((h) => `${h.entity}.${h.field}`), ...skip]),
    used: new Set(plan.map((p) => String((p as { file?: unknown })?.file ?? ""))),
    niche: planNiche(plan),
  };
}

/** The checkpoint of the build's card check (V4-27): its key and the hints it gave. */
const CARD_PHOTOS = "card_photos";

/**
 * V3-18: seed hints of the draft of a system with a brief — the names of the offer its latest brief (else the owner's
 * first words) lists, for the preview's demo rows; [] without a brief or when reading it fails (the seed goes on).
 * V3-40: and the photos of the goods — the image fields a visitor reads take the library photos the photos stage
 * picked for the niche (photoSeedHints): a demo shop shows its goods with pictures, not empty cards.
 * V4-22: the semantic library (V4-10) is not in the index: the image fields still without photos get the library's
 * photos found by each row's name (the brief's «Терапия» → a photo of it), never a photo already on the site.
 * V4-27: the photos the build's card check chose, when it checked the same rows.
 */
export async function draftSeedHints(
  db: Db,
  systemId: string,
  spec: AppSpec,
  storage?: FileStorage | null,
  semanticSource: ((s: FileStorage) => Pick<SemanticPhotoSource, "search">) | null = semanticPhotoSource,
): Promise<SeedHint[]> {
  let ctx: DraftPhotoContext;
  try {
    ctx = await draftPhotoContext(db, systemId, spec, storage);
  } catch {
    return [];
  }
  const out = ctx.hints;
  if (!storage || !semanticSource) return out;
  try {
    const key = cardPhotosKey({ spec, ...ctx });
    const r = await sql<{ checkpoint: { fingerprint?: unknown; data?: { hints?: unknown } } }>`
      select c.checkpoint from platform.system_build_checkpoints c
       where c.system_id = ${systemId} and c.key = ${CARD_PHOTOS}`.execute(db);
    const saved = r.rows[0]?.checkpoint;
    if (saved?.fingerprint === key && Array.isArray(saved.data?.hints))
      return [...out, ...(saved.data.hints as SeedHint[])];
    const niche = ctx.niche ? { niche: ctx.niche } : {};
    return [
      ...out,
      ...(await semanticSeedHints(spec, out, ctx.used, ctx.covered, semanticSource(storage), niche)),
    ];
  } catch {
    return out;
  }
}

/**
 * V4-27: the build's check of the card photos (PhotoHost.cards): the rows the seed would show, one photo_pick call over
 * their candidates, the verdict kept in the checkpoint «card_photos» for the seed of the draft. Nothing to check
 * (no rows, no semantic photos) — nothing saved.
 */
export async function checkCardPhotos(o: {
  db: Db;
  pg: postgres.Sql;
  systemId: string;
  runId: string;
  spec: AppSpec;
  storage: FileStorage;
  picker: PhotoPicker;
  source?: Pick<SemanticPhotoSource, "search" | "thumbnail" | "flagText">;
  now?: () => number;
}): Promise<void> {
  const now = o.now ?? Date.now;
  const t0 = now();
  const ctx = await draftPhotoContext(o.db, o.systemId, o.spec, o.storage);
  if (!ctx.niche) return;
  const key = cardPhotosKey({ spec: o.spec, ...ctx });
  // The same rows were checked by an earlier build: its verdict stands, nothing is paid.
  const prev = await sql<{ f: string | null }>`
    select c.checkpoint ->> 'fingerprint' as f from platform.system_build_checkpoints c
     where c.system_id = ${o.systemId} and c.key = ${CARD_PHOTOS}`.execute(o.db);
  if (prev.rows[0]?.f === key) return;
  const source = o.source ?? semanticPhotoSource(o.storage);
  let checked = 0;
  const check = pickerCardCheck({ picker: o.picker, niche: ctx.niche, source });
  const hints = await semanticSeedHints(o.spec, ctx.hints, ctx.used, ctx.covered, source, {
    niche: ctx.niche,
    check: async (rows) => {
      checked = rows.length;
      return check(rows);
    },
  });
  if (checked === 0) return;
  await pgCheckpointStore(o.pg, o.systemId, o.runId).save({
    key: CARD_PHOTOS,
    fingerprint: key,
    data: { hints, rows: checked },
    costMilli: 0,
    durationMs: Math.max(0, now() - t0),
    runId: o.runId,
  });
}

/** Places whose photos show the work itself, in this order; the first screen («top», «top-2») is never a card's. */
const PHOTO_SLOT_ORDER = ["gallery", "features", "about"];
const TOP_SLOT = /^top(-\d+)?$/;

/**
 * V3-40: image hints of the demo rows — every image field of an entity a public role reads (goods, catalog projects,
 * article covers) gets library photos of the niche (/_wizard/photos/<file>/960: the runtime serves them in the draft and
 * the critic's browser loads them). Never twice and never the first screen's: the plan's work photos first, then the
 * other photos of the library under the same niche subjects as the plan's (`library`: its index), each entity its own
 * share — the farm shop of 11.10 showed three goods with one photo and a blog with the hero's. No photos — none.
 */
export function photoSeedHints(
  spec: AppSpec,
  photos: readonly unknown[],
  library?: LibraryIndex | null,
  skip: ReadonlySet<string> = new Set(),
): SeedHint[] {
  const plan = photos.filter((p): p is { slot: string; file: string } => {
    const x = p as { slot?: unknown; file?: unknown };
    return typeof x?.file === "string" && typeof x?.slot === "string";
  });
  const top = new Set(plan.filter((p) => TOP_SLOT.test(p.slot)).map((p) => p.file));
  const own = plan
    .filter((p) => !TOP_SLOT.test(p.slot))
    .sort((a, b) => rank(a.slot) - rank(b.slot))
    .map((p) => p.file);
  // More of the same niche: the library's photos under the subjects the plan's photos were picked for, details first.
  const entries = library?.entries ?? [];
  const planFiles = new Set(plan.map((p) => p.file));
  const subjects = new Map<string, number>();
  for (const e of entries)
    if (planFiles.has(e.file)) {
      const s = querySubject(e.query);
      if (s) subjects.set(s.subject, s.section === "detail" ? 0 : s.section === "about" ? 1 : 2);
    }
  const more = entries
    .map((e) => ({ e, order: subjects.get(querySubject(e.query)?.subject ?? "") }))
    .filter(
      (x): x is { e: (typeof entries)[number]; order: number } =>
        x.order !== undefined && x.e.orientation !== "portrait",
    )
    .sort((a, b) => a.order - b.order)
    .map((x) => x.e.file);
  const files = [...own, ...more]
    .filter((f, i, all) => !top.has(f) && all.indexOf(f) === i)
    .map((f) => `/_wizard/photos/${f}/960`)
    .filter((src) => LIBRARY_PHOTO_HINT.test(src));
  if (!files.length) return [];
  const publicRoles = new Set(spec.roles.filter((r) => r.access === "public").map((r) => r.name));
  const fields: { entity: string; field: string }[] = [];
  for (const e of spec.entities) {
    // The owner's replacements of the site's own photos (landing «Фото сайта») keep the plan's photos in their places.
    if (e.name === SITE_PHOTO_ENTITY || skip.has(e.name)) continue;
    const readable = spec.permissions.some(
      (p) => p.entity === e.name && publicRoles.has(p.role) && p.ops.includes("read"),
    );
    if (!readable) continue;
    for (const f of e.fields) if (f.type === "image") fields.push({ entity: e.name, field: f.name });
  }
  // Each field its own photos while they last; rows past them keep no photo rather than a repeat.
  const out: SeedHint[] = [];
  let next = 0;
  for (const f of fields) {
    const values = files.slice(next, next + SEED_HINT_MAX_VALUES);
    if (!values.length) break;
    next += values.length;
    out.push({ ...f, values });
  }
  return out;
}

function rank(slot: string): number {
  const i = PHOTO_SLOT_ORDER.findIndex((s) => slot === s || slot.startsWith(`${s}-`));
  return i === -1 ? PHOTO_SLOT_ORDER.length : i;
}

/**
 * V3-40: the demo rows of a system's draft for the critic's browser — draftDemoRows of the spec with the system's schema
 * key and the seed hints of its brief, as onG0Passed seeds the draft (agents/executors.ts → seedDraft): the critic sees
 * the filled catalog, shop and blog the visitor sees, not empty lists. {} — no such system.
 */
export async function draftCriticRows(
  db: Db,
  systemId: string,
  spec: AppSpec,
  storage?: FileStorage | null,
): Promise<CriticDemoRows> {
  const sys = await db
    .selectFrom("platform.systems")
    .select("schema_key")
    .where("id", "=", systemId)
    .executeTakeFirst();
  if (!sys) return {};
  return draftDemoRows(spec, sys.schema_key, await draftSeedHints(db, systemId, spec, storage));
}

/**
 * The critic's lines (critic_inspection) through the allowlist logger: the time, the library photos and the data rows
 * in allowlisted fields, every counter (stand-ins, pages, screens) as «name=value» in `reason`.
 */
function criticLog(runId: string, systemId: string) {
  return (msg: string, f: Record<string, string | number> = {}) =>
    workerLog.info(msg, {
      runId,
      systemId,
      ...(typeof f.ms === "number" ? { durationMs: f.ms } : {}),
      ...(typeof f.photosLibrary === "number" ? { count: f.photosLibrary } : {}),
      ...(typeof f.dataRows === "number" ? { rows: f.dataRows } : {}),
      reason: Object.entries(f)
        .map(([k, v]) => `${k}=${v}`)
        .join(" "),
    });
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
  promises?: (input: ScenarioCheckInput) => Promise<PromiseCheck>,
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
  // V4-21: what the scenario promises the visitor sees is on the site and shows it.
  // Not kept: the system works, so the layer stays (the build tries one repair; the rest goes to the requests).
  const kept = promises ? await promises(input) : null;
  if (kept?.problems.length) return { ok: true, problems: [], browser: withBrowser, unkept: kept.problems };
  return { ok: true, problems: [], browser: withBrowser };
}

/**
 * V4-21: the promises of a scenario on the committed draft — by the site model, and with the browser by what its
 * sections show (the draft's demo rows and the library's photos, as the critic sees them).
 */
export function scenarioPromiseCheck(
  host: BuildHost,
  browser: GoalBrowserProvider | null,
  o: {
    contacts: () => Promise<KnownContacts>;
    inspector?: Omit<CriticInspectorOptions, "browser" | "probe">;
  },
): (input: ScenarioCheckInput) => Promise<PromiseCheck> {
  return async (input) => {
    if (!scenarioPromises(input.scenario).length) return { promises: [], problems: [], browser: false };
    const files = await draftFiles(host.store);
    const contacts = await o.contacts();
    const views = browser
      ? await siteViews(
          browser,
          {
            scenario: input.scenario,
            spec: (await host.store.getSpec()).spec,
            files,
            contacts,
            ...(host.signal ? { signal: host.signal } : {}),
          },
          o.inspector,
        ).catch(() => null)
      : null;
    return checkPromises(input.scenario, files, views, contacts);
  };
}

/** V4-09: model families that wrote the pages of run `runId` (its successful page_compose calls). */
export async function pageAuthorFamilies(pg: postgres.Sql, runId: string): Promise<string[]> {
  const rows = await pg<{ model_id: string }[]>`
    select distinct c.model_id from platform.llm_calls c
    where c.run_id = ${runId} and c.call_type = 'page_compose' and c.status = 'ok'`;
  return [...new Set(rows.map((r) => familyOf(r.model_id)).filter((f): f is string => f !== null))];
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
    /** V4-04: WIZARD_FOUNDER_EMAIL — the founder's builds keep the records of their model calls. */
    founderEmail?: string | null;
  },
): Promise<{ status: "succeeded"; summary_ru: string }> {
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
  // V3-40: the draft's demo rows for the critic, made once per build on its first inspection (the critic changes pages,
  // not entities); a failed read is tried again by the next inspection.
  let demo: Promise<CriticDemoRows> | undefined;
  const demoRows = (spec: AppSpec): Promise<CriticDemoRows> => {
    demo ??= draftCriticRows(o.db, systemId, spec, o.files).catch((e: unknown) => {
      demo = undefined;
      throw e;
    });
    return demo;
  };
  // V4-04: the report of the build (screenshots, gates and scenarios with their HTTP responses, critic, ₽ and minutes).
  const founder = await once("v4_report_founder", () => isFounderBuild(o.pg, host.run.id, o.founderEmail));
  const report = startBuildReport({
    pg: o.pg,
    runId: host.run.id,
    files: o.files ?? null,
    store: host.store,
    browser: withBrowser ? provider : null,
    founder,
    critic: { ...(o.files ? { photo: criticLibraryPhotos(o.files) } : {}), data: demoRows },
    signal: host.signal,
    ...(o.log ? { log: o.log } : {}),
  });
  // V4-21: the contacts the owner gave (brief and first words) — a contacts promise is kept by one of them.
  const promiseCheck = scenarioPromiseCheck(host, withBrowser ? provider : null, {
    contacts: async () => {
      const v = await getLatestBrief(o.db, systemId);
      return knownContacts([JSON.stringify(v?.brief ?? {}), JSON.stringify(request ?? "")]);
    },
    inspector: { ...(o.files ? { photo: criticLibraryPhotos(o.files) } : {}), data: demoRows },
  });
  // V3-12 / V4-06: the page composer (skeleton without a model; pages as code through host.route); the judge of the
  // home page's two first screens sees them in the process Chromium (the critic's inspector).
  const composer =
    o.composer ??
    createPageComposer(
      provider && withBrowser
        ? {
            inspect: criticInspector({
              browser: provider,
              ...(o.files ? { photo: criticLibraryPhotos(o.files) } : {}),
              data: demoRows,
              log: criticLog(host.run.id, systemId),
            }),
          }
        : {},
    );
  const v3: V3Host = {
    route: report.route(host.route),
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
    // V4-08: the interview's non-blocking questions come in the build, each with the assumption it builds on meanwhile.
    questions: {
      pending: () =>
        once("v3_build_questions", async () =>
          deferredAsBuildQuestions(await loadBuildQuestions(o.db, systemId)),
        ),
    },
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
    checkScenario: (input) =>
      report.scenario(input.scenario.id, () =>
        checkScenario(host, report.provider(provider), withBrowser, input, promiseCheck),
      ),
    goalBrowser: withBrowser,
    // V3-13: the visual critic in the process Chromium by default — with the platform's composer (its site model).
    // V3-14: the template gate with the process browser (without one the stage stays skipped); o.hooks override.
    hooks: {
      // V3-40: the critic sees the site's real library photos (not the platform's stand-ins) when the shared storage is
      // given — stand-ins read as «фейковые скриншоты» and pulled every score down — and the draft's demo rows (not
      // empty catalogs: «каталог не заполнен», «блог пуст»).
      ...(!o.composer && provider && withBrowser
        ? {
            critic: platformCritic(provider, {
              ...(o.files ? { photo: criticLibraryPhotos(o.files) } : {}),
              data: demoRows,
              log: criticLog(host.run.id, systemId),
              // V4-09: the critic is never of the family of the model that wrote this build's pages.
              authorFamilies: () => pageAuthorFamilies(o.pg, host.run.id),
            }),
          }
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
    ...(o.photos
      ? {
          photos: {
            ...o.photos,
            // V4-27: the card photos of the draft, checked by the vision model before the seed.
            ...(o.files
              ? {
                  cards: ({ spec, picker }: { spec: AppSpec; picker: PhotoPicker }) =>
                    checkCardPhotos({
                      db: o.db,
                      pg: o.pg,
                      systemId,
                      runId: host.run.id,
                      spec,
                      storage: o.files as FileStorage,
                      picker,
                    }),
                }
              : {}),
          },
        }
      : {}),
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
  }).catch(async (e: unknown) => {
    await report.finish({
      status: "failed",
      code: typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "INTERNAL",
      message: String((e as Error)?.message ?? e).slice(0, 300),
    });
    throw e;
  });
  await report.finish(
    out.status === "succeeded"
      ? { status: "succeeded" }
      : { status: "failed", code: out.code, message: out.message_ru },
  );
  if (out.status === "succeeded") return { status: "succeeded", summary_ru: out.summary_ru };
  throw new RunFailure(out.code, out.message_ru, out.retryable);
}

/** The interview's deferred questions as build questions: one option, the assumption, taken until the owner answers. */
export function deferredAsBuildQuestions(
  deferred: readonly { topic: string; text: string; assumption: string }[],
): V3BuildQuestion[] {
  const seen = new Set<string>();
  const out: V3BuildQuestion[] = [];
  for (const d of deferred) {
    const id = `deferred_${createHash("sha256").update(d.text).digest("hex").slice(0, 12)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text: d.text, options: [{ id: "assumed", label: d.assumption }], recommended: "assumed" });
  }
  return out;
}
