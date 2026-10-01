// Platform part of workflows.yaml#retention_cron implemented so far (M2-05): the deletion journal transfer with owner
// notices on consent withdrawal, then delete_system. In-process timer of platform-api (engine inprocess) or the DBOS
// scheduled workflow of apps/worker (wizard.retention_cron, 03:30 MSK).
import type { Mailer } from "../auth/mailer.js";
import { type PurgeDeps, type PurgedSystem, purgeDeletedSystems } from "./delete-system.js";
import { collectDeletionLogs, notifyConsentWithdrawals } from "./deletion-log.js";

export interface RetentionCronDeps extends PurgeDeps {
  mailer?: Mailer;
}

export interface RetentionCronReport {
  moved: number;
  notices: number;
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

/** One full pass (idempotent; safe to repeat after a crash). */
export async function runRetentionCron(d: RetentionCronDeps, now = new Date()): Promise<RetentionCronReport> {
  const t = await transferDeletionLogs(d);
  const purged = await purgeDeletedSystems(d, now);
  return { ...t, purged };
}
