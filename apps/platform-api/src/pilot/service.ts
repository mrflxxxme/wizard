// Pilot operations shared by the founder CLI (src/pilot/cli.ts) and the staff console «Пилот» (routes/admin-pilot.ts):
// invitations list / revoke, plan, pilot credits, the org table with the month's spend, the founder-review flag and the
// platform LLM spend of the month vs WIZARD_LLM_MONTHLY_CAP_RUB (M2-15, M2-09; docs/reviews/impl-notes/pilot-admin.md).
// Both front ends format the results; the rules live here, in invites.ts and readiness.ts.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Billing } from "../billing/ledger.js";
import { LLM_CAP_WARN_SHARE, llmSpentRub, moscowMonth } from "../billing/llm-cap.js";
import type { Db } from "../db/index.js";
import { PilotError } from "./invites.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Upper bound of one pilot grant, credits. */
export const PILOT_GRANT_MAX = 100_000;

export interface PilotOrgRef {
  id: string;
  name: string;
  plan: string;
}

/** The org by id or PilotError (NOT_FOUND / VALIDATION_FAILED) with a Russian message. */
export async function findPilotOrg(db: Db, orgId: string): Promise<PilotOrgRef> {
  if (!UUID.test(orgId)) throw new PilotError(`некорректный orgId: ${orgId}`);
  const o = await db
    .selectFrom("platform.orgs")
    .select(["id", "name", "plan"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!o) throw new PilotError(`организация ${orgId} не найдена`, "NOT_FOUND");
  return o;
}

export type PilotInviteStatus = "sent" | "accepted" | "expired";

export interface PilotInviteView {
  id: string;
  email: string;
  orgName: string | null;
  credits: number;
  requireFounderReview: boolean;
  status: PilotInviteStatus;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  orgId: string | null;
}

/** Founder invitations that were not revoked, newest first, with their status at `now`. */
export async function listPilotInvites(db: Db, now: Date = new Date()): Promise<PilotInviteView[]> {
  const rows = await db
    .selectFrom("platform.pilot_invites")
    .select([
      "id",
      "email",
      "org_name",
      "credits",
      "require_founder_review",
      "created_at",
      "expires_at",
      "accepted_at",
      "org_id",
    ])
    .where("revoked_at", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  return rows.map((r) => {
    const expiresAt = new Date(r.expires_at);
    const acceptedAt = r.accepted_at ? new Date(r.accepted_at) : null;
    return {
      id: r.id,
      email: r.email,
      orgName: r.org_name,
      credits: r.credits,
      requireFounderReview: r.require_founder_review,
      status: acceptedAt ? "accepted" : expiresAt <= now ? "expired" : "sent",
      createdAt: new Date(r.created_at),
      expiresAt,
      acceptedAt,
      orgId: r.org_id,
    };
  });
}

/** Revokes the active (not accepted, not revoked) invitation by address or id; null — nothing to revoke. */
export async function revokePilotInvite(
  db: Db,
  by: { email: string } | { id: string },
  now: Date = new Date(),
): Promise<{ id: string } | null> {
  let q = db
    .updateTable("platform.pilot_invites")
    .set({ revoked_at: now })
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null);
  if ("id" in by) {
    if (!UUID.test(by.id)) return null;
    q = q.where("id", "=", by.id);
  } else q = q.where("email", "=", by.email.trim().toLowerCase());
  const row = await q.returning(["id"]).executeTakeFirst();
  return row ?? null;
}

/** `pilot plan`: pilot|free; refused while a paid subscription is active (paid through the shop). */
export async function setPilotPlan(
  db: Db,
  orgId: string,
  plan: "pilot" | "free",
): Promise<{ org: PilotOrgRef; from: string }> {
  const org = await findPilotOrg(db, orgId);
  const sub = await db
    .selectFrom("platform.subscriptions")
    .select("status")
    .where("org_id", "=", org.id)
    .executeTakeFirst();
  if (sub && (sub.status === "active" || sub.status === "past_due"))
    throw new PilotError("у организации есть подписка — сначала отмените её (тариф оплачен через магазин)");
  await db.updateTable("platform.orgs").set({ plan }).where("id", "=", org.id).execute();
  return { org: { ...org, plan }, from: org.plan };
}

/** Pilot credits (ledger pilot_grant:<reference>, 365 days); the same reference grants once. */
export async function grantPilotCredits(
  db: Db,
  billing: Billing,
  g: { orgId: string; credits: number; reference?: string | null; createdBy?: string | null },
): Promise<{ org: PilotOrgRef; granted: boolean; reference: string; availableCredits: number }> {
  if (!Number.isFinite(g.credits) || g.credits <= 0 || g.credits > PILOT_GRANT_MAX)
    throw new PilotError("кредиты — число от 0 до 100 000");
  const org = await findPilotOrg(db, g.orgId);
  const reference = g.reference?.trim() || randomUUID();
  if (reference.length > 200) throw new PilotError("reference: не длиннее 200 символов");
  const granted = await db.transaction().execute((trx) =>
    billing.grantPilot(trx, org.id, {
      credits: g.credits,
      reference,
      ...(g.createdBy ? { createdBy: g.createdBy } : {}),
    }),
  );
  const bal = await billing.readBalance(db, org.id);
  return { org, granted, reference, availableCredits: bal.available / 1000 };
}

/** `pilot review-required` / the console toggle: orgs.require_founder_review (abuse.yaml#identification.founder_review). */
export async function setFounderReviewRequired(
  db: Db,
  orgId: string,
  on: boolean,
): Promise<{ org: PilotOrgRef; requireFounderReview: boolean }> {
  const org = await findPilotOrg(db, orgId);
  await db
    .updateTable("platform.orgs")
    .set({ require_founder_review: on })
    .where("id", "=", org.id)
    .execute();
  return { org, requireFounderReview: on };
}

export interface PilotOrgRow {
  id: string;
  name: string;
  plan: string;
  members: number;
  requireFounderReview: boolean;
  creditsAvailable: number;
  /** Credits charged in the month (charges minus refunds). */
  creditsSpentMonth: number;
  /** Model spend of the org in the month, ₽ (billable live/record llm_calls). */
  modelSpendRub: number;
}

/**
 * Orgs with plan, members, balance and the month's spend (Europe/Moscow month). `pilotOnly` — plan pilot or created
 * by a founder invitation (the console); otherwise every org (the CLI).
 */
export async function pilotOrgs(
  db: Db,
  billing: Billing,
  o: { now?: Date; pilotOnly?: boolean } = {},
): Promise<{ month: string; items: PilotOrgRow[] }> {
  const m = moscowMonth(o.now ?? new Date());
  let q = db
    .selectFrom("platform.orgs as o")
    .select([
      "o.id",
      "o.name",
      "o.plan",
      "o.require_founder_review",
      (eb) =>
        eb
          .selectFrom("platform.memberships as m")
          .select((x) => x.fn.countAll<string>().as("n"))
          .whereRef("m.org_id", "=", "o.id")
          .as("members"),
    ])
    .orderBy("o.created_at");
  if (o.pilotOnly)
    q = q.where((eb) =>
      eb.or([
        eb("o.plan", "=", "pilot"),
        eb.exists(
          eb
            .selectFrom("platform.pilot_invites as pi")
            .select("pi.id")
            .whereRef("pi.org_id", "=", "o.id")
            .where("pi.accepted_at", "is not", null),
        ),
      ]),
    );
  const orgs = await q.execute();
  const items: PilotOrgRow[] = [];
  for (const org of orgs) {
    const bal = await billing.readBalance(db, org.id);
    const charged = await db
      .selectFrom("platform.credit_ledger")
      .select(sql<string>`coalesce(-sum(amount_milli), 0)`.as("milli"))
      .where("org_id", "=", org.id)
      .where("kind", "in", ["charge", "refund"])
      .where("created_at", ">=", m.start)
      .where("created_at", "<", m.end)
      .executeTakeFirstOrThrow();
    items.push({
      id: org.id,
      name: org.name,
      plan: org.plan,
      members: Number(org.members ?? 0),
      requireFounderReview: org.require_founder_review,
      creditsAvailable: bal.available / 1000,
      creditsSpentMonth: Number(charged.milli) / 1000,
      modelSpendRub: await llmSpentRub(db, m.start, m.end, org.id),
    });
  }
  return { month: m.key, items };
}

export interface LlmSpendView {
  /** yyyy-mm (Europe/Moscow). */
  month: string;
  spentRub: number;
  capRub: number;
  /** Whole percent of the cap spent. */
  sharePercent: number;
  /** ≥ 80 % of the cap (the founder warning threshold, LLM_CAP_WARN_SHARE). */
  warn: boolean;
  /** The cap is reached: new LLM runs get 503 LLM_BUDGET_EXHAUSTED. */
  reached: boolean;
}

/** Platform LLM spend of the calendar month vs WIZARD_LLM_MONTHLY_CAP_RUB (billing/llm-cap.ts). */
export async function platformLlmSpend(
  db: Db,
  capRub: number,
  now: Date = new Date(),
): Promise<LlmSpendView> {
  const m = moscowMonth(now);
  const spentRub = await llmSpentRub(db, m.start, m.end);
  return {
    month: m.key,
    spentRub,
    capRub,
    sharePercent: Math.floor((100 * spentRub) / capRub),
    warn: spentRub >= capRub * LLM_CAP_WARN_SHARE,
    reached: spentRub >= capRub,
  };
}
