// End-user login routes (runtime.yaml#auth.methods_M1, #auth.login_page, #auth.consent_at_login;
// service_endpoints.privacy): /api/auth/otp/*, /api/auth/telegram/*, /api/auth/consent/revoke and the /login
// page (the bundle's AppShell.Login). /_wizard/privacy lives in routes/privacy.ts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { clientIpOf } from "../auth/client-ip.js";
import type { AuthDeps } from "../auth/deps.js";
import { type LoginResult, userBody } from "../auth/login.js";
import { OtpError, startOtp, verifyOtp } from "../auth/otp.js";
import { createSession, loginCookies, logoutCookies, safeNext } from "../auth/session.js";
import { clearOidcCookie, finishTelegram, OidcError, startTelegram } from "../auth/telegram-oidc.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { sessionOf } from "../http/subject.js";
import { documentHeaders, escapeHtml, htmlPage } from "../preview/headers.js";
import { readObjectBody } from "../preview/http.js";
import { revokeConsent } from "../privacy/erasure.js";

function otpFailure(c: RuntimeContext, e: OtpError): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (e.retryAfterSec !== undefined) headers["Retry-After"] = String(e.retryAfterSec);
  return Response.json(
    { error: { code: e.code, message: e.message, details: {}, requestId: c.get("requestId") } },
    { status: e.status, headers },
  );
}

async function loggedIn(deps: AuthDeps, c: RuntimeContext, r: LoginResult): Promise<Headers> {
  const sys = c.get("system");
  const token = await createSession(sys, String(r.user.id));
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const v of loginCookies(deps.env, token, sys.entry.env === "draft")) headers.append("Set-Cookie", v);
  deps.log?.({
    ts: new Date().toISOString(),
    level: "info",
    msg: r.created ? "user_signed_up" : "user_logged_in",
    system: sys.entry.slug,
    env: sys.entry.env,
    userIdHash: deps.keys.userIdHash(String(r.user.id)),
  });
  return headers;
}

const origin = (deps: AuthDeps, c: RuntimeContext) => `${deps.env.publicScheme}://${c.get("host")}`;

/** Mounted at /api/auth next to /me and /logout (routes/wizard.ts). */
export function loginApiRoutes(deps: AuthDeps): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();

  app.post("/otp/start", async (c) => {
    const body = await readObjectBody(c);
    try {
      const r = await startOtp(deps, c.get("system"), {
        channel: body.channel,
        destination: body.destination,
        role: body.role,
        ip: clientIpOf(c.req.raw),
        origin: origin(deps, c),
        host: c.get("host"),
      });
      return c.json(r, 200, { "Cache-Control": "no-store" });
    } catch (e) {
      if (e instanceof OtpError) return otpFailure(c, e);
      throw e;
    }
  });

  app.post("/otp/verify", async (c) => {
    const body = await readObjectBody(c);
    const sys = c.get("system");
    try {
      const r = await verifyOtp(deps, sys, {
        challengeId: body.challengeId,
        code: body.code,
        consent: body._consent,
        ip: clientIpOf(c.req.raw),
      });
      const headers = await loggedIn(deps, c, r);
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify({ user: userBody(sys, r.user) }), { status: 200, headers });
    } catch (e) {
      if (e instanceof OtpError) return otpFailure(c, e);
      throw e;
    }
  });

  const backToLogin = (e: OidcError, extra: string[] = []) => {
    const q = new URLSearchParams({ error: e.code, method: "telegram", next: e.next });
    if (e.role) q.set("role", e.role);
    const headers = new Headers({ Location: `/login?${q.toString()}`, "Cache-Control": "no-store" });
    for (const v of extra) headers.append("Set-Cookie", v);
    return new Response(null, { status: 302, headers });
  };

  app.get("/telegram/start", async (c) => {
    try {
      const r = await startTelegram(deps, c.get("system"), {
        host: c.get("host"),
        next: c.req.query("next"),
        role: c.req.query("role"),
        policyVersion: c.req.query("pv"),
        textHash: c.req.query("th"),
      });
      const headers = new Headers({ Location: r.location, "Cache-Control": "no-store" });
      headers.append("Set-Cookie", r.cookie);
      return new Response(null, { status: 302, headers });
    } catch (e) {
      if (e instanceof OidcError) return backToLogin(e);
      throw e;
    }
  });

  app.get("/telegram/callback", async (c) => {
    const clear = clearOidcCookie(deps.env);
    try {
      const { result, next } = await finishTelegram(deps, c.get("system"), {
        host: c.get("host"),
        cookieHeader: c.req.header("cookie"),
        code: c.req.query("code"),
        state: c.req.query("state"),
        error: c.req.query("error"),
        ipHmac: deps.keys.ip(clientIpOf(c.req.raw)),
      });
      const headers = await loggedIn(deps, c, result);
      headers.append("Set-Cookie", clear);
      headers.set("Location", safeNext(next));
      return new Response(null, { status: 302, headers });
    } catch (e) {
      if (e instanceof OidcError) return backToLogin(e, [clear]);
      throw e;
    }
  });

  app.post("/consent/revoke", async (c) => {
    const { subject } = await sessionOf(c);
    if (subject.id === null) throw new WizardError("UNAUTHENTICATED");
    const sys = c.get("system");
    const services = c.get("services");
    const r = await revokeConsent(sys, subject.id, {
      withdrawalDays: services.privacy?.withdrawalDays ?? 0,
      now: services.clock(),
    });
    deps.log?.({
      ts: new Date().toISOString(),
      level: "info",
      msg: "consent_revoked",
      system: sys.entry.slug,
      env: sys.entry.env,
      userIdHash: deps.keys.userIdHash(subject.id),
      pending: r.pending,
      scheduledAt: r.scheduledAt,
    });
    const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
    for (const v of logoutCookies(deps.env, sys.entry.env === "draft")) headers.append("Set-Cookie", v);
    return new Response(JSON.stringify({ revoked: true }), { status: 200, headers });
  });

  return app;
}

/**
 * /login (runtime.yaml#auth.login_page): the bundle's index.html — its AppShell renders AppShell.Login from the
 * RoleSpec. Local drafts with WIZARD_DEV_LOGIN=1 keep the dev-login links (preview role switch, M0-24); without a
 * bundle — a plain page.
 */
export async function loginPage(c: RuntimeContext): Promise<Response> {
  const sys = c.get("system");
  const env = c.get("services").env;
  const next = safeNext(c.req.query("next"));
  const wanted = c.req.query("role");
  const roles = sys.spec.roles.filter((r) => r.access === "login" && (!wanted || r.name === wanted));
  if (sys.entry.env === "draft" && env.devLogin && roles.length > 0) {
    const links = roles.map((r) => {
      const href = `/_wizard/dev-login?role=${encodeURIComponent(r.name)}&next=${encodeURIComponent(next)}`;
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(r.label ?? r.name)}</a></li>`;
    });
    const body = `<p>Тестовый вход в черновик: выберите роль.</p><ul>${links.join("")}</ul>`;
    return c.body(htmlPage("Вход", body), 200, documentHeaders("no-store"));
  }
  if (sys.artifactDir) {
    const index = await readFile(join(sys.artifactDir, "client", "index.html")).catch(() => null);
    if (index) return c.body(new Uint8Array(index), 200, documentHeaders("no-store"));
  }
  const body = "<p>Вход в систему пока недоступен. Обратитесь к владельцу системы.</p>";
  return c.body(htmlPage("Вход", body), 200, documentHeaders("no-store"));
}
