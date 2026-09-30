// Authentication (api.yaml#info.x-auth): M1 session cookie with double-submit CSRF and the platform Origin on
// mutating requests; M0 dev mode (WIZARD_AUTH_MODE=dev only) — X-Wizard-Dev-User, default dev@wizard.local.
import type { IncomingMessage } from "node:http";
import type { Context, MiddlewareHandler } from "hono";
import { memberships, type OrgRole, ROLE_RANK } from "../auth/accounts.js";
import {
  clearCookies,
  cookieNames,
  cookieValues,
  csrfValid,
  findSession,
  sessionCookies,
} from "../auth/sessions.js";
import type { Config } from "../config.js";
import { type Db, DEFAULT_ORG_ID, DEV_USER_EMAIL } from "../db/index.js";
import { ApiError, notFound } from "../errors.js";

export type { OrgRole } from "../auth/accounts.js";

export interface AuthUser {
  id: string;
  email: string;
  orgs: Map<string, OrgRole>;
  defaultOrgId: string;
}

export type AppEnv = { Variables: { user: AuthUser; sessionId: string | undefined } };

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
/** Operations without a user (api.yaml security: []), relative to /api/v1. */
const PUBLIC_PATHS = new Set(["/auth/otp/request", "/auth/otp/verify", "/auth/dev-login"]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const isMutating = (method: string): boolean => !SAFE_METHODS.has(method);
const apiPath = (c: Context): string => c.req.path.replace(/^\/api\/v1(?=\/)/, "");

/** Peer address of the request (node-server); behind a proxy — M2 (WIZARD_TRUSTED_PROXIES). */
export function clientIp(c: Context): string {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

async function authUser(db: Db, id: string, email: string): Promise<AuthUser> {
  const ms = await memberships(db, id);
  const orgs = new Map(ms.map((m) => [m.orgId, m.role]));
  const defaultOrgId = orgs.has(DEFAULT_ORG_ID) ? DEFAULT_ORG_ID : (ms[0]?.orgId ?? DEFAULT_ORG_ID);
  return { id, email, orgs, defaultOrgId };
}

/** M0 dev user: header or default; an unknown local e-mail joins the local organization as editor. */
async function devUser(db: Db, header: string | undefined): Promise<AuthUser> {
  const email = (header ?? DEV_USER_EMAIL).trim().toLowerCase();
  if (!EMAIL.test(email)) throw new ApiError("UNAUTHORIZED", "Некорректный пользователь разработки");
  let user = await db
    .selectFrom("platform.users")
    .select(["id", "email"])
    .where("email", "=", email)
    .executeTakeFirst();
  if (!user) {
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
  return authUser(db, user.id, user.email);
}

/**
 * Sets `user` for every non-public operation. A session cookie wins in every mode; a mutating cookie request needs
 * Origin = WIZARD_PLATFORM_ORIGIN and X-Wizard-CSRF = CSRF cookie. Without a cookie: dev mode → dev user, else 401.
 */
export function authenticate(d: { db: Db; config: Config }): MiddlewareHandler<AppEnv> {
  const names = cookieNames(d.config);
  return async (c, next) => {
    if (PUBLIC_PATHS.has(apiPath(c))) return next();
    const cookieHeader = c.req.header("cookie");
    const tokens = cookieValues(cookieHeader, names.session).filter((t) => t !== "");
    if (tokens.length > 0) {
      // Duplicated session cookies (cookie tossing) are rejected as invalid.
      const s = tokens.length === 1 ? await findSession(d.db, tokens[0] as string) : undefined;
      if (!s) {
        for (const v of clearCookies(d.config)) c.header("set-cookie", v, { append: true });
        return c.json({ code: "UNAUTHORIZED", message_ru: "Сессия истекла — войдите снова" }, 401);
      }
      if (isMutating(c.req.method)) {
        if (c.req.header("origin") !== d.config.platformOrigin)
          throw new ApiError("FORBIDDEN", "Запрос с чужого сайта отклонён");
        const csrfCookies = cookieValues(cookieHeader, names.csrf);
        if (csrfCookies.length !== 1 || !csrfValid(s, c.req.header("x-wizard-csrf"), csrfCookies[0]))
          throw new ApiError("FORBIDDEN", "Проверка запроса не пройдена — обновите страницу");
      }
      const u = await d.db
        .selectFrom("platform.users")
        .select(["id", "email"])
        .where("id", "=", s.userId)
        .executeTakeFirstOrThrow();
      if (s.slid) {
        const csrf = cookieValues(cookieHeader, names.csrf)[0];
        const [sess, csrfCookie] = sessionCookies(d.config, tokens[0] as string, csrf ?? "", s.slid);
        c.header("set-cookie", sess as string, { append: true });
        if (csrf && csrfValid(s, csrf, csrf)) c.header("set-cookie", csrfCookie as string, { append: true });
      }
      c.set("user", await authUser(d.db, u.id, u.email));
      c.set("sessionId", s.id);
      return next();
    }
    if (d.config.authMode === "dev") {
      c.set("user", await devUser(d.db, c.req.header("x-wizard-dev-user")));
      c.set("sessionId", undefined);
      return next();
    }
    throw new ApiError("UNAUTHORIZED", "Войдите в аккаунт");
  };
}

/**
 * Session mode: every mutating request carries Origin = WIZARD_PLATFORM_ORIGIN (login CSRF on the public auth
 * operations included). Dev mode keeps the M0 host guard rule (a missing Origin passes).
 */
export function originGuard(config: Config): MiddlewareHandler {
  return async (c, next) => {
    if (
      config.authMode !== "dev" &&
      isMutating(c.req.method) &&
      c.req.header("origin") !== config.platformOrigin
    )
      throw new ApiError("FORBIDDEN", "Запрос с чужого сайта отклонён");
    return next();
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | undefined): s is string => !!s && UUID.test(s);

/**
 * Objects of another organization are 404 (IDOR rule of api.yaml); insufficient role is 403 — FORBIDDEN, or
 * NOT_OWNER for owner-only publishing actions (api.yaml publishBlockers, rollback env=prod).
 */
export function checkOrgAccess(
  user: AuthUser,
  orgId: string,
  min: OrgRole,
  what: string,
  code: "FORBIDDEN" | "NOT_OWNER" = "FORBIDDEN",
): OrgRole {
  const role = user.orgs.get(orgId);
  if (!role) throw notFound(what);
  if (ROLE_RANK[role] < ROLE_RANK[min])
    throw new ApiError(
      code,
      code === "NOT_OWNER"
        ? "Это действие доступно только владельцу"
        : "Недостаточно прав для этого действия",
    );
  return role;
}
