// Platform part of workflows.yaml#retention_cron (M2-05): the deletion journal transfer with owner notices on consent
// withdrawal, control of the runtime retention passes (26 h → alert + request), platform clean-ups and message scrub,
// F5 purge of inactive Free drafts, then delete_system. In-process timer of platform-api (engine inprocess) or the DBOS
// scheduled workflow of apps/worker (wizard.retention_cron, 03:30 MSK).
import type { Mailer } from "../auth/mailer.js";
import { type PurgeDeps, type PurgedSystem, purgeDeletedSystems } from "./delete-system.js";
import { collectDeletionLogs, notifyConsentWithdrawals } from "./deletion-log.js";
import { type FreeDraftReport, purgeInactiveFreeDrafts } from "./free-drafts.js";
import { type HousekeepingReport, runHousekeeping } from "./housekeeping.js";
import { type AlertFn, checkRetentionPasses, type OverdueSystem } from "./watchdog.js";

export interface RetentionCronDeps extends PurgeDeps {
  mailer?: Mailer;
  /** retention_overdue events (default: the error log). */
  alert?: AlertFn;
  /** Platform URL for links in letters. */
  platformOrigin?: string;
}

export interface RetentionCronReport {
  moved: number;
  notices: number;
  overdue: OverdueSystem[];
  housekeeping: HousekeepingReport | null;
  freeDrafts: FreeDraftReport;
  purged: PurgedSystem[];
}

/** Journal transfer of every system schema (and owner notices). */
export async function transferDeletionLogs(
  d: RetentionCronDeps,
): Promise<{ moved: number; notices: number }> {
  const moved = await collectDeletionLogs(d.pg, {
    ...(d.migratorRole ? { migratorRole: d.migratorRole } : {}),
    ...(d.log ? { log: d.log } : {}),
  });
  const notices = d.mailer ? await notifyConsentWithdrawals(d.db, d.mailer, moved, d.log) : 0;
  return { moved: moved.length, notices };
}

/** A step that fails is logged and the pass goes on (each step is idempotent and repeats next pass). */
async function step<T>(d: RetentionCronDeps, name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    d.log?.(`retention_cron: ${name} failed`, e);
    return fallback;
  }
}

/** One full pass (idempotent; safe to repeat after a crash). */
export async function runRetentionCron(d: RetentionCronDeps, now = new Date()): Promise<RetentionCronReport> {
  const t = await transferDeletionLogs(d);
  const alert: AlertFn =
    d.alert ?? ((msg, fields) => d.log?.(msg, { name: "RetentionOverdue", message: JSON.stringify(fields) }));
  const overdue = await step(d, "watchdog", () => checkRetentionPasses({ ...d, alert }, now), []);
  const housekeeping = await step(d, "housekeeping", () => runHousekeeping(d.db, now), null);
  const freeDrafts = await step(d, "free drafts", () => purgeInactiveFreeDrafts(d, now), {
    noticed: [],
    purged: [],
  });
  const purged = await purgeDeletedSystems(d, now);
  return { ...t, overdue, housekeeping, freeDrafts, purged };
}
