// /orgs/*, /invites/* of specs/platform/api.yaml (x-milestone M1; GET settings served since M0-30 for S1/S3).
// Roles: owner ⊃ editor ⊃ viewer (x-roles); another org's objects → 404; region → data-boundary.yaml#region_restriction.
import { buildModelLabel, createRegistry, orgPolicyBus, type PolicyBus } from "@wizard/llm";
import { Hono } from "hono";
import { z } from "zod";
import { lockOrg, MEMBER_LIMITS, type OrgRole, ROLE_RANK, ROLE_RU, seatsUsed } from "../auth/accounts.js";
import { randomToken, sha256Hex } from "../auth/crypto.js";
import { applyRegion, innValid } from "../auth/region.js";
import { ApiError, invalid, notFound } from "../errors.js";
import { type AppEnv, type AuthUser, checkOrgAccess, isUuid } from "../http/auth.js";
import { type Deps, jsonBody } from "../http/util.js";
import { orgPolicyOf } from "../runs/queue.js";
import type { AccountDeps } from "./auth.js";

export const INVITE_TTL_MS = 7 * 24 * 3600_000;

const roleSchema = z.enum(["owner", "editor", "viewer"]);
const regionSchema = z.string().regex(/^[0-9]{2}$/);
const innSchema = z.string().regex(/^[0-9]{10}$|^[0-9]{12}$/);
const emailSchema = z
  .string()
  .trim()
  .max(254)
  .transform((s) => s.toLowerCase())
  .pipe(z.email());

function checkInn(inn: string | undefined): void {
  if (inn !== undefined && !innValid(inn)) throw new ApiError("INN_INVALID", "ИНН указан с ошибкой");
}

export function orgRoutes(d: Deps, a: AccountDeps, bus: PolicyBus = orgPolicyBus): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const registry = createRegistry({ buildDefaultTier: d.config.buildDefaultTier });

  // A policy change (ruOnly, region) drops cached policies and aborts the org's in-flight T1 calls,
  // which are repeated on T0 (data-boundary.yaml#ru_only, L3-42).
  async function publishPolicy(orgId: string): Promise<void> {
    const org = await d.db
      .selectFrom("platform.orgs")
      .select(["ru_only", "t1_restricted", "region_code"])
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (org) bus.publish({ orgId, policy: orgPolicyOf(org) });
  }

  function orgParam(user: AuthUser, id: string | undefined, min: OrgRole): { orgId: string; role: OrgRole } {
    if (!isUuid(id)) throw notFound("Организация");
    return { orgId: id, role: checkOrgAccess(user, id, min, "Организация") };
  }

  async function toOrg(orgId: string, role: OrgRole) {
    const o = await d.db
      .selectFrom("platform.orgs")
      .select(["id", "name", "plan"])
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!o) throw notFound("Организация");
    // Card binding arrives with payment_methods (M2-11).
    return { id: o.id, name: o.name, plan: o.plan as "free" | "start" | "business", role, cardBound: false };
  }

  async function settings(orgId: string) {
    const org = await d.db
      .selectFrom("platform.orgs")
      .select(["ru_only", "t1_restricted", "region_code"])
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org) throw notFound("Организация");
    // Same policy as the run engine: unknown region → T0 until determined (fail-safe).
    const policy = orgPolicyOf(org);
    return {
      ruOnly: org.ru_only,
      buildModelLabel: buildModelLabel(registry, policy),
      t1Restricted: policy.t1Restricted,
    };
  }

  // listOrgs
  r.get("/orgs", async (c) => {
    const user = c.get("user");
    const items = await Promise.all([...user.orgs].map(([id, role]) => toOrg(id, role)));
    return c.json({ items });
  });

  // createOrg: the creator becomes owner (Free grants — credit ledger, M1-03).
  r.post("/orgs", async (c) => {
    const b = await jsonBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(120),
        regionCode: regionSchema.optional(),
        inn: innSchema.optional(),
      }),
    );
    checkInn(b.inn);
    const user = c.get("user");
    const region = applyRegion({ region_code: null, t1_restricted: false }, b);
    const org = await d.db.transaction().execute(async (trx) => {
      const o = await trx
        .insertInto("platform.orgs")
        .values({ name: b.name, ...region })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("platform.memberships")
        .values({ org_id: o.id, user_id: user.id, role: "owner" })
        .execute();
      return o;
    });
    return c.json(await toOrg(org.id, "owner"), 201);
  });

  // getOrg
  r.get("/orgs/:orgId", async (c) => {
    const { orgId, role } = orgParam(c.get("user"), c.req.param("orgId"), "viewer");
    return c.json(await toOrg(orgId, role));
  });

  // updateOrg: name; region sources (region at registration, INN of the requisites) only tighten t1_restricted.
  r.patch("/orgs/:orgId", async (c) => {
    const { orgId, role } = orgParam(c.get("user"), c.req.param("orgId"), "owner");
    const b = await jsonBody(
      c,
      z.object({
        name: z.string().trim().min(1).max(120).optional(),
        regionCode: regionSchema.optional(),
        inn: innSchema.optional(),
      }),
    );
    checkInn(b.inn);
    await d.db.transaction().execute(async (trx) => {
      const cur = await trx
        .selectFrom("platform.orgs")
        .select(["region_code", "t1_restricted"])
        .where("id", "=", orgId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("platform.orgs")
        .set({ ...(b.name !== undefined ? { name: b.name } : {}), ...applyRegion(cur, b) })
        .where("id", "=", orgId)
        .execute();
    });
    await publishPolicy(orgId);
    return c.json(await toOrg(orgId, role));
  });

  // getOrgSettings
  r.get("/orgs/:orgId/settings", async (c) => {
    const { orgId } = orgParam(c.get("user"), c.req.param("orgId"), "viewer");
    return c.json(await settings(orgId));
  });

  // updateOrgSettings: ruOnly (the router reads the org policy on every call, data-boundary.yaml#ru_only).
  r.patch("/orgs/:orgId/settings", async (c) => {
    const { orgId } = orgParam(c.get("user"), c.req.param("orgId"), "owner");
    const b = await jsonBody(
      c,
      z.strictObject({
        ruOnly: z.boolean().optional(),
        buildModelLabel: z.string().optional(),
        t1Restricted: z.boolean().optional(),
      }),
    );
    if (b.ruOnly !== undefined)
      await d.db.updateTable("platform.orgs").set({ ru_only: b.ruOnly }).where("id", "=", orgId).execute();
    await publishPolicy(orgId);
    return c.json(await settings(orgId));
  });

  // listMembers
  r.get("/orgs/:orgId/members", async (c) => {
    const { orgId } = orgParam(c.get("user"), c.req.param("orgId"), "viewer");
    const rows = await d.db
      .selectFrom("platform.memberships as m")
      .innerJoin("platform.users as u", "u.id", "m.user_id")
      .select(["m.user_id", "u.email", "u.name", "m.role", "m.created_at"])
      .where("m.org_id", "=", orgId)
      .orderBy("m.created_at")
      .execute();
    return c.json({
      items: rows.map((m) => ({
        userId: m.user_id,
        email: m.email,
        name: m.name,
        role: m.role,
        joinedAt: m.created_at.toISOString(),
      })),
    });
  });

  /** Changes or removes a membership keeping ≥ 1 owner (db.yaml#memberships.invariants). */
  async function changeMember(orgId: string, userId: string | undefined, role: OrgRole | null) {
    if (!isUuid(userId)) throw notFound("Участник");
    return d.db.transaction().execute(async (trx) => {
      await lockOrg(trx, orgId);
      const m = await trx
        .selectFrom("platform.memberships as m")
        .innerJoin("platform.users as u", "u.id", "m.user_id")
        .select(["m.user_id", "m.role", "m.created_at", "u.email", "u.name"])
        .where("m.org_id", "=", orgId)
        .where("m.user_id", "=", userId)
        .executeTakeFirst();
      if (!m) throw notFound("Участник");
      if (m.role === "owner" && role !== "owner") {
        const owners = await trx
          .selectFrom("platform.memberships")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("org_id", "=", orgId)
          .where("role", "=", "owner")
          .executeTakeFirstOrThrow();
        if (Number(owners.n) <= 1)
          throw new ApiError("LAST_OWNER", "В организации должен остаться хотя бы один владелец");
      }
      if (role === null)
        await trx
          .deleteFrom("platform.memberships")
          .where("org_id", "=", orgId)
          .where("user_id", "=", userId)
          .execute();
      else
        await trx
          .updateTable("platform.memberships")
          .set({ role })
          .where("org_id", "=", orgId)
          .where("user_id", "=", userId)
          .execute();
      return {
        userId: m.user_id,
        email: m.email,
        name: m.name,
        role: role ?? m.role,
        joinedAt: m.created_at.toISOString(),
      };
    });
  }

  // updateMemberRole
  r.patch("/orgs/:orgId/members/:userId", async (c) => {
    const { orgId } = orgParam(c.get("user"), c.req.param("orgId"), "owner");
    const b = await jsonBody(c, z.object({ role: roleSchema }));
    return c.json(await changeMember(orgId, c.req.param("userId"), b.role));
  });

  // removeMember
  r.delete("/orgs/:orgId/members/:userId", async (c) => {
    const { orgId } = orgParam(c.get("user"), c.req.param("orgId"), "owner");
    await changeMember(orgId, c.req.param("userId"), null);
    return c.body(null, 204);
  });

  const toInvite = (i: { id: string; email: string; role: OrgRole; expires_at: Date }) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    expiresAt: i.expires_at.toISOString(),
  });

  // listInvites: active only.
  r.get("/orgs/:orgId/invites", async (c) => {
    const { orgId } = orgParam(c.get("user"), c.req.param("orgId"), "owner");
    const rows = await d.db
      .selectFrom("platform.invites")
      .select(["id", "email", "role", "expires_at"])
      .where("org_id", "=", orgId)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", new Date())
      .orderBy("created_at", "desc")
      .execute();
    return c.json({ items: rows.map(toInvite) });
  });

  // createInvite: a letter with the link; TTL 7 days; members + active invites ≤ plan limit (402 PLAN_LIMIT).
  r.post("/orgs/:orgId/invites", async (c) => {
    const user = c.get("user");
    const { orgId } = orgParam(user, c.req.param("orgId"), "owner");
    const b = await jsonBody(c, z.object({ email: emailSchema, role: roleSchema }));
    const token = randomToken();
    const { invite, orgName } = await d.db.transaction().execute(async (trx) => {
      const org = await lockOrg(trx, orgId);
      if (!org) throw notFound("Организация");
      const member = await trx
        .selectFrom("platform.memberships as m")
        .innerJoin("platform.users as u", "u.id", "m.user_id")
        .select("m.user_id")
        .where("m.org_id", "=", orgId)
        .where("u.email", "=", b.email)
        .executeTakeFirst();
      if (member) throw invalid("Этот человек уже в организации");
      // A repeated invite to the same address replaces the previous one.
      await trx
        .updateTable("platform.invites")
        .set({ revoked_at: new Date() })
        .where("org_id", "=", orgId)
        .where("email", "=", b.email)
        .where("accepted_at", "is", null)
        .where("revoked_at", "is", null)
        .execute();
      const limit = MEMBER_LIMITS[org.plan] ?? MEMBER_LIMITS.free ?? 3;
      const current = await seatsUsed(trx, orgId);
      if (current >= limit)
        throw new ApiError("PLAN_LIMIT", `На тарифе можно до ${limit} участников`, {
          limit,
          current,
          plan: org.plan,
        });
      const invite = await trx
        .insertInto("platform.invites")
        .values({
          org_id: orgId,
          email: b.email,
          role: b.role,
          token_hash: sha256Hex(token),
          invited_by: user.id,
          expires_at: new Date(Date.now() + INVITE_TTL_MS),
        })
        .returning(["id", "email", "role", "expires_at"])
        .executeTakeFirstOrThrow();
      return { invite, orgName: org.name };
    });
    await a.mailer.send({
      kind: "invite",
      to: b.email,
      subject: "Приглашение в Wizard",
      text: `Вас пригласили в организацию «${orgName}» в Wizard с ролью «${ROLE_RU[b.role]}».\nПринять приглашение: ${d.config.platformOrigin}/invite/${token}\nСсылка действует 7 дней.`,
    });
    return c.json(toInvite(invite), 201);
  });

  // revokeInvite
  r.delete("/orgs/:orgId/invites/:inviteId", async (c) => {
    const { orgId } = orgParam(c.get("user"), c.req.param("orgId"), "owner");
    const id = c.req.param("inviteId");
    if (!isUuid(id)) throw notFound("Приглашение");
    const res = await d.db
      .updateTable("platform.invites")
      .set({ revoked_at: new Date() })
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 0) throw notFound("Приглашение");
    return c.body(null, 204);
  });

  // acceptInvite: the session e-mail MUST equal the invite e-mail.
  r.post("/invites/:token/accept", async (c) => {
    const user = c.get("user");
    const token = c.req.param("token");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw notFound("Приглашение");
    const member = await d.db.transaction().execute(async (trx) => {
      const inv = await trx
        .selectFrom("platform.invites")
        .selectAll()
        .where("token_hash", "=", sha256Hex(token))
        .forUpdate()
        .executeTakeFirst();
      if (!inv) throw notFound("Приглашение");
      if (inv.accepted_at || inv.revoked_at || inv.expires_at.getTime() <= Date.now())
        throw new ApiError("INVITE_EXPIRED", "Приглашение устарело, попросите новое");
      if (inv.email !== user.email.toLowerCase())
        throw new ApiError("FORBIDDEN", "Приглашение отправлено на другой адрес — войдите с ним");
      const org = await lockOrg(trx, inv.org_id);
      if (!org) throw new ApiError("INVITE_EXPIRED", "Приглашение устарело, попросите новое");
      const cur = await trx
        .selectFrom("platform.memberships")
        .select(["role", "created_at"])
        .where("org_id", "=", inv.org_id)
        .where("user_id", "=", user.id)
        .executeTakeFirst();
      let role: OrgRole = inv.role;
      let joinedAt = new Date();
      if (cur) {
        // Already a member: an invite never lowers the role.
        if (ROLE_RANK[cur.role] >= ROLE_RANK[inv.role]) role = cur.role;
        else
          await trx
            .updateTable("platform.memberships")
            .set({ role })
            .where("org_id", "=", inv.org_id)
            .where("user_id", "=", user.id)
            .execute();
        joinedAt = cur.created_at;
      } else {
        // The invite held a seat; a downgrade in between may have lowered the limit.
        const limit = MEMBER_LIMITS[org.plan] ?? 3;
        const current = (await seatsUsed(trx, inv.org_id)) - 1;
        if (current >= limit)
          throw new ApiError("PLAN_LIMIT", `На тарифе можно до ${limit} участников`, {
            limit,
            current,
            plan: org.plan,
          });
        await trx
          .insertInto("platform.memberships")
          .values({ org_id: inv.org_id, user_id: user.id, role })
          .execute();
      }
      await trx
        .updateTable("platform.invites")
        .set({ accepted_at: new Date() })
        .where("id", "=", inv.id)
        .execute();
      const u = await trx
        .selectFrom("platform.users")
        .select(["email", "name"])
        .where("id", "=", user.id)
        .executeTakeFirstOrThrow();
      return { userId: user.id, email: u.email, name: u.name, role, joinedAt: joinedAt.toISOString() };
    });
    return c.json(member);
  });

  return r;
}
