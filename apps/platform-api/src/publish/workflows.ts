// Workflows publish and rollback (workflows.yaml#workflows.publish, #rollback). The run engine (runs/queue.ts) holds
// the lock and the run lifecycle; these functions are the steps between run_started and the terminal event.

import { dirname } from "node:path";
import { type AppSpec, archiveTables, planMigration } from "@wizard/appspec";
import type { GateContext, GateLevel } from "@wizard/gates";
import { publishTelegramBots, type TelegramPublishOptions } from "@wizard/runtime";
import type { Selectable } from "kysely";
import type postgres from "postgres";
import { httpRuntimeBackfill, type RuntimeAiBackfill, runPendingBackfills } from "../ai/backfill.js";
import { TECHREVIEW_BLOCKED_RU, techreviewBlockersOf } from "../builds-v3/techreview-verdict.js";
import type { Config } from "../config.js";
import { type Db, json } from "../db/index.js";
import type { RunsTable, SystemsTable } from "../db/types.js";
import {
  archiveSchemaOf,
  checkForPublish,
  DESTRUCTIVE_RU,
  markApplied,
  rollbackBlockedBy,
  undoTarget,
} from "../destructive/service.js";
import { repoPublishBlock } from "../git-sync/publish.js";
import { alertOnce } from "../ops/alert.js";
import { opsAlertFromConfig } from "../ops/alert-config.js";
import { appendEvent, type TxCtx } from "../runs/events.js";
import { inheritedG1Checks } from "../runs/g1-checks.js";
import { recordGateReport } from "../runs/gates.js";
import { type GateReport, type GateRunner, RunFailure } from "../runs/types.js";
import { SECRET_EGRESS_BLOCKED_RU, systemSecretEgressIssues } from "../secrets-v3/agent.js";
import { loadManifest, loadRevision, loadSpec, lockSystem, revertRevision } from "../services/revisions.js";
import type { BlobStore } from "../storage/blobs.js";
import {
  abuseContext,
  abuseFlagChecks,
  defaultModerationLog,
  egressHostsNote,
  FOUNDER_REVIEW_REASON_RU,
  type FounderReviewStatus,
  founderReviewChecks,
  founderReviewReason,
  founderReviewStatus,
  REVIEW_PENDING_RU,
  REVIEW_REJECTED_RU,
  requestFounderReview,
  secretExistsFor,
} from "./moderation.js";
import { applyProdMigration, httpSmoke, type PublishOptions, prodUrl, storedPlan } from "./prod.js";

type Run = Selectable<RunsTable>;
type System = Selectable<SystemsTable>;

export interface FlowHost {
  run: Run;
  db: Db;
  pg: postgres.Sql;
  blobs: BlobStore;
  config: Config;
  gates: GateRunner | undefined;
  signal: AbortSignal;
  options: PublishOptions;
  tx<T>(fn: (t: TxCtx) => Promise<T>): Promise<T>;
  /** step_started → fn → step_finished, with the cancel check before it; fn is one checkpoint (M1). */
  step<T>(name: string, label_ru: string, fn: () => Promise<T>): Promise<T>;
  /** A checkpoint without events: reads that steer the flow and writes outside steps (replayed after a restart). */
  once<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** gate_G0 of the draft at draft_revision, with migrate_draft/bundle_and_reload on success (engine #gate). */
  draftG0(): Promise<GateReport>;
  /** M3-02: AI backfill on the runtime (default: HTTP to the runtime's internal port). */
  aiBackfill?: RuntimeAiBackfill | null;
}

export interface FlowResult {
  summary_ru: string;
  resultRevision: number | null;
  prodUrl?: string | null;
}

async function system(h: FlowHost): Promise<System> {
  return h.db
    .selectFrom("platform.systems")
    .selectAll()
    .where("id", "=", h.run.system_id as string)
    .executeTakeFirstOrThrow();
}

async function livePublication(q: Db | TxCtx["trx"], systemId: string) {
  return q
    .selectFrom("platform.publications")
    .selectAll()
    .where("system_id", "=", systemId)
    .where("status", "=", "live")
    .executeTakeFirst();
}

async function setStatus(h: FlowHost, id: string, status: string, from: string[]): Promise<void> {
  await h.db
    .updateTable("platform.publications")
    .set({ status })
    .where("id", "=", id)
    .where("status", "in", from)
    .execute();
}

async function revisionFiles(h: FlowHost, systemId: string, version: number): Promise<Map<string, string>> {
  const manifest = await loadManifest(h.db, h.blobs, systemId, version);
  const out = new Map<string, string>();
  for (const [p, sha] of Object.entries(manifest))
    if (p.startsWith("ui/") || p.startsWith("functions/"))
      out.set(p, (await h.blobs.get(sha)).toString("utf8"));
  return out;
}

/**
 * runtime.yaml#auth.role_assignment (в): the owner of the system on the platform — the publishing user (publish is
 * owner-only, D11), else the creator of the system. Deleted accounts get nothing.
 */
async function ownerAccount(h: FlowHost, sys: System) {
  return h.db
    .selectFrom("platform.users")
    .select(["email", "name"])
    .where("id", "=", h.run.started_by ?? sys.created_by)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

/** switch: new publication live, previous superseded, prod_revision, hwm (workflows.yaml#workflows.publish). */
async function switchLive(h: FlowHost, publicationId: string, revision: number): Promise<void> {
  await h.step("switch", "Переключаю систему на новую версию", () =>
    h.tx(async (t) => {
      const sys = await lockSystem(t, h.run.system_id as string);
      await t.trx
        .updateTable("platform.publications")
        .set({ status: "superseded" })
        .where("system_id", "=", sys.id)
        .where("status", "=", "live")
        .execute();
      await t.trx
        .updateTable("platform.publications")
        .set({ status: "live", live_at: new Date() })
        .where("id", "=", publicationId)
        .execute();
      await t.trx
        .updateTable("platform.systems")
        .set({
          prod_revision: revision,
          schema_hwm_revision: Math.max(sys.schema_hwm_revision ?? 0, revision),
          updated_at: new Date(),
          last_activity_at: new Date(),
        })
        .where("id", "=", sys.id)
        .execute();
    }),
  );
}

/**
 * M3-02: pending prod backfills (card.aiBackfill of a change build) of actions present in the published spec run after
 * the smoke over the live prod records. A stopped backfill (limit, credits) does not fail the publication.
 */
async function prodAiBackfill(h: FlowHost, sys: System, spec: AppSpec): Promise<void> {
  const names = (spec.aiActions ?? []).map((a) => a.name);
  if (names.length === 0) return;
  const pending = await h.once("ai_backfill_pending", async () => {
    const r = await h.db
      .selectFrom("platform.ai_backfills")
      .select("id")
      .where("system_id", "=", sys.id)
      .where("env", "=", "prod")
      .where("status", "=", "pending")
      .where("action", "in", names)
      .executeTakeFirst();
    return r !== undefined;
  });
  if (!pending) return;
  await h.step("ai_backfill", "Заполняю старые записи с помощью ИИ", async () => {
    await runPendingBackfills(h.db, {
      systemId: sys.id,
      systemKey: sys.schema_key,
      env: "prod",
      spec,
      runtime: h.aiBackfill === undefined ? httpRuntimeBackfill(h.config) : h.aiBackfill,
    });
  });
}

/** smoke; on failure prod goes back to prev_publication without DDL and the run fails SMOKE_FAILED. */
async function smoke(
  h: FlowHost,
  sys: System,
  publicationId: string,
  prevId: string | null,
  revision: number,
): Promise<string> {
  const url = prodUrl(h.config, sys.slug);
  const check = h.options.smoke ?? httpSmoke(5000, { internalUrl: h.config.runtimeInternalUrl });
  const res = await h.step("smoke", "Проверяю, что опубликованная система открывается", () =>
    check({ slug: sys.slug, systemKey: sys.schema_key, revision, url }),
  );
  if (res.ok) return url;
  await h.once("smoke_rollback", () =>
    h.tx(async (t) => {
      const locked = await lockSystem(t, sys.id);
      await t.trx
        .updateTable("platform.publications")
        .set({ status: "failed" })
        .where("id", "=", publicationId)
        .execute();
      let prevRevision: number | null = null;
      if (prevId) {
        const prev = await t.trx
          .updateTable("platform.publications")
          .set({ status: "live" })
          .where("id", "=", prevId)
          .returning("revision")
          .executeTakeFirst();
        prevRevision = prev?.revision ?? null;
      }
      await t.trx
        .updateTable("platform.systems")
        .set({ prod_revision: prevRevision, updated_at: new Date() })
        .where("id", "=", locked.id)
        .execute();
    }),
  );
  throw new RunFailure(
    "SMOKE_FAILED",
    `Новая версия не ответила после публикации (${res.reason.slice(0, 200)}). Prod возвращён к предыдущей версии.`,
    true,
  );
}

/**
 * telegram.yaml#bot_api (bot=own): getMe checks the token and setWebhook points the bot at the prod host, before
 * apply_migration so a broken bot never leaves prod half-published. Outbox mode (default without
 * WIZARD_CONNECTORS=live) only records the calls.
 */
async function telegramBots(h: FlowHost, sys: System, revision: number, spec: AppSpec): Promise<void> {
  if (!(spec.integrations ?? []).some((i) => i.connector === "telegram")) return;
  const o: TelegramPublishOptions = h.options.telegram ?? {
    mode: process.env.WIZARD_CONNECTORS === "live" ? "live" : "outbox",
    outboxDir: dirname(h.config.outboxDir),
  };
  await h.step("telegram_webhook", "Подключаю Telegram-бота системы", async () => {
    try {
      await publishTelegramBots(o, { systemKey: sys.schema_key, slug: sys.slug, revision, spec });
    } catch (e) {
      // ConnectorError.retryable: Telegram down or throttling; otherwise the owner has to fix the bot.
      const transient = (e as { retryable?: unknown }).retryable === true;
      throw new RunFailure(
        "GATES_FAILED",
        transient
          ? "Telegram сейчас недоступен — бот системы не подключён. Повторите публикацию позже."
          : "Telegram не принял бота системы: проверьте токен бота в секретах интеграции и повторите публикацию.",
        transient,
      );
    }
  });
}

/** One gate on the publish revision: gate_started, the gate, gate_reports + gate_result (as the draft gates). */
async function prodGate(h: FlowHost, level: GateLevel, ctx: GateContext, systemId: string) {
  if (!h.gates) throw new RunFailure("INTERNAL", "Проверки (гейты) пока не подключены к платформе", true);
  await h.tx((t) => appendEvent(t, h.run.id, "gate_started", { level, revision: ctx.specVersion }));
  const report = { ...(await h.gates(level, ctx)), level };
  const qa = level === "G1" && ctx.checks?.length ? { spec: ctx.spec, checks: ctx.checks } : undefined;
  await h.tx((t) =>
    recordGateReport(t, { runId: h.run.id, systemId, revision: ctx.specVersion, report, qa }),
  );
  return report;
}

/**
 * M2 (config.prodG2Required): gate_G2 of workflows.yaml#workflows.publish on the revision being published, after its
 * precondition «G1 passed на этой ревизии» (gates.yaml#G2.precondition; G1 runs here when the build did not pass it
 * on this revision, e.g. after a compliance edit). A G2 blocker → GATES_FAILED; any failed G2-AF-* → abuse_flag in the
 * moderation journal; a G2-AF-08/G2-AF-09 warning → founder review of this revision, publish waits for approval.
 */
async function prodG2(h: FlowHost, sys: System, revision: number, spec: AppSpec, prevSpec: AppSpec | null) {
  const before = await h.once("founder_review_before", () => founderReviewStatus(h.db, sys.id, revision));
  if (before === "rejected") throw new RunFailure("GATES_FAILED", REVIEW_REJECTED_RU);
  const base = async (): Promise<GateContext> => ({
    spec,
    prevSpec,
    specVersion: revision,
    files: await revisionFiles(h, sys.id, revision),
    env: "prod",
    systemKey: sys.schema_key,
    db: h.pg,
    milestone: h.config.milestone,
    signal: h.signal,
  });
  const g1Passed = await h.once("g1_passed", async () => {
    const row = await h.db
      .selectFrom("platform.gate_reports")
      .select("run_id")
      .where("system_id", "=", sys.id)
      .where("revision", "=", revision)
      .where("level", "=", "G1")
      .where("passed", "=", true)
      .executeTakeFirst();
    return row !== undefined;
  });
  if (!g1Passed)
    await h.step("gate_G1_prod", "Проверяю сценарии работы", async () => {
      // QA scenarios of card ACs without inline steps come from the build's G1 (db.yaml#g1_checks): reused per AC
      // while its text is unchanged; an AC rewritten since then stays uncovered (G1-AC-COVER fails).
      const { checks } = await inheritedG1Checks(h.db, sys.id, revision, spec);
      const report = await prodGate(
        h,
        "G1",
        { ...(await base()), ...(checks.length > 0 ? { checks } : {}) },
        sys.id,
      );
      if (!report.passed)
        throw new RunFailure(
          "GATES_FAILED",
          "Версия не прошла проверку сценариев работы. Подробности — в отчёте проверок",
        );
    });
  const review: FounderReviewStatus | null = await h.step(
    "gate_G2",
    "Проверяю безопасность, права доступа и персональные данные",
    async () => {
      const report = await prodGate(
        h,
        "G2",
        {
          ...(await base()),
          slug: sys.slug,
          secretExists: secretExistsFor(h.db, sys),
          abuse: await abuseContext(h.db, sys.org_id),
        },
        sys.id,
      );
      const flags = abuseFlagChecks(report);
      if (flags.length > 0)
        (h.options.moderationLog ?? defaultModerationLog())({
          runId: h.run.id,
          orgId: sys.org_id,
          systemId: sys.id,
          revision,
          checks: flags,
        });
      if (!report.passed) {
        // gates.yaml#G2.antifraud_rules: a neutral message (abuse.yaml#messages_ru), rules are not disclosed.
        const af = report.checks.find((c) => flags.includes(c.id) && c.status === "fail");
        throw new RunFailure(
          "GATES_FAILED",
          af?.message_ru ?? "Версия не прошла проверку безопасности. Подробности — в отчёте проверок",
        );
      }
      return founderReviewChecks(report).length > 0 ? requestFounderReview(h.db, sys.id, revision) : null;
    },
  );
  if (review === "pending") throw new RunFailure("GATES_FAILED", REVIEW_PENDING_RU);
  if (review === "rejected") throw new RunFailure("GATES_FAILED", REVIEW_REJECTED_RU);
}

/**
 * M2-09 (abuse.yaml#identification.founder_review, workflows.yaml#workflows.publish.preconditions): with
 * config.founderReviewRequired and orgs.require_founder_review, the first prod publication of a system and a
 * publication with new personal-data fields wait for the founder's approval of this revision (after G0/G2 passed, so
 * the founder reviews a revision that is otherwise publishable). A new request alerts the founder (ids only).
 */
async function founderReviewGate(
  h: FlowHost,
  sys: System,
  revision: number,
  spec: AppSpec,
  prodSpec: AppSpec | null,
): Promise<void> {
  const reason = await h.once("founder_review_reason", () =>
    founderReviewReason(h.db, {
      systemId: sys.id,
      orgId: sys.org_id,
      spec,
      prodSpec,
      required: h.config.founderReviewRequired,
    }),
  );
  if (!reason) return;
  const status = await h.step("founder_review", "Проверяю одобрение модератора", async () => {
    const now = await requestFounderReview(h.db, sys.id, revision);
    if (now === "pending") {
      // One alert per revision (db.yaml#ops_alerts key founder_review:<system>:<revision>), whichever run asks first.
      await alertOnce(
        h.db,
        `founder_review:${sys.id}:${revision}`,
        h.options.alert ?? opsAlertFromConfig(h.config),
        {
          level: "warn",
          event: "founder_review_requested",
          text: `Wizard: ревизия ${revision} системы ${sys.id} (org ${sys.org_id}) ждёт ревью перед prod — ${FOUNDER_REVIEW_REASON_RU[reason]}.${egressHostsNote(spec, prodSpec)} Одобрить: pnpm --filter @wizard/platform-api moderation approve ${sys.id} ${revision}`,
          fields: { systemId: sys.id, orgId: sys.org_id, revision, reason },
        },
      );
    }
    return now;
  });
  if (status === "pending") throw new RunFailure("GATES_FAILED", REVIEW_PENDING_RU);
  if (status === "rejected") throw new RunFailure("GATES_FAILED", REVIEW_REJECTED_RU);
}

/** Marks the publication failed when a step throws after plan_migration (unless it already moved on). */
async function guarded<T>(h: FlowHost, publicationId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await h
      .once("publication_failed", () => setStatus(h, publicationId, "failed", ["planned", "applying"]))
      .catch(() => {});
    throw e;
  }
}

/**
 * workflows.yaml#workflows.publish.preconditions: a G0-passed revision with an artifact, or the latest revision not
 * gated yet (style/compliance edits of the owner) — publish runs the draft G0 on it first.
 */
export function isPublishable(
  rev: { version: number; g0_passed: boolean | null; bundle_key: string | null },
  draftRevision: number,
): boolean {
  if (rev.version > draftRevision) return false;
  if (rev.g0_passed === true && rev.bundle_key) return true;
  return rev.version === draftRevision && rev.g0_passed !== false;
}

export async function runPublish(h: FlowHost): Promise<FlowResult> {
  const input = h.run.input as { revision?: unknown };
  const revision = typeof input.revision === "number" ? input.revision : Number.NaN;
  const sys = await h.once("load_system", () => system(h));
  const revisionRow = (name: string) =>
    h.once(name, async () =>
      Number.isInteger(revision) ? await loadRevision(h.db, sys.id, revision) : undefined,
    );
  let rev = await revisionRow("load_revision");
  if (!rev || !isPublishable(rev, sys.draft_revision))
    throw new RunFailure("GATES_FAILED", "Эта ревизия не прошла проверки — публиковать её нельзя");
  // V3-15: the techreview of the v3 build that left this revision found blockers (D77 (10)).
  const [tr] = await h.once("techreview_verdict", () => techreviewBlockersOf(h.db, sys.id, revision));
  if (tr) throw new RunFailure("GATES_FAILED", TECHREVIEW_BLOCKED_RU(tr));
  // V3-31: with a connected repository a revision is published after its PR is merged (D77 (3)).
  const repo = await h.once("repo_merged", () => repoPublishBlock(h.db, sys.id, revision));
  if (repo) throw new RunFailure("GATES_FAILED", repo.message_ru);
  if (!rev.bundle_key) {
    // A style/compliance revision made without a build: the draft gate builds it first (moves the preview too).
    const report = await h.draftG0();
    rev = await revisionRow("reload_revision");
    if (!report.passed || !rev?.bundle_key)
      throw new RunFailure("GATES_FAILED", "Версия не прошла проверки. Подробности — в отчёте проверок");
  }
  const bundleKey = rev.bundle_key;
  const spec = rev.spec as unknown as AppSpec;
  // V3-18 (D37): no window key of the revision's functions goes to a host its window did not show.
  const [egress] = await h.once("secret_egress", () => systemSecretEgressIssues(h.pg, sys.id, spec));
  if (egress) throw new RunFailure("GATES_FAILED", SECRET_EGRESS_BLOCKED_RU(egress));
  const hwm = sys.schema_hwm_revision;
  const prevSpec = hwm !== null ? await loadSpec(h.db, sys, hwm) : null;

  // M2-72 (D56/D72): a revision that removes or narrows prod data needs the owner's confirmation of exactly this
  // revision and these consequences (counted now on prod); the removed data then goes to the archive, not away.
  const destructive = await h.once("destructive_check", () =>
    checkForPublish(h.db, h.pg, sys, revision, spec),
  );
  const confirmed = destructive.state === "none" || destructive.state === "confirmed";
  const plan = planMigration(prevSpec, spec, { env: "prod", destructiveConfirmed: confirmed });
  const pub = await h.step("plan_migration", "Готовлю изменения данных", () =>
    h.tx(async (t) => {
      const live = await livePublication(t.trx, sys.id);
      return t.trx
        .insertInto("platform.publications")
        .values({
          system_id: sys.id,
          revision,
          schema_revision: Math.max(hwm ?? 0, revision),
          prev_publication_id: live?.id ?? null,
          migration_plan: json(storedPlan(plan)),
          bundle_key: bundleKey,
          status: "planned",
          run_id: h.run.id,
          created_by: h.run.started_by ?? sys.created_by,
        })
        .returning(["id", "prev_publication_id"])
        .executeTakeFirstOrThrow();
    }),
  );

  return guarded(h, pub.id, async () => {
    await h.step("gate_G0_prod", "Проверяю версию перед публикацией", async () => {
      if (!confirmed)
        throw new RunFailure("DESTRUCTIVE_IN_PROD", destructive.message_ru ?? DESTRUCTIVE_RU.missing);
      if (plan.errors.length > 0)
        throw new RunFailure(
          "GATES_FAILED",
          plan.errors[0]?.message_ru ?? "Спека ревизии не прошла проверку",
        );
      if (!h.gates) throw new RunFailure("INTERNAL", "Проверки (гейты) пока не подключены к платформе", true);
      await h.tx((t) => appendEvent(t, h.run.id, "gate_started", { level: "G0", revision }));
      const report = {
        ...(await h.gates("G0", {
          spec,
          prevSpec,
          specVersion: revision,
          files: await revisionFiles(h, sys.id, revision),
          env: "prod",
          systemKey: sys.schema_key,
          db: h.pg,
          milestone: h.config.milestone,
          signal: h.signal,
          destructiveConfirmed: confirmed,
        })),
        level: "G0" as const,
      };
      await h.tx((t) => recordGateReport(t, { runId: h.run.id, systemId: sys.id, revision, report }));
      if (!report.passed)
        throw new RunFailure(
          "GATES_FAILED",
          "Версия не прошла проверки перед публикацией. Подробности — в отчёте проверок",
        );
    });
    if (h.config.prodG2Required) await prodG2(h, sys, revision, spec, prevSpec);
    await founderReviewGate(h, sys, revision, spec, prevSpec);
    await telegramBots(h, sys, revision, spec);
    await h.step("apply_migration", "Применяю изменения данных", async () => {
      await setStatus(h, pub.id, "applying", ["planned"]);
      const change =
        destructive.state === "confirmed" && destructive.changeId && destructive.archiveTag
          ? { id: destructive.changeId, tag: destructive.archiveTag, schema: archiveSchemaOf(sys) }
          : null;
      const owner = await ownerAccount(h, sys);
      await applyProdMigration(h.pg, {
        systemId: sys.id,
        systemKey: sys.schema_key,
        plan,
        revision,
        publicationId: pub.id,
        options: h.options,
        ...(owner ? { owner: { spec, email: owner.email, displayName: owner.name } } : {}),
        ...(change
          ? {
              archive: { schema: change.schema, tag: change.tag },
              inTx: (tx) =>
                markApplied(tx, {
                  changeId: change.id,
                  publicationId: pub.id,
                  baseRevision: hwm,
                  schema: change.schema,
                  tables: archiveTables(plan, change.tag),
                }),
            }
          : {}),
      });
    });
    await switchLive(h, pub.id, revision);
    const url = await smoke(h, sys, pub.id, pub.prev_publication_id, revision);
    await prodAiBackfill(h, sys, spec);
    return { summary_ru: `Ревизия ${revision} опубликована`, resultRevision: revision, prodUrl: url };
  });
}

/**
 * M2-72 «Отменить правку»: the last applied destructive change goes back — the schema returns to the revision before
 * it (reverse plan; columns, entities and original values restored from the archive, whatever the change added is
 * archived in turn), schema_hwm_revision is set back, prod switches to the publication live before the change.
 */
async function runUndo(h: FlowHost, changeId: string): Promise<FlowResult> {
  const sys = await h.once("load_system", () => system(h));
  const target = await h.once("undo_target", async () => {
    const u = await undoTarget(h.db, sys);
    if (!u || u.row.id !== changeId) return null;
    return {
      revision: u.row.revision,
      toRevision: u.toRevision,
      bundleKey: u.toBundleKey,
      baseRevision: u.baseRevision,
      archiveTag: u.row.archive_tag,
      tables: (u.row.archive_tables ?? []) as string[],
    };
  });
  if (!target) throw new RunFailure("ROLLBACK_TARGET_INVALID", DESTRUCTIVE_RU.undoUnavailable);
  const plan = planMigration(
    await loadSpec(h.db, sys, target.revision),
    await loadSpec(h.db, sys, target.baseRevision),
    { env: "prod", destructiveConfirmed: true },
  );
  const pub = await h.step("plan_migration", "Готовлю отмену правки", () =>
    h.tx(async (t) => {
      await lockSystem(t, sys.id);
      const live = await livePublication(t.trx, sys.id);
      return t.trx
        .insertInto("platform.publications")
        .values({
          system_id: sys.id,
          revision: target.toRevision,
          schema_revision: target.baseRevision,
          prev_publication_id: live?.id ?? null,
          migration_plan: json(storedPlan(plan)),
          bundle_key: target.bundleKey,
          status: "planned",
          run_id: h.run.id,
          created_by: h.run.started_by ?? sys.created_by,
        })
        .returning(["id", "prev_publication_id"])
        .executeTakeFirstOrThrow();
    }),
  );
  return guarded(h, pub.id, async () => {
    await h.step("undo_migration", "Возвращаю данные из архива", async () => {
      await setStatus(h, pub.id, "applying", ["planned"]);
      const schema = archiveSchemaOf(sys);
      await applyProdMigration(h.pg, {
        systemId: sys.id,
        systemKey: sys.schema_key,
        plan,
        revision: target.toRevision,
        publicationId: pub.id,
        options: h.options,
        hwmRevision: target.baseRevision,
        archive: {
          schema,
          tag: `u${changeId.replace(/-/g, "").slice(0, 12)}`,
          restore: { tag: target.archiveTag, tables: target.tables },
        },
        inTx: async (tx) => {
          await tx`
            update platform.destructive_changes
               set status = 'undone', undone_at = now(), undone_by = ${h.run.started_by}, undo_run_id = ${h.run.id}
             where id = ${changeId} and status = 'applied'`;
        },
      });
    });
    await switchLive(h, pub.id, target.toRevision);
    const url = await smoke(h, sys, pub.id, pub.prev_publication_id, target.toRevision);
    return {
      summary_ru: `Правка отменена: данные возвращены из архива, работает ревизия ${target.toRevision}`,
      resultRevision: target.toRevision,
      prodUrl: url,
    };
  });
}

export async function runRollback(h: FlowHost): Promise<FlowResult> {
  const input = h.run.input as { env?: unknown; toRevision?: unknown; undoChangeId?: unknown };
  if (input.env === "prod" && typeof input.undoChangeId === "string") return runUndo(h, input.undoChangeId);
  const to = typeof input.toRevision === "number" ? input.toRevision : Number.NaN;
  const sys = await h.once("load_system", () => system(h));
  const target = await h.once("load_revision", async () =>
    Number.isInteger(to) ? await loadRevision(h.db, sys.id, to) : undefined,
  );
  if (!target) throw new RunFailure("ROLLBACK_TARGET_INVALID", "Такой ревизии нет");

  if (input.env === "draft") {
    const version = await h.step("revert", `Возвращаю черновик к версии ${to}`, () =>
      h.tx(async (t) => {
        const v = await revertRevision(t, {
          systemId: sys.id,
          toVersion: to,
          runId: h.run.id,
          authorUserId: h.run.started_by,
          blobs: h.blobs,
        });
        await appendEvent(t, h.run.id, "ops_applied", {
          revision: v,
          opsCount: 0,
          opTypes: [],
          summary_ru: [`Черновик возвращён к ревизии ${to}`],
        });
        return v;
      }),
    );
    const report = await h.draftG0();
    if (!report.passed)
      throw new RunFailure(
        "GATES_FAILED",
        "Ревизия отката не прошла проверки — превью осталось прежним. Нажмите «Исправить» или выберите другую ревизию.",
      );
    return { summary_ru: `Черновик возвращён к ревизии ${to}`, resultRevision: version };
  }

  const wasLive = await h.once("was_live", () =>
    h.db
      .selectFrom("platform.publications")
      .select("id")
      .where("system_id", "=", sys.id)
      .where("revision", "=", to)
      .where("live_at", "is not", null)
      .executeTakeFirst(),
  );
  if (!wasLive || !target.bundle_key)
    throw new RunFailure(
      "ROLLBACK_TARGET_INVALID",
      "Вернуться можно только к версии, которая уже была опубликована",
    );
  // M2-72: code of an older revision needs columns that an applied destructive change moved to the archive.
  const blocked = await h.once(
    "destructive_after",
    async () => (await rollbackBlockedBy(h.db, sys.id, to)) !== undefined,
  );
  if (blocked) throw new RunFailure("ROLLBACK_TARGET_INVALID", DESTRUCTIVE_RU.rollbackBlocked);
  const bundleKey = target.bundle_key;
  const pub = await h.step("plan_migration", "Готовлю возврат к прежней версии без изменения данных", () =>
    h.tx(async (t) => {
      const cur = await lockSystem(t, sys.id);
      const live = await livePublication(t.trx, sys.id);
      return t.trx
        .insertInto("platform.publications")
        .values({
          system_id: sys.id,
          revision: to,
          schema_revision: cur.schema_hwm_revision ?? to,
          prev_publication_id: live?.id ?? null,
          migration_plan: json({ env: "prod", steps: [], additiveOnly: true, destructive: [], errors: [] }),
          bundle_key: bundleKey,
          status: "planned",
          run_id: h.run.id,
          created_by: h.run.started_by ?? sys.created_by,
        })
        .returning(["id", "prev_publication_id"])
        .executeTakeFirstOrThrow();
    }),
  );
  return guarded(h, pub.id, async () => {
    await switchLive(h, pub.id, to);
    const url = await smoke(h, sys, pub.id, pub.prev_publication_id, to);
    return { summary_ru: `Prod возвращён к ревизии ${to}`, resultRevision: to, prodUrl: url };
  });
}
