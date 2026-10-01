// workflows.yaml#retention_cron «Платформенная уборка» and «messages» (db.yaml retention of auth_otps, run_events,
// gate_reports, messages; L3-09). Imports/exports after expires_at are swept hourly elsewhere (imports/ttl, exports),
// dbos.* by the worker's dbos_retention; abuse_reports.contact_email one year after the ticket closed (M2-08).
import { scrub } from "@wizard/pii";
import { purgeAbuseContacts } from "../abuse/reports.js";
import type { Db } from "../db/index.js";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** db.yaml#auth_otps.retention. */
export const OTP_RETENTION_HOURS = 24;
/** db.yaml#run_events.retention, #gate_reports.retention. */
export const RUN_HISTORY_DAYS = 180;
/** db.yaml#messages.retention: after systems.last_activity_at. */
export const MESSAGE_SCRUB_DAYS = 180;
const SCRUB_BATCH = 500;

export interface HousekeepingReport {
  otps: number;
  runEvents: number;
  gateReports: number;
  /** Reporter e-mails of abuse reports closed more than a year ago (db.yaml#abuse_reports.contact_email). */
  abuseContacts: number;
  /** User messages whose text changed after scrub. */
  messagesScrubbed: number;
}

/** OTP codes, run events and old gate reports (the latest one per system and level stays). */
export async function cleanPlatformTables(
  db: Db,
  now: Date,
): Promise<Omit<HousekeepingReport, "messagesScrubbed">> {
  const otps = await db
    .deleteFrom("platform.auth_otps")
    .where("created_at", "<", new Date(now.getTime() - OTP_RETENTION_HOURS * HOUR_MS))
    .executeTakeFirst();
  const old = new Date(now.getTime() - RUN_HISTORY_DAYS * DAY_MS);
  const runEvents = await db.deleteFrom("platform.run_events").where("ts", "<", old).executeTakeFirst();
  // GET /systems/:id/gates/latest reads the row with max(revision) per (system_id, level): never deleted.
  const gateReports = await db
    .deleteFrom("platform.gate_reports as g")
    .where("g.created_at", "<", old)
    .where(({ eb, selectFrom }) =>
      eb(
        "g.revision",
        "<",
        selectFrom("platform.gate_reports as l")
          .select(({ fn }) => fn.max("l.revision").as("m"))
          .whereRef("l.system_id", "=", "g.system_id")
          .whereRef("l.level", "=", "g.level"),
      ),
    )
    .executeTakeFirst();
  return {
    otps: Number(otps.numDeletedRows),
    runEvents: Number(runEvents.numDeletedRows),
    gateReports: Number(gateReports.numDeletedRows),
    abuseContacts: await purgeAbuseContacts(db, now),
  };
}

/**
 * Scrub (packages/pii) of the raw user text in chats of systems inactive for 180 days. Idempotent: placeholders survive
 * a second scrub, only changed rows are written, so the next pass rereads but does not rewrite them.
 */
export async function scrubInactiveMessages(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - MESSAGE_SCRUB_DAYS * DAY_MS);
  let changed = 0;
  let after = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await db
      .selectFrom("platform.messages as m")
      .innerJoin("platform.systems as s", "s.id", "m.system_id")
      .select(["m.id", "m.text"])
      .where("s.last_activity_at", "<", cutoff)
      .where("m.role", "=", "user")
      .where("m.kind", "=", "text")
      .where("m.text", "is not", null)
      .where("m.id", ">", after)
      .orderBy("m.id")
      .limit(SCRUB_BATCH)
      .execute();
    for (const r of rows) {
      const text = r.text ?? "";
      const out = scrub(text).text;
      if (out === text) continue;
      await db.updateTable("platform.messages").set({ text: out }).where("id", "=", r.id).execute();
      changed++;
    }
    const last = rows.at(-1);
    if (!last || rows.length < SCRUB_BATCH) break;
    after = last.id;
  }
  return changed;
}

/** Both platform clean-ups of the pass. */
export async function runHousekeeping(db: Db, now: Date): Promise<HousekeepingReport> {
  const t = await cleanPlatformTables(db, now);
  return { ...t, messagesScrubbed: await scrubInactiveMessages(db, now) };
}
