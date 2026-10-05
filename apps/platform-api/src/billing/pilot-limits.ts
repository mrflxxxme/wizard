// Pilot limit of an organization (product.yaml#decisions.D70_pilot_free_limits, billing.yaml#rub_model.pilot_limit):
// 5 builds and 20 edits in a rolling 30 days; the client sees «На пилоте бесплатно» and what is left in words, never
// credits (credits stay the internal guard of ledger.ts). A build is a build run of mode create (a new system or a
// full rebuild from the card), an edit — mode change or point_edit; fix runs, failed and cancelled runs do not count,
// active ones do. Only orgs on plan «pilot» are limited; the founder raises a limit in /admin (orgs.pilot_*_limit).
import { sql, type Transaction } from "kysely";
import type { DB, Db } from "../db/index.js";
import { ApiError } from "../errors.js";

export const PILOT_WINDOW_DAYS = 30;
export const PILOT_BUILDS_DEFAULT = 5;
export const PILOT_EDITS_DEFAULT = 20;
/** Upper bound of a limit the founder may set. */
export const PILOT_LIMIT_MAX = 1000;

const DAY_MS = 86_400_000;
const BUILD_MODES = ["create"] as const;
const EDIT_MODES = ["change", "point_edit"] as const;

export type PilotKind = "builds" | "edits";

/** Kind of a build run by its mode; null — not limited (fix, other kinds). */
export function pilotKindOf(mode: string | null | undefined): PilotKind | null {
  if ((BUILD_MODES as readonly string[]).includes(mode ?? "")) return "builds";
  if ((EDIT_MODES as readonly string[]).includes(mode ?? "")) return "edits";
  return null;
}

export interface PilotCounter {
  /** null — the org is not limited (not on the pilot plan). */
  limit: number | null;
  used: number;
  /** limit − used, ≥ 0; null when not limited. */
  left: number | null;
  /** When the next one frees up (only when left = 0). */
  nextAt: Date | null;
}

export interface PilotUsage {
  pilot: boolean;
  builds: PilotCounter;
  edits: PilotCounter;
}

/** «6 ноября» in Moscow time. */
export const ruDate = (d: Date): string =>
  d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Moscow" });

const LIMIT_RU: Record<PilotKind, (limit: number, next: string | null) => string> = {
  builds: (limit, next) =>
    `На пилоте можно запустить ${limit} ${plural(limit, "сборку", "сборки", "сборок")} за 30 дней, и они закончились.${next ? ` Следующая станет доступна ${next}.` : ""} Если нужно раньше, напишите команде: поднимем лимит.`,
  edits: (limit, next) =>
    `На пилоте можно сделать ${limit} ${plural(limit, "правку", "правки", "правок")} за 30 дней, и они закончились.${next ? ` Следующая станет доступна ${next}.` : ""} Если нужно раньше, напишите команде: поднимем лимит.`,
};

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

type Reader = Db | Transaction<DB>;

function counter(limit: number | null, times: Date[]): PilotCounter {
  const used = times.length;
  if (limit === null) return { limit: null, used, left: null, nextAt: null };
  const left = Math.max(0, limit - used);
  // The (used − limit + 1)-th oldest counted run leaves the window first.
  const oldest = left === 0 ? times[used - limit] : undefined;
  return {
    limit,
    used,
    left,
    nextAt: oldest ? new Date(oldest.getTime() + PILOT_WINDOW_DAYS * DAY_MS) : null,
  };
}

/** Usage of an org in the window ending at `now`. */
export async function pilotUsage(db: Reader, orgId: string, now: Date): Promise<PilotUsage> {
  const org = await db
    .selectFrom("platform.orgs")
    .select(["plan", "pilot_builds_limit", "pilot_edits_limit"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  const pilot = org?.plan === "pilot";
  const since = new Date(now.getTime() - PILOT_WINDOW_DAYS * DAY_MS);
  const rows = await db
    .selectFrom("platform.runs")
    .select(["mode", "created_at"])
    .where("org_id", "=", orgId)
    .where("kind", "=", "build")
    .where("mode", "in", [...BUILD_MODES, ...EDIT_MODES])
    .where("status", "not in", ["failed", "cancelled"])
    .where("created_at", ">", since)
    .orderBy("created_at")
    .execute();
  const times = (k: PilotKind) =>
    rows.filter((r) => pilotKindOf(r.mode) === k).map((r) => new Date(r.created_at));
  return {
    pilot,
    builds: counter(pilot ? (org?.pilot_builds_limit ?? PILOT_BUILDS_DEFAULT) : null, times("builds")),
    edits: counter(pilot ? (org?.pilot_edits_limit ?? PILOT_EDITS_DEFAULT) : null, times("edits")),
  };
}

/**
 * Before inserting a build run (same transaction): 402 BUILDS_LIMIT / EDITS_LIMIT with {limit, used, nextAt} when the
 * pilot org has nothing left. Serialized per org by the caller's org lock (Billing.lock).
 */
export async function assertPilotLimit(
  trx: Transaction<DB>,
  o: { orgId: string; mode: string | null | undefined; now: Date },
): Promise<void> {
  const kind = pilotKindOf(o.mode);
  if (!kind) return;
  await sql`SELECT pg_advisory_xact_lock(hashtext(${`pilot:${o.orgId}`}::text))`.execute(trx);
  const u = await pilotUsage(trx, o.orgId, o.now);
  const c = u[kind];
  if (c.limit === null || (c.left ?? 0) > 0) return;
  throw new ApiError(
    kind === "builds" ? "BUILDS_LIMIT" : "EDITS_LIMIT",
    LIMIT_RU[kind](c.limit, c.nextAt ? ruDate(c.nextAt) : null),
    {
      limit: c.limit,
      used: c.used,
      nextAt: c.nextAt?.toISOString() ?? null,
    },
  );
}

/** /admin: sets the org's limits (null — back to the default). */
export async function setPilotLimits(
  db: Db,
  orgId: string,
  l: { builds?: number | null | undefined; edits?: number | null | undefined },
): Promise<{ builds: number; edits: number } | null> {
  const set: { pilot_builds_limit?: number | null; pilot_edits_limit?: number | null } = {};
  if (l.builds !== undefined) set.pilot_builds_limit = l.builds;
  if (l.edits !== undefined) set.pilot_edits_limit = l.edits;
  const q = db.updateTable("platform.orgs").where("id", "=", orgId);
  const row = await (Object.keys(set).length > 0 ? q.set(set) : q.set({ id: orgId }))
    .returning(["pilot_builds_limit", "pilot_edits_limit"])
    .executeTakeFirst();
  if (!row) return null;
  return {
    builds: row.pilot_builds_limit ?? PILOT_BUILDS_DEFAULT,
    edits: row.pilot_edits_limit ?? PILOT_EDITS_DEFAULT,
  };
}

/** api.yaml#PilotUsage (client view: no credits). */
export function usageView(u: PilotUsage): Record<string, unknown> {
  const c = (x: PilotCounter) => ({
    limit: x.limit,
    used: x.used,
    left: x.left,
    nextAt: x.nextAt?.toISOString() ?? null,
  });
  return { pilot: u.pilot, free: u.pilot, builds: c(u.builds), edits: c(u.edits) };
}
