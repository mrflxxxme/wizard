// /_wizard/* service endpoints of a system host (runtime.yaml#service_endpoints) and /api/auth/me|logout.
import { WizardError } from "@wizard/sdk";
import { Hono } from "hono";
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  devUser,
  safeNext,
  sessionCookie,
} from "../auth/session.js";
import type { RuntimeContext, RuntimeHonoEnv } from "../http/context.js";
import { notFoundPage } from "../http/errors.js";
import { sessionOf } from "../http/subject.js";
import { buildRoleSpec } from "../rolespec.js";

async function roleOrNull(c: RuntimeContext): Promise<string | null> {
  try {
    return (await sessionOf(c)).subject.role;
  } catch (e) {
    if (e instanceof WizardError && e.code === "UNAUTHENTICATED") return null;
    throw e;
  }
}

export function wizardRoutes(): Hono<RuntimeHonoEnv> {
  const app = new Hono<RuntimeHonoEnv>();

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.get("/spec", async (c) => {
    const sys = c.get("system");
    const role = await roleOrNull(c);
    const etag = `"${sys.entry.specHash}:${role ?? ""}"`;
    if (c.req.header("if-none-match") === etag) return c.body(null, 304, { ETag: etag });
    const body = buildRoleSpec(sys.spec, { role, compliance: sys.compliance, features: sys.entry.features });
    return c.json(body, 200, { ETag: etag, "Cache-Control": "no-cache" });
  });

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
    return c.body(null, 302, {
      Location: safeNext(c.req.query("next")),
      "Set-Cookie": sessionCookie(env, token),
      "Cache-Control": "no-store",
    });
  });

  app.get("/dev-logout", async (c) => {
    const sys = c.get("system");
    const env = c.get("services").env;
    if (sys.entry.env !== "draft" || !env.devLogin) return notFoundPage();
    const s = await sessionOf(c).catch(() => null);
    if (s?.token) await deleteSession(sys, s.token);
    return c.body(null, 302, {
      Location: safeNext(c.req.query("next")),
      "Set-Cookie": clearSessionCookie(env),
      "Cache-Control": "no-store",
    });
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
    return c.body(null, 204, { "Set-Cookie": clearSessionCookie(c.get("services").env) });
  });
  return app;
}
