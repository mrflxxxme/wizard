// Prod side of publish/rollback (workflows.yaml#workflows.publish, #rollback): schema migration of app_<key>_prod,
// smoke check of the prod host, URLs and the Publication API shape.
import { request } from "node:http";
import { describeStep, type MigrationPlan, quoteIdent, toDDL } from "@wizard/appspec";
import { schemaName } from "@wizard/runtime";
import type { Selectable } from "kysely";
import type postgres from "postgres";
import { MIGRATOR_ROLE, RUNTIME_ROLE } from "../agents/draft.js";
import type { Config } from "../config.js";
import type { PublicationsTable } from "../db/types.js";
import { RunFailure } from "../runs/types.js";

/** Prod host of a system in M1 (local/staging, deploy.yaml#local.hosts.systems; public prod — M2-07). */
export function prodUrl(config: Pick<Config, "runtimePort">, slug: string): string {
  return `http://${slug}.localhost:${config.runtimePort}/`;
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
}

function get(url: URL, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // *.localhost is not resolvable everywhere: connect to loopback and send the system host explicitly.
    const req = request(
      {
        host: "127.0.0.1",
        port: url.port || 80,
        path: url.pathname + url.search,
        agent: false,
        headers: { host: url.host },
        timeout: timeoutMs,
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

/** Default smoke: the page answers 200 and /_wizard/health of the system host reports the new revision. */
export function httpSmoke(timeoutMs = 5000): ProdSmoke {
  return async (i) => {
    try {
      const base = new URL(i.url);
      const page = await get(new URL("/", base), timeoutMs);
      if (page.status !== 200) return { ok: false, reason: `GET / → ${page.status}` };
      const health = await get(new URL("/_wizard/health", base), timeoutMs);
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
  const ddl = toDDL(a.plan, schema, { runtimeRole: o.runtimeRole ?? RUNTIME_ROLE, lockTimeout: "3s" });
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
