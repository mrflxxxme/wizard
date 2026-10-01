// workflows.yaml#retention_cron «Контроль»: a prod system with retention entities and no runtime retention pass for 26 h
// → alert (structured log event retention_overdue, level error — the log pipeline turns it into an alert) and a request
// row in its _w_jobs that the runtime retention tick serves within minutes (runtime.yaml#workflows.retention).
import { quoteIdent, SYSTEM_ROLE } from "@wizard/appspec";
import { RETENTION_MARKER_KEY, RETENTION_REQUEST_KEY, schemaName } from "@wizard/runtime";
import type postgres from "postgres";
import { MIGRATOR_ROLE } from "../agents/draft.js";
import type { Db } from "../db/index.js";

/** Hours without a pass before the alert (daily pass + 2 h slack). */
export const RETENTION_ALERT_HOURS = 26;
const HOUR_MS = 3600_000;

/** Alert sink: one structured event (msg + allowlisted log fields, @wizard/pii/log). */
export type AlertFn = (msg: string, fields: Record<string, string | number | null>) => void;

export interface OverdueSystem {
  systemId: string;
  /** Last pass of the runtime (marker), null when there never was one. */
  lastPassAt: string | null;
  /** A request row was written (false when the prod schema could not be reached). */
  requested: boolean;
}

export interface WatchdogDeps {
  db: Db;
  pg: postgres.Sql;
  migratorRole?: string;
  log?: (msg: string, err?: unknown) => void;
  alert?: AlertFn;
}

/** Live or suspended prod publications whose spec has an entity with retention. */
async function retentionSystems(db: Db): Promise<{ id: string; schema_key: string; live_at: Date | null }[]> {
  const rows = await db
    .selectFrom("platform.publications as p")
    .innerJoin("platform.systems as s", "s.id", "p.system_id")
    .innerJoin("platform.revisions as r", (j) =>
      j.onRef("r.system_id", "=", "p.system_id").onRef("r.version", "=", "p.revision"),
    )
    .select(["s.id", "s.schema_key", "p.live_at", "r.spec"])
    .where("p.env", "=", "prod")
    .where("p.status", "in", ["live", "suspended"])
    .where("s.deleted_at", "is", null)
    .execute();
  return rows
    .filter((r) => {
      const entities = (r.spec as { entities?: { retention?: unknown }[] }).entities ?? [];
      return entities.some((e) => e.retention);
    })
    .map((r) => ({ id: r.id, schema_key: r.schema_key, live_at: r.live_at ? new Date(r.live_at) : null }));
}

/** One check over every prod system with retention; returns the overdue ones (alerted and requested). */
export async function checkRetentionPasses(d: WatchdogDeps, now = new Date()): Promise<OverdueSystem[]> {
  const limit = now.getTime() - RETENTION_ALERT_HOURS * HOUR_MS;
  const out: OverdueSystem[] = [];
  for (const s of await retentionSystems(d.db)) {
    const schema = schemaName(s.schema_key, "prod");
    const jobs = `${quoteIdent(schema)}."_w_jobs"`;
    let lastPassAt: string | null = null;
    let requested = false;
    try {
      requested = await d.pg.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${quoteIdent(d.migratorRole ?? MIGRATOR_ROLE)}`);
        await tx.unsafe("select set_config('wizard.role', $1, true)", [SYSTEM_ROLE]);
        const [m] = await tx.unsafe(`select payload from ${jobs} where idempotency_key = $1`, [
          RETENTION_MARKER_KEY,
        ]);
        const at = Date.parse(String((m?.payload as { at?: unknown } | undefined)?.at ?? ""));
        if (!Number.isNaN(at)) lastPassAt = new Date(at).toISOString();
        // Fresh publication without a pass yet: the runtime has 26 h like everyone else.
        const since = Number.isNaN(at) ? (s.live_at?.getTime() ?? 0) : at;
        if (since >= limit) return false;
        await tx.unsafe(
          `insert into ${jobs} (kind, payload, run_at, locked_until, idempotency_key)
           values ('workflow_step', cast($1::text as jsonb), 'infinity', 'infinity', $2)
           on conflict (idempotency_key) do nothing`,
          [JSON.stringify({ state: "retention_request", at: now.toISOString() }), RETENTION_REQUEST_KEY],
        );
        return true;
      });
      if (!requested) continue;
    } catch (e) {
      // No schema or no _w_jobs: the pass cannot have run either.
      d.log?.("retention watchdog: prod schema unreachable", e);
    }
    const hours = lastPassAt ? Math.floor((now.getTime() - Date.parse(lastPassAt)) / HOUR_MS) : null;
    d.alert?.("retention_overdue", {
      systemId: s.id,
      env: "prod",
      reason: lastPassAt ? "stale_pass" : "no_pass",
      count: hours,
      status: requested ? "requested" : "unreachable",
    });
    out.push({ systemId: s.id, lastPassAt, requested });
  }
  return out;
}
