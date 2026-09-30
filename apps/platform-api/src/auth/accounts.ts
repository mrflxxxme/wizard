// Users, personal organizations and plan limits of members (billing.yaml#plans.*.limits.members).
import type { Transaction } from "kysely";
import type { DB, Db } from "../db/index.js";

export type OrgRole = "owner" | "editor" | "viewer";
export const ROLE_RANK: Record<OrgRole, number> = { viewer: 1, editor: 2, owner: 3 };
export const ROLE_RU: Record<OrgRole, string> = {
  owner: "владелец",
  editor: "редактор",
  viewer: "наблюдатель",
};

/** Current version of the platform offer (compliance.yaml#platform.rules: a new version → accept again). */
export const OFFER_VERSION = "draft-2026-09";

/** Name of the organization created at the first sign-in (the user renames it in S10). */
export const PERSONAL_ORG_NAME = "Моя организация";

export const MEMBER_LIMITS: Record<string, number> = { free: 3, start: 10, business: 30 };

export interface Membership {
  orgId: string;
  orgName: string;
  role: OrgRole;
}

export async function memberships(db: Db, userId: string): Promise<Membership[]> {
  const rows = await db
    .selectFrom("platform.memberships as m")
    .innerJoin("platform.orgs as o", "o.id", "m.org_id")
    .select(["m.org_id", "o.name", "m.role"])
    .where("m.user_id", "=", userId)
    .orderBy("m.created_at")
    .orderBy("m.org_id")
    .execute();
  return rows.map((r) => ({ orgId: r.org_id, orgName: r.name, role: r.role }));
}

/**
 * Creates the user if needed (with consents when given); a user without organizations gets a personal one as
 * owner (Free, region unknown → T0 until determined, data-boundary.yaml#region_restriction.fail_safe).
 */
export async function ensureUser(
  trx: Transaction<DB>,
  email: string,
  consents: { offer: boolean; pd: boolean },
): Promise<{ id: string; email: string; name: string | null; is_staff: boolean; created: boolean }> {
  const now = new Date();
  let user = await trx
    .selectFrom("platform.users")
    .select(["id", "email", "name", "is_staff"])
    .where("email", "=", email)
    .where("deleted_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
  let created = false;
  if (!user) {
    user = await trx
      .insertInto("platform.users")
      .values({ email })
      .returning(["id", "email", "name", "is_staff"])
      .executeTakeFirstOrThrow();
    created = true;
  }
  if (consents.offer)
    await trx
      .updateTable("platform.users")
      .set({ offer_accepted_at: now, offer_version: OFFER_VERSION })
      .where("id", "=", user.id)
      .execute();
  if (consents.pd)
    await trx.updateTable("platform.users").set({ pd_consent_at: now }).where("id", "=", user.id).execute();
  const any = await trx
    .selectFrom("platform.memberships")
    .select("org_id")
    .where("user_id", "=", user.id)
    .executeTakeFirst();
  if (!any) {
    const org = await trx
      .insertInto("platform.orgs")
      .values({ name: PERSONAL_ORG_NAME, region_code: null })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("platform.memberships")
      .values({ org_id: org.id, user_id: user.id, role: "owner" })
      .execute();
  }
  return { ...user, created };
}

/** Row lock of the org: serializes membership/invite changes (LAST_OWNER, PLAN_LIMIT; db.yaml#memberships). */
export async function lockOrg(trx: Transaction<DB>, orgId: string) {
  return trx
    .selectFrom("platform.orgs")
    .select(["id", "name", "plan"])
    .where("id", "=", orgId)
    .forUpdate()
    .executeTakeFirst();
}

/** Members plus active invites — both count against the plan limit. */
export async function seatsUsed(trx: Transaction<DB>, orgId: string): Promise<number> {
  const m = await trx
    .selectFrom("platform.memberships")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .executeTakeFirstOrThrow();
  const i = await trx
    .selectFrom("platform.invites")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("org_id", "=", orgId)
    .where("accepted_at", "is", null)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", new Date())
    .executeTakeFirstOrThrow();
  return Number(m.n) + Number(i.n);
}
