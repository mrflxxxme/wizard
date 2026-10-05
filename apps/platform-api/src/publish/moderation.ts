// G2 at prod publication (workflows.yaml#workflows.publish.steps.gate_G2, gates.yaml#G2, security/abuse.yaml):
// the GateContext additions read from the platform DB (secretExists, abuse signals, brand allowlist), founder reviews
// (db.yaml#founder_reviews, abuse.yaml#scoring.effect) and the abuse_flag moderation event (gates.yaml#G2.antifraud_rules).
import type { AppSpec } from "@wizard/appspec";
import { newEgressHosts, secretEnvVar, specEgressHosts } from "@wizard/connectors";
import { ABUSE, type GateContext, type GateReport } from "@wizard/gates";
import { createLogger } from "@wizard/pii/log";
import { sql } from "kysely";
import type { Mailer } from "../auth/mailer.js";
import type { Db } from "../db/index.js";

const DAY_MS = 86_400_000;

/**
 * G2 warnings that put the revision on founder review before prod (G2-AF-08 risk score, G2-AF-09 ОРИ signal, M2-52
 * G2-EGRESS-02 new hosts of outgoing requests).
 */
export const FOUNDER_REVIEW_CHECKS: readonly string[] = ["G2-AF-08", "G2-AF-09", "G2-EGRESS-02"];

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
 * (platform.brand_allowlist). Earlier reports (M2-08): reports on the org's systems that staff did not dismiss; the
 * owner's own «Оспорить» tickets (category auto_g2) are not complaints and do not count.
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
  const reports = await sql<{ n: number }>`
    select count(*)::int as n
    from platform.abuse_reports ar
    join platform.systems s on s.id = ar.system_id
    where s.org_id = ${orgId} and ar.status <> 'dismissed' and ar.category <> 'auto_g2'`.execute(db);
  return {
    orgAgeDays: Math.max(0, Math.floor((now.getTime() - new Date(org.created_at).getTime()) / DAY_MS)),
    plan: org.plan,
    brandAllowlist: brands.map((b) => b.brand_id),
    abuseReportsPrev: reports.rows[0]?.n ?? 0,
  };
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

/** abuse.yaml#messages_ru.ORG_SUSPENDED (api.yaml ORG_SUSPENDED 403). */
export const ORG_SUSPENDED_RU =
  ABUSE.messages.ORG_SUSPENDED ??
  "Публикации организации приостановлены. Подробности — в письме владельцу; оспорить решение можно ответом на это письмо.";

/** orgs.suspended_at is set (abuse.yaml#takedown.flow): publishBlockers ORG_SUSPENDED, POST publish → 403. */
export async function orgSuspended(db: Db, orgId: string): Promise<boolean> {
  const o = await db
    .selectFrom("platform.orgs")
    .select("suspended_at")
    .where("id", "=", orgId)
    .executeTakeFirst();
  return !!o?.suspended_at;
}

/** E-mails of the active owners of an org (letters about moderation decisions). */
export async function orgOwnerEmails(db: Db, orgId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("platform.memberships as m")
    .innerJoin("platform.users as u", "u.id", "m.user_id")
    .select("u.email")
    .where("m.org_id", "=", orgId)
    .where("m.role", "=", "owner")
    .where("u.deleted_at", "is", null)
    .execute();
  return rows.map((r) => r.email);
}

/** Where the owner learns about the founder's decision (platform mail; failures are logged, never thrown). */
export interface ReviewNotice {
  mailer: Mailer;
  platformOrigin: string;
  log?: ((msg: string, err?: unknown) => void) | undefined;
}

/** Russian letter to the owner about the decision (the staff note is meant for the owner: «что исправить»). */
export function founderReviewLetter(a: {
  systemName: string;
  revision: number;
  decision: "approve" | "reject";
  note?: string | null;
  link: string;
}): { subject: string; text: string } {
  if (a.decision === "approve")
    return {
      subject: `Система «${a.systemName}» одобрена к публикации`,
      text: [
        `Модератор Born to Build проверил ревизию ${a.revision} системы «${a.systemName}» и одобрил её публикацию.`,
        `Теперь её можно опубликовать: откройте систему и нажмите «Опубликовать» — ${a.link}`,
        ...(a.note ? [`Комментарий модератора: ${a.note}`] : []),
      ].join("\n"),
    };
  return {
    subject: `Публикация системы «${a.systemName}» не одобрена`,
    text: [
      `Модератор Born to Build не одобрил публикацию ревизии ${a.revision} системы «${a.systemName}».`,
      `Что исправить: ${a.note ?? "—"}`,
      `Внесите правки в чате и опубликуйте новую версию — ${a.link}`,
      "Если вы не согласны с решением, ответьте на это письмо.",
    ].join("\n"),
  };
}

/**
 * api.yaml#adminFounderReview: staff decision on a revision that waits for review; approve unblocks publishing that
 * revision. With `notice` every owner of the org gets the decision by mail (approved / rejected with the note).
 * false — the revision has no review.
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
  notice?: ReviewNotice,
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
  const ok = Number(r.numUpdatedRows) > 0;
  if (ok && notice) {
    try {
      const sys = await db
        .selectFrom("platform.systems")
        .select(["name", "org_id"])
        .where("id", "=", a.systemId)
        .executeTakeFirstOrThrow();
      const letter = founderReviewLetter({
        systemName: sys.name,
        revision: a.revision,
        decision: a.decision,
        note: a.note ?? null,
        link: `${notice.platformOrigin.replace(/\/+$/, "")}/s/${a.systemId}`,
      });
      for (const to of await orgOwnerEmails(db, sys.org_id))
        await notice.mailer.send({ kind: "notice", to, ...letter });
    } catch (e) {
      notice.log?.("founder review notice failed", e);
    }
  }
  return ok;
}

/**
 * Reviews waiting for staff, oldest first, with the outgoing-request hosts of the revision (M2-52, D71: the founder
 * sees every host before prod) and the ones the published revision did not have.
 */
export async function pendingFounderReviews(db: Db) {
  const rows = await db
    .selectFrom("platform.founder_reviews as fr")
    .innerJoin("platform.systems as s", "s.id", "fr.system_id")
    .leftJoin("platform.revisions as r", (j) =>
      j.onRef("r.system_id", "=", "fr.system_id").onRef("r.version", "=", "fr.revision"),
    )
    .leftJoin("platform.revisions as p", (j) =>
      j.onRef("p.system_id", "=", "fr.system_id").onRef("p.version", "=", "s.prod_revision"),
    )
    .select([
      "fr.system_id",
      "fr.revision",
      "fr.created_at",
      "s.org_id",
      "s.name",
      "r.spec as spec",
      "p.spec as prod_spec",
    ])
    .where("fr.status", "=", "pending")
    .orderBy("fr.created_at")
    .execute();
  return rows.map(({ spec, prod_spec, ...x }) => {
    const rev = (spec as unknown as AppSpec | null) ?? null;
    const prod = (prod_spec as unknown as AppSpec | null) ?? null;
    return {
      ...x,
      egress_hosts: rev ? specEgressHosts(rev) : [],
      new_egress_hosts: rev ? newEgressHosts(rev, prod) : [],
    };
  });
}

/** Line of the founder alert listing the revision's egress hosts (empty when it has none). */
export function egressHostsNote(spec: AppSpec, prodSpec: AppSpec | null): string {
  const all = specEgressHosts(spec);
  if (all.length === 0) return "";
  const fresh = newEgressHosts(spec, prodSpec);
  return ` Внешние запросы функций: ${all.join(", ")}${fresh.length ? ` (новые: ${fresh.join(", ")})` : ""}.`;
}

/**
 * Why a revision needs the founder's approval before prod regardless of G2 (abuse.yaml#identification.founder_review,
 * M2-09): first_publication — the system has never been live in prod; new_pd_fields — the revision adds personal-data
 * fields (forms that collect ПДн) the prod schema did not have.
 */
export type FounderReviewReason = "first_publication" | "new_pd_fields" | "new_egress_hosts";

export const FOUNDER_REVIEW_REASON_RU: Record<FounderReviewReason, string> = {
  first_publication: "первая публикация системы",
  new_pd_fields: "новые поля с персональными данными",
  new_egress_hosts: "новые адреса внешних запросов",
};

/** entity.field of every field with a personal-data category (AppSpec field.pii ≠ none). */
export function pdFields(spec: AppSpec | null): Set<string> {
  const out = new Set<string>();
  for (const e of spec?.entities ?? [])
    for (const f of e.fields) if ((f.pii ?? "none") !== "none") out.add(`${e.name}.${f.name}`);
  return out;
}

/**
 * M2-09: the founder review rule of the org (orgs.require_founder_review) under the platform switch
 * (config.founderReviewRequired). `prodSpec` — the schema prod already has (schema high-water mark), null — none.
 */
export async function founderReviewReason(
  db: Db,
  a: { systemId: string; orgId: string; spec: AppSpec; prodSpec: AppSpec | null; required: boolean },
): Promise<FounderReviewReason | null> {
  if (!a.required) return null;
  const org = await db
    .selectFrom("platform.orgs")
    .select("require_founder_review")
    .where("id", "=", a.orgId)
    .executeTakeFirst();
  if (!org?.require_founder_review) return null;
  const live = await db
    .selectFrom("platform.publications")
    .select("id")
    .where("system_id", "=", a.systemId)
    .where("live_at", "is not", null)
    .executeTakeFirst();
  if (!live) return "first_publication";
  const before = pdFields(a.prodSpec);
  for (const f of pdFields(a.spec)) if (!before.has(f)) return "new_pd_fields";
  // M2-52 (G2-EGRESS-02): a host the published revision did not call.
  if (newEgressHosts(a.spec, a.prodSpec).length > 0) return "new_egress_hosts";
  return null;
}
