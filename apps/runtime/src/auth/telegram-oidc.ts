// Telegram Login over OpenID Connect (runtime.yaml#auth.methods_M1.telegram, connectors/telegram.yaml; L3-26):
// Authorization Code + PKCE (S256) with the system's own bot as the client; state, nonce, verifier, role, next and
// the consent of a first login travel in the sealed cookie wz_oidc / __Host-wz_oidc (10 min); redirect_uri is fixed.
import { createHash, createPublicKey, type KeyObject, randomBytes, verify } from "node:crypto";
import type { Integration } from "@wizard/appspec";
import { type TelegramConfig, telegramBot, telegramBotToken, telegramLoginEnabled } from "@wizard/connectors";
import { WizardError } from "@wizard/sdk";
import type { RuntimeEnv } from "../env.js";
import type { LoadedSystem } from "../system.js";
import type { AuthDeps } from "./deps.js";
import { sameText } from "./keys.js";
import { assertMethod, type LoginResult, requestedRole, resolveLogin } from "./login.js";
import { cookieValues, safeNext } from "./session.js";

export const OIDC_TTL_MS = 10 * 60_000;

export function oidcCookieName(env: RuntimeEnv): string {
  return env.publicScheme === "https" ? "__Host-wz_oidc" : "wz_oidc";
}

function oidcCookie(env: RuntimeEnv, value: string, maxAgeMs: number): string {
  const parts = [
    `${oidcCookieName(env)}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (env.publicScheme === "https") parts.push("Secure");
  return parts.join("; ");
}

export const clearOidcCookie = (env: RuntimeEnv) => oidcCookie(env, "", 0);

type OidcState = {
  s: string;
  n: string;
  v: string;
  r: string | null;
  x: string;
  c: { policyVersion: string; textHash: string } | null;
  e: number;
};

/** Failure of the browser flow: the user goes back to /login?error=<code>. */
export class OidcError extends Error {
  constructor(
    readonly code: string,
    readonly next: string = "/",
    readonly role: string | null = null,
  ) {
    super(code);
  }
}

const b64 = (b: Buffer) => b.toString("base64url");
const aadOf = (sys: LoadedSystem) => `oidc:${sys.entry.systemId}:${sys.entry.env}`;

/** The telegram integration used for login: bot=own with loginEnabled (a shared bot has no client id). */
function loginIntegration(deps: AuthDeps, sys: LoadedSystem): Integration | null {
  for (const i of deps.connectors.integrations(sys.spec, "telegram")) {
    const config = (i.config ?? {}) as TelegramConfig;
    if (telegramBot(config) === "own" && telegramLoginEnabled(config, sys.spec)) return i;
  }
  return null;
}

async function clientOf(deps: AuthDeps, sys: LoadedSystem, host: string) {
  const integ = loginIntegration(deps, sys);
  if (!integ) throw new OidcError("LOGIN_METHOD_UNAVAILABLE");
  const ctx = deps.connectors.ctx(sys, integ, host);
  let token: string;
  let secret: string;
  try {
    token = await telegramBotToken(ctx);
    // Client secret of the bot's OpenID Connect client (@BotFather → Bot Settings → Web Login).
    secret = await ctx.secrets.get("telegram_client_secret");
  } catch {
    throw new OidcError("LOGIN_METHOD_UNAVAILABLE");
  }
  const clientId = token.split(":")[0] ?? "";
  if (!/^\d{1,20}$/.test(clientId)) throw new OidcError("LOGIN_METHOD_UNAVAILABLE");
  return { clientId, secret };
}

export const redirectUri = (env: RuntimeEnv, host: string) =>
  `${env.publicScheme}://${host}/api/auth/telegram/callback`;

export interface OidcStartInput {
  host: string;
  next: string | undefined;
  role: string | undefined;
  policyVersion: string | undefined;
  textHash: string | undefined;
}

/** GET /api/auth/telegram/start → {location, cookie}. */
export async function startTelegram(
  deps: AuthDeps,
  sys: LoadedSystem,
  i: OidcStartInput,
): Promise<{ location: string; cookie: string }> {
  const next = safeNext(i.next);
  let role: string | null = null;
  try {
    assertMethod(sys, "telegram");
    role = requestedRole(sys, i.role);
  } catch (e) {
    throw new OidcError(e instanceof WizardError ? e.code : "OIDC_FAILED", next);
  }
  const { clientId } = await clientOf(deps, sys, i.host).catch((e) => {
    throw e instanceof OidcError ? new OidcError(e.code, next, role) : e;
  });
  const state: OidcState = {
    s: b64(randomBytes(16)),
    n: b64(randomBytes(16)),
    v: b64(randomBytes(32)),
    r: role,
    x: next,
    c: i.policyVersion && i.textHash ? { policyVersion: i.policyVersion, textHash: i.textHash } : null,
    e: deps.clock().getTime() + OIDC_TTL_MS,
  };
  const wantsPhone = sys.spec.roles.some(
    (r) =>
      (role === null || r.name === role) && r.access === "login" && r.loginMethods?.includes("phone_otp"),
  );
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri(deps.env, i.host),
    scope: `openid telegram:bot_access${wantsPhone ? " phone" : ""}`,
    state: state.s,
    nonce: state.n,
    code_challenge: b64(createHash("sha256").update(state.v).digest()),
    code_challenge_method: "S256",
  });
  return {
    location: `${deps.oauthBase}/auth?${q.toString()}`,
    cookie: oidcCookie(deps.env, deps.keys.seal(state, aadOf(sys)), OIDC_TTL_MS),
  };
}

export interface OidcCallbackInput {
  host: string;
  cookieHeader: string | undefined;
  code: string | undefined;
  state: string | undefined;
  error: string | undefined;
  ipHmac: Buffer | null;
}

/** GET /api/auth/telegram/callback: state, code → id_token (signature, iss, aud, exp, nonce) → login. */
export async function finishTelegram(
  deps: AuthDeps,
  sys: LoadedSystem,
  i: OidcCallbackInput,
): Promise<{ result: LoginResult; next: string }> {
  const values = cookieValues(i.cookieHeader, oidcCookieName(deps.env));
  const st = values.length === 1 ? deps.keys.unseal<OidcState>(values[0] as string, aadOf(sys)) : null;
  if (!st || st.e < deps.clock().getTime()) throw new OidcError("OIDC_EXPIRED");
  const next = safeNext(st.x);
  const fail = (code: string) => new OidcError(code, next, st.r);
  if (!i.state || !sameText(i.state, st.s)) throw fail("OIDC_FAILED");
  if (i.error) throw fail(i.error === "access_denied" ? "OIDC_DENIED" : "OIDC_FAILED");
  if (!i.code || i.code.length > 2048) throw fail("OIDC_FAILED");
  const { clientId, secret } = await clientOf(deps, sys, i.host).catch((e) => {
    throw e instanceof OidcError ? fail(e.code) : e;
  });
  let claims: Record<string, unknown>;
  try {
    const res = await deps.fetch(`${deps.oauthBase}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: i.code,
        redirect_uri: redirectUri(deps.env, i.host),
        client_id: clientId,
        code_verifier: st.v,
      }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
    if (!res.ok || typeof body?.id_token !== "string") throw new Error(`token ${res.status}`);
    claims = await verifyIdToken(deps, body.id_token, clientId);
  } catch (e) {
    deps.log?.({
      ts: new Date().toISOString(),
      level: "warn",
      msg: "telegram_oidc_failed",
      system: sys.entry.slug,
      env: sys.entry.env,
      reason: e instanceof Error ? e.message.slice(0, 80) : "unknown",
    });
    throw fail("OIDC_FAILED");
  }
  if (typeof claims.nonce !== "string" || !sameText(claims.nonce, st.n)) throw fail("OIDC_FAILED");
  const tgId = String(claims.id ?? claims.sub ?? "");
  if (!/^\d{1,20}$/.test(tgId)) throw fail("OIDC_FAILED");
  const name = typeof claims.name === "string" ? claims.name.slice(0, 200) : null;
  const rawPhone = typeof claims.phone_number === "string" ? claims.phone_number.replace(/[^\d]/g, "") : "";
  const phone = rawPhone ? `+${rawPhone}` : null;
  try {
    const result = await resolveLogin(sys, {
      identity: {
        kind: "telegram",
        telegramId: tgId,
        name,
        phone: phone && /^\+\d{7,15}$/.test(phone) ? phone : null,
      },
      method: "telegram",
      role: st.r,
      consent: st.c,
      ipHmac: i.ipHmac,
    });
    return { result, next };
  } catch (e) {
    if (e instanceof WizardError) throw fail(e.code);
    throw e;
  }
}

// ---------- id_token ----------

type Jwk = { kid?: string; kty: string; [k: string]: unknown };
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();

async function jwks(deps: AuthDeps, fresh: boolean): Promise<Jwk[]> {
  const hit = jwksCache.get(deps.oauthBase);
  if (!fresh && hit && Date.now() - hit.at < 3_600_000) return hit.keys;
  const res = await deps.fetch(`${deps.oauthBase}/.well-known/jwks.json`, {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => null)) as { keys?: unknown } | null;
  if (!res.ok || !Array.isArray(body?.keys)) throw new Error(`jwks ${res.status}`);
  const keys = body.keys.filter((k): k is Jwk => typeof k === "object" && k !== null && "kty" in k);
  jwksCache.set(deps.oauthBase, { at: Date.now(), keys });
  return keys;
}

const ALGS: Readonly<Record<string, (data: Buffer, key: KeyObject, sig: Buffer) => boolean>> = {
  RS256: (d, k, s) => verify("sha256", d, k, s),
  ES256: (d, k, s) => verify("sha256", d, { key: k, dsaEncoding: "ieee-p1363" }, s),
  EdDSA: (d, k, s) => verify(null, d, k, s),
};

/** Verifies the signature by JWKS and iss/aud/exp/iat; returns the claims. Throws on any mismatch. */
export async function verifyIdToken(
  deps: AuthDeps,
  token: string,
  clientId: string,
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("jwt shape");
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  const check = header.alg ? ALGS[header.alg] : undefined;
  if (!check) throw new Error("jwt alg");
  const pick = (keys: Jwk[]) => keys.find((k) => header.kid === undefined || k.kid === header.kid);
  let jwk = pick(await jwks(deps, false));
  if (!jwk) jwk = pick(await jwks(deps, true));
  if (!jwk) throw new Error("jwt kid");
  const key = createPublicKey({ key: jwk as never, format: "jwk" });
  if (!check(Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) throw new Error("jwt signature");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  const now = deps.clock().getTime() / 1000;
  const issuer = deps.oauthBase;
  if (claims.iss !== issuer) throw new Error("jwt iss");
  const auds = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud ?? "")];
  if (!auds.includes(clientId)) throw new Error("jwt aud");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("jwt exp");
  if (typeof claims.iat === "number" && claims.iat > now + 300) throw new Error("jwt iat");
  return claims;
}
