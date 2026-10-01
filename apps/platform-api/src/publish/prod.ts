// Prod side of publish/rollback (workflows.yaml#workflows.publish, #rollback): schema migration of app_<key>_prod,
// smoke check of the prod host, URLs and the Publication API shape.
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { describeStep, type MigrationPlan, quoteIdent, toDDL } from "@wizard/appspec";
import { ensureSystemRole, schemaName, type TelegramPublishOptions } from "@wizard/runtime";
import type { Selectable } from "kysely";
import type postgres from "postgres";
import { MIGRATOR_ROLE, RUNTIME_ROLE } from "../agents/draft.js";
import { upgradeSystemTables } from "../agents/system-tables.js";
import type { Config } from "../config.js";
import type { PublicationsTable } from "../db/types.js";
import { RunFailure } from "../runs/types.js";
import type { ModerationLog } from "./moderation.js";

type HostConfig = Pick<Config, "runtimePort"> & Partial<Pick<Config, "systemsDomain" | "publicScheme">>;

/**
 * Origin of a system host (deploy.yaml#local.hosts.systems, #cloud.domains.system_host): locally
 * http://<slug>[--draft].localhost:<runtimePort>; in the cloud <scheme>://<slug>[--draft].<systemsDomain>.
 */
export function systemOrigin(config: HostConfig, slug: string, env: "draft" | "prod"): string {
  const label = env === "draft" ? `${slug}--draft` : slug;
  const domain = config.systemsDomain ?? "localhost";
  if (domain === "localhost") return `http://${label}.localhost:${config.runtimePort}`;
  return `${config.publicScheme ?? "https"}://${label}.${domain}`;
}

/** Canonical prod URL of a system (runtime.yaml#routing.prod_alias). */
export function prodUrl(config: HostConfig, slug: string): string {
  return `${systemOrigin(config, slug, "prod")}/`;
}

export interface SmokeInput {
  slug: string;
  systemKey: string;
  revision: number;
  url: string;
}
export type SmokeResult = { ok: true } | { ok: false; reason: string };
/** workflows.yaml#workflows.publish.steps.smoke: GET prod-URL → 200 and health reports the revision. */
export type ProdSmoke = (i: SmokeInput) => Promise<SmokeResult>;

export interface PublishOptions {
  /** Smoke check after switch (default: HTTP to the local runtime, httpSmoke). */
  smoke?: ProdSmoke;
  migratorRole?: string;
  runtimeRole?: string;
  /** Pauses between apply_migration attempts on lock_timeout (default 5/15/45 s). */
  lockRetryDelaysMs?: number[];
  /**
   * Own Telegram bots at publication (telegram.yaml#bot_api getMe/setWebhook, FU-6). Default: live with
   * WIZARD_CONNECTORS=live, otherwise outbox (calls recorded in .data/outbox/<systemKey>/telegram.jsonl).
   */
  telegram?: TelegramPublishOptions;
  /** Moderation journal of G2 antifraud hits (abuse_flag; default: a structured platform log line). */
  moderationLog?: ModerationLog;
}

function get(url: URL, timeoutMs: number, hostHeader?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // *.localhost is not resolvable everywhere: connect to loopback and send the system host explicitly.
    const local = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
    const tls = url.protocol === "https:";
    const req = (tls ? httpsRequest : request)(
      {
        host: local ? "127.0.0.1" : url.hostname,
        port: url.port || (tls ? 443 : 80),
        path: url.pathname + url.search,
        agent: false,
        headers: { host: hostHeader ?? url.host },
        timeout: timeoutMs,
        ...(tls ? { servername: url.hostname } : {}),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          if (body.length < 65_536) body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Default smoke: the page answers 200 and /_wizard/health of the system host reports the new revision. With
 * internalUrl (cloud) the health comes from the runtime's internal port with the system Host: public hosts answer
 * only {status} there (L3-19).
 */
export function httpSmoke(timeoutMs = 5000, o: { internalUrl?: string | null } = {}): ProdSmoke {
  return async (i) => {
    try {
      const base = new URL(i.url);
      const page = await get(new URL("/", base), timeoutMs);
      if (page.status !== 200) return { ok: false, reason: `GET / → ${page.status}` };
      const health = o.internalUrl
        ? await get(new URL("/_wizard/health", o.internalUrl), timeoutMs, base.host)
        : await get(new URL("/_wizard/health", base), timeoutMs);
      const rev = (JSON.parse(health.body || "{}") as { revision?: unknown }).revision;
      if (health.status !== 200 || rev !== i.revision)
        return { ok: false, reason: `health → ${health.status}, revision ${String(rev)}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** migration_plan as stored in platform.publications (architecture.yaml#interfaces.migration_plan without `next`). */
export function storedPlan(
  plan: Pick<MigrationPlan, "env" | "steps" | "additiveOnly" | "destructive" | "errors">,
) {
  return {
    env: plan.env,
    additiveOnly: plan.additiveOnly,
    steps: plan.steps.map((s) => ({ kind: s.kind, destructive: s.destructive, text: describeStep(s) })),
    destructive: plan.destructive.map(describeStep),
    errors: plan.errors,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * apply_migration: toDDL + toRLS in app_<key>_prod as the migrator role, one transaction with lock_timeout 3 s,
 * retried on lock_timeout. The schema high-water mark is moved in the same transaction: db.yaml defines it as the
 * revision whose schema is actually applied, so a crash before switch leaves a consistent, additively extended schema.
 */
export async function applyProdMigration(
  pg: postgres.Sql,
  a: {
    systemId: string;
    systemKey: string;
    plan: MigrationPlan;
    revision: number;
    publicationId: string;
    options?: PublishOptions;
  },
): Promise<void> {
  const o = a.options ?? {};
  const schema = schemaName(a.systemKey, "prod");
  const runtimeRole = o.runtimeRole ?? RUNTIME_ROLE;
  // System access = DB role sys_<key>_prod_system (isolation.yaml#db_access, L3-20), created before the DDL.
  const systemRole = await ensureSystemRole(pg, a.systemKey, "prod", [runtimeRole]);
  const ddl = toDDL(a.plan, schema, { runtimeRole, systemRole, lockTimeout: "3s" });
  // An existing prod schema may predate system tables/columns of the current runtime (before set_rls touches them);
  // create_schema over a leftover schema creates missing tables itself but not missing columns.
  if (a.plan.steps.some((s) => s.kind === "create_schema")) ddl.push(...upgradeSystemTables(schema));
  else ddl.unshift(...upgradeSystemTables(schema));
  const delays = o.lockRetryDelaysMs ?? [5000, 15_000, 45_000];
  for (let attempt = 0; ; attempt++) {
    try {
      await pg.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(o.migratorRole ?? MIGRATOR_ROLE)}`);
        for (const st of ddl) await tx.unsafe(st);
        await tx.unsafe("SET LOCAL ROLE NONE");
        await tx`
          update platform.systems
             set schema_hwm_revision = greatest(coalesce(schema_hwm_revision, 0), ${a.revision}::int),
                 updated_at = now()
           where id = ${a.systemId}`;
        await tx`
          update platform.publications p
             set schema_revision = s.schema_hwm_revision
            from platform.systems s
           where p.id = ${a.publicationId} and s.id = p.system_id`;
      });
      return;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      const wait = delays[attempt];
      if (code === LOCK_NOT_AVAILABLE && wait !== undefined) {
        await sleep(wait);
        continue;
      }
      throw new RunFailure(
        "MIGRATION_FAILED",
        code === LOCK_NOT_AVAILABLE
          ? "База prod занята — миграция не применена. Попробуйте опубликовать позже."
          : `Не удалось применить миграцию prod${code ? ` (${code})` : ""}. Данные не изменены.`,
        true,
      );
    }
  }
}

/** api.yaml#/components/schemas/Publication */
export function toPublication(p: Selectable<PublicationsTable>) {
  const plan = (p.migration_plan ?? {}) as { steps?: unknown[] };
  return {
    id: p.id,
    env: "prod" as const,
    revision: p.revision,
    schemaRevision: p.schema_revision,
    status: p.status,
    migrationSteps: Array.isArray(plan.steps) ? plan.steps.length : 0,
    createdAt: new Date(p.created_at).toISOString(),
  };
}
