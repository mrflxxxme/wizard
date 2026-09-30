// Platform sessions (api.yaml#info.x-auth.M1, db.yaml#sessions, deploy.yaml#cloud.domains.cookies): raw tokens live
// only in cookies, the DB keeps sha256; 30-day sliding expiry; double-submit CSRF.
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { randomToken, safeEqualHex, sha256Hex } from "./crypto.js";

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
/** The expiry slides at most once a day per session (one UPDATE instead of one per request). */
const SLIDE_EVERY_MS = 24 * 3600_000;

export interface CookieNames {
  session: string;
  csrf: string;
}

/** __Host- names over https; plain names over local http (a __Host- cookie requires Secure). */
export const cookieNames = (c: Pick<Config, "publicScheme">): CookieNames =>
  c.publicScheme === "https"
    ? { session: "__Host-wizard_session", csrf: "__Host-wizard_csrf" }
    : { session: "wizard_session", csrf: "wizard_csrf" };

/** All values of one cookie name (duplicates are kept so that the caller can reject them). */
export function cookieValues(header: string | null | undefined, name: string): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(
  c: Pick<Config, "publicScheme">,
  name: string,
  value: string,
  maxAgeSec: number,
  httpOnly: boolean,
) {
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${maxAgeSec}`, "SameSite=Lax"];
  if (httpOnly) parts.push("HttpOnly");
  if (c.publicScheme === "https") parts.push("Secure");
  return parts.join("; ");
}

/** Set-Cookie values: HttpOnly session and a script-readable CSRF cookie, both without Domain. */
export function sessionCookies(
  c: Pick<Config, "publicScheme">,
  token: string,
  csrf: string,
  expiresAt: Date,
) {
  const n = cookieNames(c);
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [cookie(c, n.session, token, maxAge, true), cookie(c, n.csrf, csrf, maxAge, false)];
}

export function clearCookies(c: Pick<Config, "publicScheme">): string[] {
  const n = cookieNames(c);
  return [cookie(c, n.session, "", 0, true), cookie(c, n.csrf, "", 0, false)];
}

export interface IssuedSession {
  id: string;
  token: string;
  csrf: string;
  expiresAt: Date;
}

export async function issueSession(db: Db, userId: string): Promise<IssuedSession> {
  const token = randomToken();
  const csrf = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const row = await db
    .insertInto("platform.sessions")
    .values({
      user_id: userId,
      token_hash: sha256Hex(token),
      csrf_hash: sha256Hex(csrf),
      expires_at: expiresAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, token, csrf, expiresAt };
}

export interface ActiveSession {
  id: string;
  userId: string;
  csrfHash: string;
  expiresAt: Date;
  /** New expiry when the sliding window moved (the caller re-sets the cookies). */
  slid?: Date;
}

/** Live session of a raw token: not revoked, not expired, user not deleted. Slides the expiry. */
export async function findSession(db: Db, token: string): Promise<ActiveSession | undefined> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return undefined;
  const s = await db
    .selectFrom("platform.sessions as s")
    .innerJoin("platform.users as u", "u.id", "s.user_id")
    .select(["s.id", "s.user_id", "s.csrf_hash", "s.expires_at"])
    .where("s.token_hash", "=", sha256Hex(token))
    .where("s.revoked_at", "is", null)
    .where("s.expires_at", ">", new Date())
    .where("u.deleted_at", "is", null)
    .executeTakeFirst();
  if (!s) return undefined;
  const out: ActiveSession = { id: s.id, userId: s.user_id, csrfHash: s.csrf_hash, expiresAt: s.expires_at };
  if (s.expires_at.getTime() - Date.now() < SESSION_TTL_MS - SLIDE_EVERY_MS) {
    const next = new Date(Date.now() + SESSION_TTL_MS);
    await db.updateTable("platform.sessions").set({ expires_at: next }).where("id", "=", s.id).execute();
    out.expiresAt = next;
    out.slid = next;
  }
  return out;
}

/** Double submit: the header equals the CSRF cookie and hashes to the session's csrf_hash. */
export function csrfValid(
  s: ActiveSession,
  header: string | undefined,
  cookieValue: string | undefined,
): boolean {
  if (!header || !cookieValue || header !== cookieValue) return false;
  return safeEqualHex(sha256Hex(header), s.csrfHash);
}

export async function revokeSession(db: Db, id: string): Promise<void> {
  await db.updateTable("platform.sessions").set({ revoked_at: new Date() }).where("id", "=", id).execute();
}
