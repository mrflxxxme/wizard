// /_wizard/* service endpoints of a system host (runtime.yaml#service_endpoints) and /api/auth/me|logout.
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import { verifyPreviewToken } from "../auth/preview-token.js";
import {
  consumePreviewNonce,
  createSession,
  deleteSession,
  devUser,
  loginCookies,
  logoutCookies,
  safeNext,
} from "../auth/session.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { sessionOf } from "../http/subject.js";
import { NO_CACHE } from "../preview/headers.js";
import { monogramSvg, REGISTER_SCRIPT } from "../pwa/pwa.js";
import { buildRoleSpec } from "../rolespec.js";

async function roleOrNull(c: RuntimeContext): Promise<string | null> {
  try {
    return (await sessionOf(c)).subject.role;
  } catch (e) {
    if (e instanceof WizardError && e.code === "UNAUTHENTICATED") return null;
    throw e;
  }
}

function redirectWithCookies(location: string, cookies: string[]): Response {
  // no-referrer: the one-time token of preview-login must not leak to the next page's requests.
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const v of cookies) headers.append("Set-Cookie", v);
  return new Response(null, { status: 302, headers });
}

export function wizardRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();

  // runtime.yaml#service_endpoints.health (L3-19): public hosts behind TLS (https) answer only {status}; details live on
  // the internal port. Local http keeps {system, env, revision} on the public port for M0–M1 tooling (smoke, preview).
  app.get("/health", (c) => {
    const { entry } = c.get("system");
    if (c.get("services").env.publicScheme === "https") return c.json({ status: "ok" });
    return c.json({ status: "ok", system: entry.slug, env: entry.env, revision: entry.revision });
  });

  app.get("/spec", async (c) => {
    const sys = c.get("system");
    const role = await roleOrNull(c);
    const etag = `"${sys.entry.specHash}:${role ?? ""}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag });
    const body = buildRoleSpec(sys.spec, {
      role,
      compliance: sys.compliance,
      features: sys.entry.features,
      env: sys.entry.env,
    });
    return c.json(body, 200, { ETag: etag, "Cache-Control": "no-cache" });
  });

  // runtime.yaml#static.pwa: service worker registration and the monogram icon of the manifest.
  app.get("/pwa.js", (c) =>
    c.body(REGISTER_SCRIPT, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": NO_CACHE,
    }),
  );
  app.get("/icon.svg", (c) =>
    c.body(monogramSvg(c.get("system").spec), 200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": NO_CACHE,
    }),
  );

  // runtime.yaml#auth.dev_login_M0: draft + WIZARD_DEV_LOGIN=1 only; elsewhere the route does not exist.
  app.get("/dev-login", async (c) => {
    const sys = c.get("system");
    const env = c.get("services").env;
    if (sys.entry.env !== "draft" || !env.devLogin) return notFoundPage();
    const roleName = c.req.query("role") ?? "";
    const role = sys.spec.roles.find((r) => r.name === roleName && r.access === "login");
    if (!role) return notFoundPage();
    const userId = await devUser(sys, role.name);
    const token = await createSession(sys, userId);
    return redirectWithCookies(safeNext(c.req.query("next")), loginCookies(env, token, true));
  });

  app.get("/dev-logout", async (c) => {
    const sys = c.get("system");
    const env = c.get("services").env;
    if (sys.entry.env !== "draft" || !env.devLogin) return notFoundPage();
    const s = await sessionOf(c).catch(() => null);
    if (s?.token) await deleteSession(sys, s.token);
    return redirectWithCookies(safeNext(c.req.query("next")), logoutCookies(env, true));
  });

  // runtime.yaml#auth.preview_login_M2 (L3-11): draft host + WIZARD_PREVIEW_SECRET; HMAC token from platform-api
  // (getPreviewUrl), exp ≤ 15 min, one-time nonce. Any failure is 404 (the route reveals nothing).
  app.get("/preview-login", async (c) => {
    const sys = c.get("system");
    const { env, clock, log } = c.get("services");
    if (sys.entry.env !== "draft" || !env.previewSecret) return notFoundPage();
    const deny = (reason: string) => {
      log?.({
        ts: clock().toISOString(),
        level: "warn",
        requestId: c.get("requestId"),
        msg: "preview_login_denied",
        system: sys.entry.slug,
        reason,
      });
      return notFoundPage();
    };
    const check = verifyPreviewToken(env.previewSecret, c.req.query("t") ?? "", clock().getTime());
    if (!check.ok) return deny(check.reason);
    const { claims } = check;
    if (claims.systemId !== sys.entry.systemId) return deny("system_mismatch");
    const role = sys.spec.roles.find((r) => r.name === claims.role);
    if (!role) return deny("unknown_role");
    let fresh: boolean;
    try {
      fresh = await consumePreviewNonce(sys, claims.nonce, claims.exp);
    } catch {
      return deny("nonce_store"); // schema predates _w_preview_nonces: fail closed until the draft is migrated
    }
    if (!fresh) return deny("replay");
    // Same identity as dev-login (dev-<role>): draft seeds reference these users. A public role gets a session too, so
    // the draft gate passes; resolveSubject maps it to the public subject (the role has no login access).
    const userId = await devUser(sys, role.name);
    const token = await createSession(sys, userId);
    log?.({
      ts: clock().toISOString(),
      level: "info",
      requestId: c.get("requestId"),
      msg: "preview_login",
      system: sys.entry.slug,
      revision: claims.revision,
    });
    return redirectWithCookies(safeNext(c.req.query("next")), loginCookies(env, token, true));
  });

  // Internal endpoints listen on the internal port only (runtime.yaml#routing.rules, L3-19).
  app.all("/internal/*", () => notFoundPage());

  return app;
}

/** GET /api/auth/me, POST /api/auth/logout (runtime.yaml#auth.methods_M1.me_logout; needed by useUser in M0). */
export function authRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();
  app.get("/me", async (c) => {
    const { subject } = await sessionOf(c);
    if (subject.id === null) throw new WizardError("UNAUTHENTICATED");
    const displayName = subject.record.display_name;
    return c.json({
      user: {
        id: subject.id,
        role: subject.role,
        displayName: typeof displayName === "string" ? displayName : "",
        isAdmin: subject.isAdmin,
      },
    });
  });
  app.post("/logout", async (c) => {
    const s = await sessionOf(c).catch(() => null);
    if (s?.token) await deleteSession(c.get("system"), s.token);
    const headers = new Headers();
    const draft = c.get("system").entry.env === "draft";
    for (const v of logoutCookies(c.get("services").env, draft)) headers.append("Set-Cookie", v);
    return new Response(null, { status: 204, headers });
  });
  return app;
}
