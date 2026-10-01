// Sessions of end users (runtime.yaml#auth.session_cookie) and dev-login (runtime.yaml#auth.dev_login_M0).
import { createHash, randomBytes } from "node:crypto";
import { WizardError } from "@wizard/sdk";
import { type Subject, SYSTEM_SUBJECT } from "../data/access.js";
import type { RuntimeEnv } from "../env.js";
import type { LoadedSystem } from "../system.js";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Chosen by configuration, never by the request (L3-14). */
export function sessionCookieName(env: RuntimeEnv): string {
  return env.publicScheme === "https" ? "__Host-wz_sess" : "wz_sess";
}

/** Values of one cookie name in a Cookie header (duplicates are kept). */
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

export type SessionToken = { kind: "none" } | { kind: "invalid" } | { kind: "token"; token: string };

/** Preview cookie of a draft host framed by the platform (L3-15): the iframe is cross-site, Lax cookies do not go. */
export function previewCookieName(env: RuntimeEnv): string {
  return env.publicScheme === "https" ? "__Host-wz_prev" : "wz_prev";
}

function tokenOf(values: string[]): SessionToken {
  if (values.length === 0) return { kind: "none" };
  if (values.length > 1) return { kind: "invalid" };
  const token = values[0] as string;
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? { kind: "token", token } : { kind: "none" };
}

/**
 * Session token of a request: duplicated cookies are invalid (→ 401). The preview cookie is read only on draft
 * hosts and only when there is no session cookie (runtime.yaml#auth.session_cookie).
 */
export function readSessionToken(
  cookieHeader: string | null | undefined,
  env: RuntimeEnv,
  opts: { draft?: boolean } = {},
): SessionToken {
  const t = tokenOf(cookieValues(cookieHeader, sessionCookieName(env)));
  if (t.kind !== "none" || !opts.draft) return t;
  return tokenOf(cookieValues(cookieHeader, previewCookieName(env)));
}

export function sessionCookie(env: RuntimeEnv, token: string, maxAgeMs = SESSION_TTL_MS): string {
  const parts = [
    `${sessionCookieName(env)}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (env.publicScheme === "https") parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(env: RuntimeEnv): string {
  return sessionCookie(env, "", 0);
}

/** wz_prev / __Host-wz_prev: Secure; SameSite=None; Partitioned — draft hosts only, never prod. */
export function previewCookie(env: RuntimeEnv, token: string, maxAgeMs = SESSION_TTL_MS): string {
  return [
    `${previewCookieName(env)}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=None",
    "Partitioned",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ].join("; ");
}

/** Set-Cookie values of a login: the session cookie, plus the preview cookie on a draft host. */
export function loginCookies(env: RuntimeEnv, token: string, draft: boolean): string[] {
  return draft ? [sessionCookie(env, token), previewCookie(env, token)] : [sessionCookie(env, token)];
}

export function logoutCookies(env: RuntimeEnv, draft: boolean): string[] {
  return draft ? [clearSessionCookie(env), previewCookie(env, "", 0)] : [clearSessionCookie(env)];
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest();

/** Row of `users` for a valid, unexpired session; slides the expiry. null when there is no such session. */
export async function sessionUser(sys: LoadedSystem, token: string): Promise<Record<string, unknown> | null> {
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    const s = sys.schema;
    const hash = tokenHash(token);
    const rows = await tx.sql`
      select u.* from ${tx.sql(s)}.${tx.sql("_w_sessions")} as ss
      join ${tx.sql(s)}.${tx.sql("users")} as u on u.id = ss.user_id
      where ss.token_hash = ${hash} and ss.expires_at > now()`;
    const user = rows[0];
    if (!user) return null;
    await tx.sql`
      update ${tx.sql(s)}.${tx.sql("_w_sessions")}
      set last_seen_at = now(), expires_at = now() + ${`${SESSION_TTL_MS / 1000} seconds`}::interval
      where token_hash = ${hash}`;
    return { ...user };
  });
}

export async function createSession(sys: LoadedSystem, userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    const s = sys.schema;
    await tx.sql`
      insert into ${tx.sql(s)}.${tx.sql("_w_sessions")} (token_hash, user_id, expires_at)
      values (${tokenHash(token)}, ${userId}, now() + ${`${SESSION_TTL_MS / 1000} seconds`}::interval)`;
  });
  return token;
}

export async function deleteSession(sys: LoadedSystem, token: string): Promise<void> {
  await sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    await tx.sql`delete from ${tx.sql(sys.schema)}.${tx.sql("_w_sessions")} where token_hash = ${tokenHash(token)}`;
  });
}

/**
 * Burns a preview-token nonce (_w_preview_nonces, runtime.yaml#auth.preview_login_M2): true the first time, false on a
 * replay. Expired rows are swept in the same transaction.
 */
export async function consumePreviewNonce(sys: LoadedSystem, nonce: string, expMs: number): Promise<boolean> {
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    const t = tx.sql`${tx.sql(sys.schema)}.${tx.sql("_w_preview_nonces")}`;
    await tx.sql`delete from ${t} where expires_at < now()`;
    const rows = await tx.sql`
      insert into ${t} (nonce, expires_at) values (${nonce}, ${new Date(expMs)})
      on conflict (nonce) do nothing
      returning nonce`;
    return rows.length === 1;
  });
}

/** Creates (or takes) the user dev-<role> (runtime.yaml#auth.dev_login_M0). */
export async function devUser(sys: LoadedSystem, role: string): Promise<string> {
  const email = `dev-${role}@dev.localhost`;
  return sys.data.transaction("default", SYSTEM_SUBJECT, async (tx) => {
    const t = tx.sql`${tx.sql(sys.schema)}.${tx.sql("users")}`;
    const found = await tx.sql`select id from ${t} where email = ${email} and role = ${role}`;
    if (found[0]) return String(found[0].id);
    const rows = await tx.sql`
      insert into ${t} (role, display_name, email) values (${role}, ${`dev-${role}`}, ${email})
      on conflict (email) do update set role = excluded.role, blocked_at = null
      returning id`;
    return String(rows[0]?.id);
  });
}

/**
 * runtime.yaml#permissions.algorithm step 1: session → users row; no session → public role, otherwise 401;
 * blocked user or duplicated cookie → 401.
 */
export async function resolveSubject(
  sys: LoadedSystem,
  cookieHeader: string | null | undefined,
  env: RuntimeEnv,
): Promise<{ subject: Subject; token: string | null }> {
  const t = readSessionToken(cookieHeader, env, { draft: sys.entry.env === "draft" });
  if (t.kind === "invalid") throw new WizardError("UNAUTHENTICATED");
  if (t.kind === "token") {
    const user = await sessionUser(sys, t.token);
    if (user) {
      if (user.blocked_at) throw new WizardError("UNAUTHENTICATED");
      if (sys.spec.roles.some((r) => r.name === user.role && r.access === "login")) {
        return { subject: sys.data.subjectFor(user), token: t.token };
      }
    }
  }
  const pub = sys.data.publicSubject();
  if (!pub) throw new WizardError("UNAUTHENTICATED");
  return { subject: pub, token: null };
}

/** next/returnTo: only a local path ^/(?![/\\]) (L3-11, L3-26); anything else → "/". */
export function safeNext(next: string | null | undefined): string {
  if (typeof next !== "string" || !/^\/(?![/\\])/.test(next)) return "/";
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "/";
  }
  return next;
}
