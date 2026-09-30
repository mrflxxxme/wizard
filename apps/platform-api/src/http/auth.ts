// api.yaml#info.x-auth.M0: one local user, X-Wizard-Dev-User header, default dev@wizard.local.
import type { MiddlewareHandler } from "hono";
import { type Db, DEFAULT_ORG_ID, DEV_USER_EMAIL } from "../db/index.js";
import { ApiError, notFound } from "../errors.js";

export type OrgRole = "owner" | "editor" | "viewer";
const RANK: Record<OrgRole, number> = { viewer: 1, editor: 2, owner: 3 };

export interface AuthUser {
  id: string;
  email: string;
  orgs: Map<string, OrgRole>;
  defaultOrgId: string;
}

export type AppEnv = { Variables: { user: AuthUser } };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export function devAuth(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const email = (c.req.header("x-wizard-dev-user") ?? DEV_USER_EMAIL).trim().toLowerCase();
    if (!EMAIL.test(email)) throw new ApiError("UNAUTHORIZED", "Некорректный пользователь разработки");
    let user = await db
      .selectFrom("platform.users")
      .select(["id", "email"])
      .where("email", "=", email)
      .executeTakeFirst();
    if (!user) {
      // M0 dev mode: a new local e-mail joins the local organization as editor.
      user = await db.transaction().execute(async (trx) => {
        const u = await trx
          .insertInto("platform.users")
          .values({ email })
          .onConflict((oc) => oc.column("email").doUpdateSet({ email }))
          .returning(["id", "email"])
          .executeTakeFirstOrThrow();
        await trx
          .insertInto("platform.memberships")
          .values({ org_id: DEFAULT_ORG_ID, user_id: u.id, role: "editor" })
          .onConflict((oc) => oc.doNothing())
          .execute();
        return u;
      });
    }
    const ms = await db
      .selectFrom("platform.memberships")
      .select(["org_id", "role"])
      .where("user_id", "=", user.id)
      .orderBy("created_at")
      .execute();
    const orgs = new Map(ms.map((m) => [m.org_id, m.role as OrgRole]));
    const defaultOrgId = orgs.has(DEFAULT_ORG_ID) ? DEFAULT_ORG_ID : (ms[0]?.org_id ?? DEFAULT_ORG_ID);
    c.set("user", { id: user.id, email: user.email, orgs, defaultOrgId });
    return next();
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | undefined): s is string => !!s && UUID.test(s);

/** Objects of another organization are 404 (IDOR rule of api.yaml); insufficient role is 403. */
export function checkOrgAccess(user: AuthUser, orgId: string, min: OrgRole, what: string): void {
  const role = user.orgs.get(orgId);
  if (!role) throw notFound(what);
  if (RANK[role] < RANK[min]) throw new ApiError("FORBIDDEN", "Недостаточно прав для этого действия");
}
