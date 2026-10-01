// G2 at prod publication (workflows.yaml#workflows.publish.steps.gate_G2, gates.yaml#G2, security/abuse.yaml):
// the GateContext additions read from the platform DB (secretExists, abuse signals, brand allowlist), founder reviews
// (db.yaml#founder_reviews, abuse.yaml#scoring.effect) and the abuse_flag moderation event (gates.yaml#G2.antifraud_rules).
import { secretEnvVar } from "@wizard/connectors";
import { ABUSE, type GateContext, type GateReport } from "@wizard/gates";
import { createLogger } from "@wizard/pii/log";
import { sql } from "kysely";
import type { Db } from "../db/index.js";

const DAY_MS = 86_400_000;

/** G2 warnings that put the revision on founder review before prod (G2-AF-08 risk score, G2-AF-09 ОРИ signal). */
export const FOUNDER_REVIEW_CHECKS: readonly string[] = ["G2-AF-08", "G2-AF-09"];

/** abuse.yaml#messages_ru.review: neutral text while the revision waits for staff. */
export const REVIEW_PENDING_RU =
  ABUSE.messages.review ??
  "Перед публикацией систему посмотрит модератор — обычно это занимает до одного рабочего дня.";
export const REVIEW_REJECTED_RU =
  "Модератор не одобрил публикацию этой версии системы. Внесите правки и опубликуйте новую версию.";

export type FounderReviewStatus = "pending" | "approved" | "rejected";

/** Moderation journal line for a G2 antifraud hit (no texts, no evidence: check ids only). */
export interface AbuseFlag {
  runId: string;
  orgId: string;
  systemId: string;
  revision: number;
  checks: string[];
}

export type ModerationLog = (flag: AbuseFlag) => void;

/** Default journal: a structured `abuse_flag` line of the platform log (Loki; deploy.yaml#cloud.observability). */
export function defaultModerationLog(): ModerationLog {
  const logger = createLogger({ svc: "platform-api" });
  return (f) =>
    logger.warn("abuse_flag", {
      kind: "abuse_flag",
      runId: f.runId,
      orgId: f.orgId,
      systemId: f.systemId,
      revision: f.revision,
      code: f.checks.join(","),
      count: f.checks.length,
    });
}

/**
 * abuse.yaml#scoring signals new_org_lt_7d, free_plan, abuse_reports_prev and #patterns.brands.override
 * (platform.brand_allowlist). Earlier reports are counted once platform.abuse_reports exists (M2-08): reports on
 * the org's systems that staff did not dismiss.
 */
export async function abuseContext(
  db: Db,
  orgId: string,
  now: Date = new Date(),
): Promise<NonNullable<GateContext["abuse"]>> {
  const org = await db
    .selectFrom("platform.orgs")
    .select(["plan", "created_at"])
    .where("id", "=", orgId)
    .executeTakeFirstOrThrow();
  const brands = await db
    .selectFrom("platform.brand_allowlist")
    .select("brand_id")
    .where("org_id", "=", orgId)
    .orderBy("brand_id")
    .execute();
  const out: NonNullable<GateContext["abuse"]> = {
    orgAgeDays: Math.max(0, Math.floor((now.getTime() - new Date(org.created_at).getTime()) / DAY_MS)),
    plan: org.plan,
    brandAllowlist: brands.map((b) => b.brand_id),
  };
  const reports = await abuseReportsPrev(db, orgId);
  if (reports !== null) out.abuseReportsPrev = reports;
  return out;
}

async function abuseReportsPrev(db: Db, orgId: string): Promise<number | null> {
  const t = await sql<{ t: string | null }>`select to_regclass('platform.abuse_reports')::text as t`.execute(
    db,
  );
  if (!t.rows[0]?.t) return null;
  const r = await sql<{ n: number }>`
    select count(*)::int as n
    from platform.abuse_reports ar
    join platform.systems s on s.id = ar.system_id
    where s.org_id = ${orgId} and ar.status <> 'dismissed'`.execute(db);
  return r.rows[0]?.n ?? 0;
}

/**
 * G2-SECRET-02 for prod: the secret is set for the system (db.yaml#secrets_refs, prod or the draft value entered in
 * the chat — one value per system until prod secrets get their own input) or in the runtime env
 * (WIZARD_SECRET_<SYSTEMID>_<NAME>, connectors envSecretReader). The value is never read.
 */
export function secretExistsFor(
  db: Db,
  sys: { id: string; schema_key: string },
  env: NodeJS.ProcessEnv = process.env,
): (name: string) => Promise<boolean> {
  return async (name) => {
    if (env[secretEnvVar(sys.schema_key, name)]) return true;
    const row = await db
      .selectFrom("platform.secrets_refs")
      .select("id")
      .where("system_id", "=", sys.id)
      .where("name", "=", name)
      .where("env", "in", ["prod", "draft"])
      .executeTakeFirst();
    return row !== undefined;
  };
}

/** G2-AF-* checks that failed (gates.yaml#G2.antifraud_rules: abuse_flag into the moderation journal). */
export function abuseFlagChecks(report: GateReport): string[] {
  return [
    ...new Set(
      report.checks.filter((c) => c.id.startsWith("G2-AF-") && c.status === "fail").map((c) => c.id),
    ),
  ];
}

/** G2-AF-08/G2-AF-09 warnings → founder review of this revision (abuse.yaml#scoring.effect, #patterns.ori_signal). */
export function founderReviewChecks(report: GateReport): string[] {
  return [
    ...new Set(
      report.checks
        .filter((c) => FOUNDER_REVIEW_CHECKS.includes(c.id) && c.status === "warn")
        .map((c) => c.id),
    ),
  ];
}

export async function founderReviewStatus(
  db: Db,
  systemId: string,
  revision: number,
): Promise<FounderReviewStatus | null> {
  const r = await db
    .selectFrom("platform.founder_reviews")
    .select("status")
    .where("system_id", "=", systemId)
    .where("revision", "=", revision)
    .executeTakeFirst();
  return r?.status ?? null;
}

/** Puts the revision on review (pending) unless it already has a review; returns the current status. */
export async function requestFounderReview(
  db: Db,
  systemId: string,
  revision: number,
): Promise<FounderReviewStatus> {
  await db
    .insertInto("platform.founder_reviews")
    .values({ system_id: systemId, revision, status: "pending" })
    .onConflict((oc) => oc.columns(["system_id", "revision"]).doNothing())
    .execute();
  return (await founderReviewStatus(db, systemId, revision)) ?? "pending";
}

/**
 * api.yaml#adminFounderReview: staff decision on a revision that waits for review; approve unblocks publishing that
 * revision. false — the revision has no review.
 */
export async function decideFounderReview(
  db: Db,
  a: {
    systemId: string;
    revision: number;
    decision: "approve" | "reject";
    reviewer?: string | null;
    note?: string | null;
  },
): Promise<boolean> {
  const r = await db
    .updateTable("platform.founder_reviews")
    .set({
      status: a.decision === "approve" ? "approved" : "rejected",
      reviewer: a.reviewer ?? null,
      note: a.note ?? null,
      decided_at: new Date(),
    })
    .where("system_id", "=", a.systemId)
    .where("revision", "=", a.revision)
    .executeTakeFirst();
  return Number(r.numUpdatedRows) > 0;
}

/** Reviews waiting for staff, oldest first. */
export async function pendingFounderReviews(db: Db) {
  return db
    .selectFrom("platform.founder_reviews as fr")
    .innerJoin("platform.systems as s", "s.id", "fr.system_id")
    .select(["fr.system_id", "fr.revision", "fr.created_at", "s.org_id", "s.name"])
    .where("fr.status", "=", "pending")
    .orderBy("fr.created_at")
    .execute();
}
