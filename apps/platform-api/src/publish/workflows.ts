// Workflows publish and rollback (workflows.yaml#workflows.publish, #rollback). The run engine (runs/queue.ts) holds
// the lock and the run lifecycle; these functions are the steps between run_started and the terminal event.
import { dirname } from "node:path";
import { type AppSpec, planMigration } from "@wizard/appspec";
import { publishTelegramBots, type TelegramPublishOptions } from "@wizard/runtime";
import type { Selectable } from "kysely";
import type postgres from "postgres";
import type { Config } from "../config.js";
import { type Db, json } from "../db/index.js";
import type { RunsTable, SystemsTable } from "../db/types.js";
import { appendEvent, type TxCtx } from "../runs/events.js";
import { recordGateReport } from "../runs/gates.js";
import { type GateReport, type GateRunner, RunFailure } from "../runs/types.js";
import { loadManifest, loadRevision, loadSpec, lockSystem, revertRevision } from "../services/revisions.js";
import type { BlobStore } from "../storage/blobs.js";
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
  /** step_started → fn → step_finished, with the cancel check before it. */
  step<T>(name: string, label_ru: string, fn: () => Promise<T>): Promise<T>;
  /** gate_G0 of the draft at draft_revision, with migrate_draft/bundle_and_reload on success (engine #gate). */
  draftG0(): Promise<GateReport>;
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

/** switch: new publication live, previous superseded, prod_revision, hwm (workflows.yaml#workflows.publish). */
async function switchLive(h: FlowHost, publicationId: string, revision: number): Promise<void> {
  await h.step("switch", "Переключаю prod на новую ревизию", () =>
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

/** smoke; on failure prod goes back to prev_publication without DDL and the run fails SMOKE_FAILED. */
async function smoke(
  h: FlowHost,
  sys: System,
  publicationId: string,
  prevId: string | null,
  revision: number,
): Promise<string> {
  const url = prodUrl(h.config, sys.slug);
  const check = h.options.smoke ?? httpSmoke();
  const res = await h.step("smoke", "Проверяю, что prod отвечает", () =>
    check({ slug: sys.slug, systemKey: sys.schema_key, revision, url }),
  );
  if (res.ok) return url;
  await h.tx(async (t) => {
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
  });
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

/** Marks the publication failed when a step throws after plan_migration (unless it already moved on). */
async function guarded<T>(h: FlowHost, publicationId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    await setStatus(h, publicationId, "failed", ["planned", "applying"]).catch(() => {});
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
  const sys = await system(h);
  let rev = Number.isInteger(revision) ? await loadRevision(h.db, sys.id, revision) : undefined;
  if (!rev || !isPublishable(rev, sys.draft_revision))
    throw new RunFailure("GATES_FAILED", "Эта ревизия не прошла проверки — публиковать её нельзя");
  if (!rev.bundle_key) {
    // A style/compliance revision made without a build: the draft gate builds it first (moves the preview too).
    const report = await h.draftG0();
    rev = await loadRevision(h.db, sys.id, revision);
    if (!report.passed || !rev?.bundle_key)
      throw new RunFailure("GATES_FAILED", "Ревизия не прошла проверки — подробности в отчёте G0");
  }
  const bundleKey = rev.bundle_key;
  const spec = rev.spec as unknown as AppSpec;
  const hwm = sys.schema_hwm_revision;
  const prevSpec = hwm !== null ? await loadSpec(h.db, sys, hwm) : null;

  const plan = planMigration(prevSpec, spec, { env: "prod" });
  const pub = await h.step("plan_migration", "Готовлю изменения базы prod", () =>
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
    await h.step("gate_G0_prod", "Проверяю ревизию для prod (G0)", async () => {
      if (!plan.additiveOnly) {
        const what = plan.destructive.map((s) => s.kind).join(", ");
        throw new RunFailure(
          "DESTRUCTIVE_IN_PROD",
          `Публикация заблокирована: изменения удаляют или сужают данные prod (${what}). В prod разрешены только добавления.`,
        );
      }
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
        })),
        level: "G0" as const,
      };
      await h.tx((t) => recordGateReport(t, { runId: h.run.id, systemId: sys.id, revision, report }));
      if (!report.passed)
        throw new RunFailure("GATES_FAILED", "Ревизия не прошла проверки для prod — подробности в отчёте G0");
    });
    await telegramBots(h, sys, revision, spec);
    await h.step("apply_migration", "Применяю изменения базы prod", async () => {
      await setStatus(h, pub.id, "applying", ["planned"]);
      await applyProdMigration(h.pg, {
        systemId: sys.id,
        systemKey: sys.schema_key,
        plan,
        revision,
        publicationId: pub.id,
        options: h.options,
      });
    });
    await switchLive(h, pub.id, revision);
    const url = await smoke(h, sys, pub.id, pub.prev_publication_id, revision);
    return { summary_ru: `Ревизия ${revision} опубликована`, resultRevision: revision, prodUrl: url };
  });
}

export async function runRollback(h: FlowHost): Promise<FlowResult> {
  const input = h.run.input as { env?: unknown; toRevision?: unknown };
  const to = typeof input.toRevision === "number" ? input.toRevision : Number.NaN;
  const sys = await system(h);
  const target = Number.isInteger(to) ? await loadRevision(h.db, sys.id, to) : undefined;
  if (!target) throw new RunFailure("ROLLBACK_TARGET_INVALID", "Такой ревизии нет");

  if (input.env === "draft") {
    const version = await h.step("revert", `Возвращаю черновик к ревизии ${to}`, () =>
      h.tx(async (t) => {
        const v = await revertRevision(t, {
          systemId: sys.id,
          toVersion: to,
          runId: h.run.id,
          authorUserId: h.run.started_by,
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

  const wasLive = await h.db
    .selectFrom("platform.publications")
    .select("id")
    .where("system_id", "=", sys.id)
    .where("revision", "=", to)
    .where("live_at", "is not", null)
    .executeTakeFirst();
  if (!wasLive || !target.bundle_key)
    throw new RunFailure(
      "ROLLBACK_TARGET_INVALID",
      "Откатить prod можно только к ревизии, которая уже была в prod",
    );
  const bundleKey = target.bundle_key;
  const pub = await h.step("plan_migration", "Готовлю откат prod без изменения базы", () =>
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
