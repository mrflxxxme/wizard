// Acceptance M1-02 (api.yaml#info.x-auth.M1, requestOtp/verifyOtp, db.yaml#auth_otps/#sessions, L3-17): email OTP,
// consents, rate limits, session cookies, CSRF, sliding expiry, logout, dev-login and startup guards.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { OFFER_VERSION } from "../src/auth/accounts.js";
import { assertStartupAllowed, loadConfig } from "../src/config.js";
import { createPlatformApi } from "../src/index.js";
import { createTestDb, fakeExecutors, fakeRouterFactory, startApi, type TestApi } from "./helpers.js";
import {
  asSession,
  devLogin,
  expectContract,
  MemoryMailer,
  ORIGIN,
  otpLogin,
  setCookies,
} from "./session.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const mailer = new MemoryMailer();
const h = { origin: ORIGIN };

beforeAll(async () => {
  tdb = await createTestDb("acct");
  api = await startApi(tdb.url, {
    config: { authMode: "session" },
    mailer,
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
  });
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});
// The per-IP limit counts every request of this file (the in-process fetch has no peer address).
beforeEach(async () => {
  await api.deps.pg`delete from platform.auth_otps`;
});

const requestOtp = (email: string, headers: Record<string, string> = h) =>
  api.req("POST", "/auth/otp/request", { body: { email }, headers });
const verify = (body: Record<string, unknown>, headers: Record<string, string> = h) =>
  api.req("POST", "/auth/otp/verify", { body, headers });

describe("email OTP", () => {
  test("new user: code by mail, both consents required separately, then a session", async () => {
    const email = "New.User@Example.ru";
    const r = await requestOtp(email);
    expect(r.status).toBe(204);
    expectContract("requestOtp", r);
    const code = mailer.code("new.user@example.ru");
    const [row] = await api.deps.pg`select code_hash, ip_hash, attempts from platform.auth_otps`;
    expect(row?.code_hash).not.toContain(code);
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);

    const none = await verify({ email, code });
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({
      code: "CONSENT_REQUIRED",
      details: { missing: ["acceptOffer", "pdConsent"] },
    });
    expectContract("verifyOtp", none);
    const offerOnly = await verify({ email, code, acceptOffer: true });
    expect(offerOnly.body.details.missing).toEqual(["pdConsent"]);
    const pdOnly = await verify({ email, code, pdConsent: true, acceptOffer: false });
    expect(pdOnly.body.details.missing).toEqual(["acceptOffer"]);

    const ok = await verify({ email, code, acceptOffer: true, pdConsent: true });
    expect(ok.status).toBe(200);
    expectContract("verifyOtp", ok);
    expect(ok.body.user).toMatchObject({ email: "new.user@example.ru", isStaff: false });
    const [u] = await api.deps
      .pg`select pd_consent_at, offer_accepted_at, offer_version from platform.users where email = 'new.user@example.ru'`;
    expect(u?.pd_consent_at).toBeInstanceOf(Date);
    expect(u?.offer_version).toBe(OFFER_VERSION);

    const s = asSession(api, ok, email);
    const me = await s.req("GET", "/me");
    expect(me.status).toBe(200);
    expectContract("getMe", me);
    expect(me.body.memberships).toEqual([
      { orgId: expect.any(String), orgName: "Моя организация", role: "owner" },
    ]);
    // The code is single-use.
    expect((await verify({ email, code, acceptOffer: true, pdConsent: true })).status).toBe(401);
  });

  test("existing user signs in without consents; a new offer version asks for it again", async () => {
    const email = "again@example.ru";
    await otpLogin(api, mailer, email);
    await requestOtp(email);
    const ok = await verify({ email, code: mailer.code(email) });
    expect(ok.status).toBe(200);
    await api.deps.pg`update platform.users set offer_version = 'old' where email = ${email}`;
    await requestOtp(email);
    const again = await verify({ email, code: mailer.code(email) });
    expect(again.body).toMatchObject({ code: "CONSENT_REQUIRED", details: { missing: ["acceptOffer"] } });
    expect((await verify({ email, code: mailer.code(email), acceptOffer: true })).status).toBe(200);
  });

  test("≤ 5 attempts per code: after five wrong codes even the right one fails", async () => {
    const email = "brute@example.ru";
    await requestOtp(email);
    const code = mailer.code(email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await verify({ email, code: wrong, acceptOffer: true, pdConsent: true });
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("OTP_INVALID");
    }
    const [row] = await api.deps.pg`select attempts from platform.auth_otps where email = ${email}`;
    expect(row?.attempts).toBe(5);
    expect((await verify({ email, code, acceptOffer: true, pdConsent: true })).status).toBe(401);
  });

  test("TTL 10 minutes: an expired code fails", async () => {
    const email = "late@example.ru";
    await requestOtp(email);
    const [row] = await api.deps
      .pg`select expires_at, created_at from platform.auth_otps where email = ${email}`;
    const ttl =
      (row as { expires_at: Date; created_at: Date }).expires_at.getTime() -
      (row as { expires_at: Date; created_at: Date }).created_at.getTime();
    expect(Math.abs(ttl - 600_000)).toBeLessThan(5_000);
    await api.deps
      .pg`update platform.auth_otps set expires_at = now() - interval '1 second' where email = ${email}`;
    const r = await verify({ email, code: mailer.code(email), acceptOffer: true, pdConsent: true });
    expect(r.status).toBe(401);
  });

  test("limits: 5/h per e-mail, 20/h per IP → 429 RATE_LIMITED; bad e-mail → 400", async () => {
    for (let i = 0; i < 5; i++) expect((await requestOtp("limit@example.ru")).status).toBe(204);
    const over = await requestOtp("limit@example.ru");
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("RATE_LIMITED");
    expectContract("requestOtp", over);
    for (let i = 0; i < 15; i++) expect((await requestOtp(`ip${i}@example.ru`)).status).toBe(204);
    expect((await requestOtp("fresh@example.ru")).status).toBe(429);
    expect((await requestOtp("not-an-email")).status).toBe(400);
  });

  test("login CSRF: auth operations need the platform Origin in session mode", async () => {
    expect((await requestOtp("csrf@example.ru", {})).status).toBe(403);
    expect((await requestOtp("csrf@example.ru", { origin: "http://evil.example" })).status).toBe(403);
    expect((await verify({ email: "csrf@example.ru", code: "123456" }, {})).status).toBe(403);
  });
});

describe("sessions", () => {
  test("cookies: HttpOnly session and readable CSRF cookie, Path=/, SameSite=Lax, no Domain, 30 days", async () => {
    await requestOtp("cookie@example.ru");
    const ok = await verify({
      email: "cookie@example.ru",
      code: mailer.code("cookie@example.ru"),
      acceptOffer: true,
      pdConsent: true,
    });
    const { raw, jar } = setCookies(ok);
    const sess = raw.find((c) => c.startsWith("wizard_session=")) as string;
    const csrf = raw.find((c) => c.startsWith("wizard_csrf=")) as string;
    expect(sess).toMatch(/; HttpOnly/);
    expect(csrf).not.toMatch(/HttpOnly/);
    for (const c of [sess, csrf]) {
      expect(c).toMatch(/; Path=\//);
      expect(c).toMatch(/; SameSite=Lax/);
      expect(c).not.toMatch(/Domain=/i);
      expect(Number(/Max-Age=(\d+)/.exec(c)?.[1])).toBeGreaterThan(29 * 86400);
    }
    const [row] = await api.deps
      .pg`select token_hash, csrf_hash from platform.sessions order by created_at desc limit 1`;
    expect(row?.token_hash).not.toBe(jar.wizard_session);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("no cookie → 401; unknown cookie → 401 and the cookies are cleared; duplicated cookie → 401", async () => {
    const none = await api.req("GET", "/systems");
    expect(none.status).toBe(401);
    expect(none.body.code).toBe("UNAUTHORIZED");
    const bad = await api.req("GET", "/me", {
      headers: { cookie: "wizard_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.getSetCookie().some((c) => /^wizard_session=;.*Max-Age=0/.test(c))).toBe(true);
    const s = await otpLogin(api, mailer, "dup@example.ru");
    const dup = await api.req("GET", "/me", {
      headers: {
        cookie: `wizard_session=${s.cookies.wizard_session}; wizard_session=${s.cookies.wizard_session}`,
      },
    });
    expect(dup.status).toBe(401);
  });

  test("mutating requests need X-Wizard-CSRF = CSRF cookie and the platform Origin", async () => {
    const s = await otpLogin(api, mailer, "mut@example.ru");
    const body = { name: "Команда" };
    expect((await s.req("POST", "/orgs", { body, headers: { "x-wizard-csrf": "" } })).status).toBe(403);
    expect((await s.req("POST", "/orgs", { body, headers: { "x-wizard-csrf": "forged" } })).status).toBe(403);
    expect((await s.req("POST", "/orgs", { body, headers: { origin: "http://evil.example" } })).status).toBe(
      403,
    );
    // Header and cookie equal but not this session's token (cookie tossing).
    const tossed = await s.req("POST", "/orgs", {
      body,
      headers: {
        "x-wizard-csrf": "x".repeat(43),
        cookie: `wizard_session=${s.cookies.wizard_session}; wizard_csrf=${"x".repeat(43)}`,
      },
    });
    expect(tossed.status).toBe(403);
    expect((await s.req("GET", "/orgs", { headers: { "x-wizard-csrf": "", origin: "" } })).status).toBe(200);
    const ok = await s.req("POST", "/orgs", { body });
    expect(ok.status).toBe(201);
    expectContract("createOrg", ok);
  });

  test("30-day sliding expiry; an expired or revoked session → 401; logout revokes", async () => {
    const s = await otpLogin(api, mailer, "slide@example.ru");
    const [row] = await api.deps.pg`select id from platform.sessions order by created_at desc limit 1`;
    await api.deps
      .pg`update platform.sessions set expires_at = now() + interval '2 days' where id = ${row?.id}`;
    const me = await s.req("GET", "/me");
    expect(me.status).toBe(200);
    expect(
      me.headers.getSetCookie().some((c) => c.startsWith("wizard_session=") && /Max-Age=259\d{4}/.test(c)),
    ).toBe(true);
    const [after] = await api.deps.pg`select expires_at from platform.sessions where id = ${row?.id}`;
    expect((after as { expires_at: Date }).expires_at.getTime() - Date.now()).toBeGreaterThan(29 * 86400_000);

    await api.deps
      .pg`update platform.sessions set expires_at = now() - interval '1 second' where id = ${row?.id}`;
    expect((await s.req("GET", "/me")).status).toBe(401);

    const s2 = await otpLogin(api, mailer, "slide@example.ru");
    const out = await s2.req("POST", "/auth/logout");
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie().some((c) => /^wizard_session=;/.test(c))).toBe(true);
    expect((await s2.req("GET", "/me")).status).toBe(401);
  });

  test("https: __Host-wizard_session / __Host-wizard_csrf with Secure and without Domain (L3-17)", async () => {
    const m = new MemoryMailer();
    const a = await startApi(tdb.url, {
      config: { authMode: "session", publicScheme: "https" },
      mailer: m,
      migrate: false,
    });
    try {
      await a.req("POST", "/auth/otp/request", { body: { email: "tls@example.ru" }, headers: h });
      const ok = await a.req("POST", "/auth/otp/verify", {
        body: { email: "tls@example.ru", code: m.code("tls@example.ru"), acceptOffer: true, pdConsent: true },
        headers: h,
      });
      const raw = ok.headers.getSetCookie();
      const sess = raw.find((c) => c.startsWith("__Host-wizard_session=")) as string;
      const csrf = raw.find((c) => c.startsWith("__Host-wizard_csrf=")) as string;
      for (const c of [sess, csrf]) {
        expect(c).toMatch(/; Secure/);
        expect(c).toMatch(/; Path=\//);
        expect(c).not.toMatch(/Domain=/i);
      }
      const s = asSession(a, ok, "tls@example.ru");
      expect((await s.req("GET", "/me")).status).toBe(200);
      expect((await s.req("POST", "/orgs", { body: { name: "TLS" } })).status).toBe(201);
    } finally {
      await a.dispose();
    }
  });
});

describe("dev ergonomics and startup", () => {
  test("dev-login exists only with WIZARD_AUTH_MODE=dev or WIZARD_DEV_LOGIN=1", async () => {
    expect(
      (await api.req("POST", "/auth/dev-login", { body: { email: "d@example.ru" }, headers: h })).status,
    ).toBe(404);
    const a = await startApi(tdb.url, {
      config: { authMode: "session", devLogin: true },
      mailer,
      migrate: false,
    });
    try {
      const s = await devLogin(a, "dev-login@example.ru");
      expect((await s.req("GET", "/me")).body.user.email).toBe("dev-login@example.ru");
      // The host guard is on with dev-login.
      const far = await a.req("GET", "/me", { headers: { host: "evil.example" } });
      expect(far.status).toBe(421);
    } finally {
      await a.dispose();
    }
  });

  test("dev mode keeps the M0 dev user; a session cookie wins over it", async () => {
    const a = await startApi(tdb.url, { config: { authMode: "dev" }, mailer, migrate: false });
    try {
      expect((await a.req("GET", "/me")).body.user.email).toBe("dev@wizard.local");
      const s = await devLogin(a, "cookie-in-dev@example.ru");
      expect((await s.req("GET", "/me")).body.user.email).toBe("cookie-in-dev@example.ru");
      // Cookie requests are CSRF-checked in dev mode too.
      expect(
        (await s.req("POST", "/orgs", { body: { name: "X" }, headers: { "x-wizard-csrf": "" } })).status,
      ).toBe(403);
    } finally {
      await a.dispose();
    }
  });

  test("assertStartupAllowed: dev auth / dev-login / unsafe exec refused in production, k8s, non-loopback", () => {
    const base = loadConfig({});
    expect(base.authMode).toBe("session");
    expect(() => assertStartupAllowed({ ...base, authMode: "dev", nodeEnv: "production" })).toThrow(
      /NODE_ENV/,
    );
    expect(() => assertStartupAllowed({ ...base, devLogin: true, nodeEnv: "production" })).toThrow(
      /NODE_ENV/,
    );
    expect(() => assertStartupAllowed({ ...base, authMode: "dev", kubernetes: true })).toThrow(/Kubernetes/);
    expect(() => assertStartupAllowed({ ...base, authMode: "dev" }, "0.0.0.0")).toThrow(/127\.0\.0\.1/);
    expect(() => assertStartupAllowed({ ...base, authMode: "dev" }, "127.0.0.1")).not.toThrow();
    expect(() => assertStartupAllowed({ ...base, authMode: "devv" })).toThrow();
    expect(() => assertStartupAllowed({ ...base, nodeEnv: "production" })).toThrow(/WIZARD_SECRETS_KEY/);
    expect(() =>
      assertStartupAllowed({ ...base, nodeEnv: "production", secretsKey: "k".repeat(44) }, "0.0.0.0"),
    ).not.toThrow();
    expect(loadConfig({ NODE_ENV: "production" }).publicScheme).toBe("https");
  });

  test("createPlatformApi refuses dev mode with NODE_ENV=production", async () => {
    await expect(
      createPlatformApi({
        config: { dbUrl: tdb.url, authMode: "dev", nodeEnv: "production" },
        migrate: false,
      }),
    ).rejects.toThrow(/NODE_ENV=production/);
  });
});
