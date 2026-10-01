// M1-05: end-user login — email OTP, phone OTP (dev-sender, plan F4), Telegram OIDC (local stub), consent at the
// first login and its withdrawal, global OTP limits and the SMS budget (L3-25), session cookie names (L3-14),
// state/nonce/redirect_uri/next of OIDC (L3-26). Offline: codes go to the outbox, Telegram to a node:http stub.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppSpec, quoteIdent } from "@wizard/appspec";
import { newQrKeyring, QR_SECRET, serializeQrKeyring, staticSecretReader } from "@wizard/connectors";
import { testPlatform } from "@wizard/connectors/testing";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { authKeys, clientNetwork } from "../src/auth/keys.js";
import { OTP_LIMITS, pgOtpLimiter, SMS_DAILY_BUDGET } from "../src/auth/limits.js";
import { normalizePhone } from "../src/auth/otp.js";
import {
  createRuntimeApp,
  MemoryRegistry,
  migrateSystem,
  type RuntimeApp,
  type RuntimeAppOptions,
  type RuntimeEnv,
  StartupError,
  schemaName,
} from "../src/index.js";
import { buildRoleSpec } from "../src/rolespec.js";
import { DB_URL, devEnv, forumSpec, newKey, request } from "./helpers.js";

const BOT_TOKEN = "7000123:OWNloginBOTtokenOWNloginBOTtokenOWNlo";
const CLIENT_ID = "7000123";
const CLIENT_SECRET = "oidc_client_secret_for_tests";

let sql: postgres.Sql;
let role: string;
const schemas: string[] = [];
const apps: RuntimeApp[] = [];
const outboxDir = mkdtempSync(join(tmpdir(), "wz-login-outbox-"));
const artifactDir = mkdtempSync(join(tmpdir(), "wz-login-artifact-"));
let clock = new Date("2026-10-01T09:00:00Z");
const tick = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const logs: Record<string, unknown>[] = [];
const org = { start: randomUUID(), business: randomUUID() };

/** Forum where participants may also log in by phone (Старт/Бизнес). */
function loginSpec(): AppSpec {
  const spec = forumSpec();
  for (const r of spec.roles)
    if (r.name === "participant") r.loginMethods = ["email_otp", "phone_otp", "telegram"];
  return spec;
}

// ---------- Telegram OIDC stub (oauth.telegram.org: /token, /.well-known/jwks.json) ----------

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
type Grant = { challenge: string; claims: Record<string, unknown> };
const grants = new Map<string, Grant>();
const tokenRequests: { auth: string; body: URLSearchParams }[] = [];
let stub: Server;
let oauthBase = "";

function signJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${enc({ alg: "RS256", kid: "k1", typ: "JWT" })}.${enc(claims)}`;
  return `${data}.${sign("sha256", Buffer.from(data), privateKey).toString("base64url")}`;
}

function startStub(): Promise<void> {
  stub = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      if (req.url === "/.well-known/jwks.json") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (req.url === "/token" && req.method === "POST") {
        const body = new URLSearchParams(raw);
        tokenRequests.push({ auth: String(req.headers.authorization ?? ""), body });
        const g = grants.get(body.get("code") ?? "");
        const verifierOk =
          g &&
          createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url") === g.challenge;
        const authOk =
          req.headers.authorization ===
          `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
        if (!g || !verifierOk || !authOk || body.get("grant_type") !== "authorization_code") {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "x", token_type: "Bearer", id_token: signJwt(g.claims) }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolve) =>
    stub.listen(0, "127.0.0.1", () => {
      oauthBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

// ---------- runtime ----------

function secrets() {
  const reader = staticSecretReader({
    [QR_SECRET]: serializeQrKeyring(newQrKeyring()),
    telegram_bot_token: BOT_TOKEN,
    telegram_client_secret: CLIENT_SECRET,
  });
  return () => reader;
}

const SECRETS_KEY = randomBytes(24).toString("hex");

function makeApp(env: Partial<RuntimeEnv> = {}, extra: Partial<RuntimeAppOptions> = {}): RuntimeApp {
  const rt = createRuntimeApp({
    db: sql,
    registry: new MemoryRegistry(),
    dbRole: role,
    env: { ...devEnv, ...env },
    clock: () => clock,
    secrets: secrets(),
    platform: testPlatform(),
    outboxDir,
    log: (l) => logs.push(l),
    auth: {
      secretsKey: SECRETS_KEY,
      telegramOAuthBase: oauthBase,
      orgOf: async (entry) =>
        entry.slug.startsWith("lgpaid")
          ? { orgId: org.start, plan: "start" }
          : entry.slug.startsWith("lgbiz")
            ? { orgId: org.business, plan: "business" }
            : null,
    },
    ...extra,
  });
  apps.push(rt);
  return rt;
}

async function addSystem(
  rt: RuntimeApp,
  slug: string,
  env: "draft" | "prod",
  o: { phoneOtp?: boolean; artifactDir?: string; spec?: AppSpec } = {},
) {
  const key = newKey();
  const spec = o.spec ?? loginSpec();
  schemas.push(schemaName(key, env));
  await migrateSystem(sql, { systemId: key, env, spec, runtimeRole: role });
  await rt.loadSystem({
    systemKey: key,
    env,
    spec,
    slug,
    features: { phoneOtp: o.phoneOtp === true },
    artifactDir: o.artifactDir ?? null,
  });
  return {
    key,
    schema: schemaName(key, env),
    host: env === "draft" ? `${slug}--draft.localhost` : `${slug}.localhost`,
  };
}

let rt: RuntimeApp;
let A: Awaited<ReturnType<typeof addSystem>>; // draft (Free org)
let B: Awaited<ReturnType<typeof addSystem>>; // prod, Старт
let C: Awaited<ReturnType<typeof addSystem>>; // prod, Free

beforeAll(async () => {
  await startStub();
  sql = postgres(DB_URL, { max: 6, onnotice: () => {} });
  role = `wz_rt_login_${randomBytes(4).toString("hex")}`;
  await sql.unsafe(`CREATE ROLE ${quoteIdent(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  rt = makeApp();
  A = await addSystem(rt, "lgdraft", "draft");
  B = await addSystem(rt, "lgpaid", "prod", { phoneOtp: true });
  C = await addSystem(rt, "lgfree", "prod", { phoneOtp: false });
});

afterAll(async () => {
  for (const s of schemas) await sql.unsafe(`DROP SCHEMA IF EXISTS ${quoteIdent(s)} CASCADE`);
  await sql.unsafe(`DROP OWNED BY ${quoteIdent(role)}`).catch(() => {});
  await sql.unsafe(`DROP ROLE IF EXISTS ${quoteIdent(role)}`);
  await sql.end();
  await new Promise<void>((r) => stub.close(() => r()));
  rmSync(outboxDir, { recursive: true, force: true });
  rmSync(artifactDir, { recursive: true, force: true });
});

// ---------- helpers ----------

// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON bodies in assertions
type Json = Record<string, any>;

async function call(
  app: RuntimeApp,
  method: string,
  host: string,
  path: string,
  body?: unknown,
  cookie?: string,
) {
  const res = await app.fetch(request(method, host, path, { body, cookie }));
  const text = await res.text();
  let json: Json = {};
  try {
    json = JSON.parse(text) as Json;
  } catch {}
  return { res, json, text };
}

const uniqueEmail = () => `u-${randomBytes(5).toString("hex")}@example.ru`;
let phoneSeq = Math.floor(Math.random() * 1e6);
const uniquePhone = () =>
  `+79${String(Date.now() % 1e4).padStart(4, "0")}${String(phoneSeq++ % 1e5).padStart(5, "0")}`;

function lastCode(app: RuntimeApp, to: string): string {
  const m = [...app.outbox()].reverse().find((x) => (x.payload as Json)?.to === to);
  const text = String((m?.payload as Json)?.text ?? "");
  const code = /(\d{6})/.exec(text)?.[1];
  if (!code) throw new Error(`no code for ${to}`);
  return code;
}

async function consentOf(host: string) {
  const { json } = await call(rt, "GET", host, "/_wizard/spec");
  return { policyVersion: json.compliance.policyVersion, textHash: json.compliance.consentTextHash };
}

const cookieOf = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0];

async function otpLogin(
  app: RuntimeApp,
  host: string,
  channel: "email" | "phone",
  to: string,
  o: { role?: string; consent?: unknown } = {},
) {
  tick(61_000);
  const s = await call(app, "POST", host, "/api/auth/otp/start", { channel, destination: to, role: o.role });
  expect(s.res.status, s.text).toBe(200);
  const code = lastCode(app, to);
  return call(app, "POST", host, "/api/auth/otp/verify", {
    challengeId: s.json.challengeId,
    code,
    ...(o.consent ? { _consent: o.consent } : {}),
  });
}

// ---------- email OTP ----------

describe("email OTP", () => {
  test("new user: consent required at the first login, then session cookie and /me; next login without consent", async () => {
    const email = uniqueEmail();
    tick(61_000);
    const s = await call(rt, "POST", A.host, "/api/auth/otp/start", {
      channel: "email",
      destination: email,
      role: "participant",
    });
    expect(s.res.status).toBe(200);
    expect(s.json.challengeId).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]+$/);
    expect(s.json.challengeId).not.toContain(email);
    const code = lastCode(rt, email);
    const noConsent = await call(rt, "POST", A.host, "/api/auth/otp/verify", {
      challengeId: s.json.challengeId,
      code,
    });
    expect(noConsent.res.status).toBe(422);
    expect(noConsent.json.error.code).toBe("CONSENT_REQUIRED");
    const consent = await consentOf(A.host);
    const ok = await call(rt, "POST", A.host, "/api/auth/otp/verify", {
      challengeId: s.json.challengeId,
      code,
      _consent: consent,
    });
    expect(ok.res.status, ok.text).toBe(200);
    expect(ok.json.user).toMatchObject({ role: "participant", isAdmin: false });
    const sess = cookieOf(ok.res, "wz_sess");
    expect(sess).toBeDefined();
    expect(ok.res.headers.getSetCookie().join("\n")).toMatch(
      /wz_sess=[^;]+; Path=\/; HttpOnly; SameSite=Lax/,
    );
    expect(cookieOf(ok.res, "wz_prev")).toBeDefined(); // draft: preview cookie too
    const me = await call(rt, "GET", A.host, "/api/auth/me", undefined, sess);
    expect(me.json.user.id).toBe(ok.json.user.id);
    const [c] = await sql.unsafe(
      `select policy_version, encode(consent_text_hash, 'hex') as h from ${quoteIdent(A.schema)}._w_consents where entity = 'users' and row_id = $1`,
      [ok.json.user.id],
    );
    expect(c).toMatchObject({ policy_version: consent.policyVersion, h: consent.textHash });
    // The code is single-use.
    const again = await call(rt, "POST", A.host, "/api/auth/otp/verify", {
      challengeId: s.json.challengeId,
      code,
    });
    expect(again.json.error.code).toBe("OTP_INVALID");
    // Second login: consent already given.
    const second = await otpLogin(rt, A.host, "email", email);
    expect(second.res.status).toBe(200);
    expect(second.json.user.id).toBe(ok.json.user.id);
  });

  test("_w_otp keeps HMACs only: no contact, no code, 6 digits, TTL 5 min", async () => {
    const email = uniqueEmail();
    tick(61_000);
    const s = await call(rt, "POST", A.host, "/api/auth/otp/start", { channel: "email", destination: email });
    const id = String(s.json.challengeId).split(".")[0] as string;
    const code = lastCode(rt, email);
    const [row] = await sql.unsafe(`select * from ${quoteIdent(A.schema)}._w_otp where id = $1`, [id]);
    expect(row?.channel).toBe("email");
    expect(Buffer.from(row?.code_hash).length).toBe(32);
    expect(Buffer.from(row?.code_hash).toString("hex")).not.toBe(
      createHash("sha256").update(code).digest("hex"),
    );
    expect(JSON.stringify(row)).not.toContain(email);
    expect(new Date(row?.expires_at).getTime() - clock.getTime()).toBe(5 * 60_000);
    // No log line carries the address or the code.
    expect(JSON.stringify(logs)).not.toContain(email);
    expect(JSON.stringify(logs)).not.toContain(code);
  });

  test("5 wrong attempts kill the code; tampered or foreign challenge ids are rejected", async () => {
    const email = uniqueEmail();
    tick(61_000);
    const s = await call(rt, "POST", A.host, "/api/auth/otp/start", { channel: "email", destination: email });
    const code = lastCode(rt, email);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await call(rt, "POST", A.host, "/api/auth/otp/verify", {
        challengeId: s.json.challengeId,
        code: wrong,
      });
      expect(r.res.status).toBe(422);
      expect(r.json.error.code).toBe("OTP_INVALID");
    }
    const late = await call(rt, "POST", A.host, "/api/auth/otp/verify", {
      challengeId: s.json.challengeId,
      code,
    });
    expect(late.json.error.code).toBe("OTP_INVALID");

    tick(61_000);
    const s2 = await call(rt, "POST", A.host, "/api/auth/otp/start", {
      channel: "email",
      destination: uniqueEmail(),
    });
    const [id, sealed] = String(s2.json.challengeId).split(".") as [string, string];
    const tampered = `${id}.${sealed.slice(0, -2)}${sealed.endsWith("AA") ? "BB" : "AA"}`;
    const t = await call(rt, "POST", A.host, "/api/auth/otp/verify", {
      challengeId: tampered,
      code: "123456",
    });
    expect(t.json.error.code).toBe("OTP_INVALID");
    const foreign = await call(rt, "POST", C.host, "/api/auth/otp/verify", {
      challengeId: s2.json.challengeId,
      code: "123456",
    });
    expect(foreign.json.error.code).toBe("OTP_INVALID");
  });

  test("selfSignup vs invite: closed role → 403 after the code; an invited user logs in with the invited role", async () => {
    const closed = await otpLogin(rt, A.host, "email", uniqueEmail(), {
      role: "organizer",
      consent: await consentOf(A.host),
    });
    expect(closed.res.status).toBe(403);
    expect(closed.json.error.code).toBe("FORBIDDEN");
    const email = uniqueEmail();
    await sql.unsafe(`insert into ${quoteIdent(A.schema)}.users (role, email) values ('partner', $1)`, [
      email,
    ]);
    const invited = await otpLogin(rt, A.host, "email", email, { consent: await consentOf(A.host) });
    expect(invited.res.status, invited.text).toBe(200);
    expect(invited.json.user.role).toBe("partner");
    // Telegram is not a method of the partner role.
    const blocked = uniqueEmail();
    await sql.unsafe(
      `insert into ${quoteIdent(A.schema)}.users (role, email, blocked_at) values ('participant', $1, now())`,
      [blocked],
    );
    const b = await otpLogin(rt, A.host, "email", blocked, { consent: await consentOf(A.host) });
    expect(b.res.status).toBe(403);
  });

  test("invalid destination and unknown channel → 422", async () => {
    const bad = await call(rt, "POST", A.host, "/api/auth/otp/start", {
      channel: "email",
      destination: "not-an-email",
    });
    expect(bad.res.status).toBe(422);
    const ch = await call(rt, "POST", A.host, "/api/auth/otp/start", { channel: "fax", destination: "x" });
    expect(ch.res.status).toBe(422);
  });
});

// ---------- phone OTP and plans (F4) ----------

describe("phone OTP", () => {
  test("only +7 9xx numbers", () => {
    expect(normalizePhone("+7 (912) 345-67-89")).toBe("+79123456789");
    expect(normalizePhone("89123456789")).toBe("+79123456789");
    expect(normalizePhone("+74951234567")).toBeNull();
    expect(normalizePhone("+380501234567")).toBeNull();
  });

  test("draft of a Free org: method shown with the plan note, the code goes to the dev-sender test box", async () => {
    const spec = await call(rt, "GET", A.host, "/_wizard/spec");
    expect(spec.json.loginMethods).toContain("phone_otp");
    expect(spec.json.phoneOtpPlanNote).toBe(true);
    const phone = uniquePhone();
    const r = await otpLogin(rt, A.host, "phone", phone, {
      role: "participant",
      consent: await consentOf(A.host),
    });
    expect(r.res.status, r.text).toBe(200);
    const [u] = await sql.unsafe(`select phone from ${quoteIdent(A.schema)}.users where id = $1`, [
      r.json.user.id,
    ]);
    expect(u?.phone).toBe(phone);
    const lines = readFileSync(join(outboxDir, A.key, "sms.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines.some((l) => l.includes(phone))).toBe(true);
    const bad = await call(rt, "POST", A.host, "/api/auth/otp/start", {
      channel: "phone",
      destination: "+74951234567",
    });
    expect(bad.res.status).toBe(422);
  });

  test("prod on Free: no phone_otp in RoleSpec, a direct call → 403 LOGIN_METHOD_UNAVAILABLE", async () => {
    const spec = await call(rt, "GET", C.host, "/_wizard/spec");
    expect(spec.json.loginMethods).toEqual(["email_otp", "telegram"]);
    expect(spec.json.phoneOtpPlanNote).toBeUndefined();
    const r = await call(rt, "POST", C.host, "/api/auth/otp/start", {
      channel: "phone",
      destination: uniquePhone(),
    });
    expect(r.res.status).toBe(403);
    expect(r.json.error).toMatchObject({
      code: "LOGIN_METHOD_UNAVAILABLE",
      message: "Вход по телефону доступен на тарифах Старт и Бизнес",
    });
    // Email and Telegram stay on Free.
    const e = await otpLogin(rt, C.host, "email", uniqueEmail(), {
      role: "participant",
      consent: await consentOf(C.host),
    });
    expect(e.res.status).toBe(200);
  });

  test("prod on Старт: phone login with the dev-sender (local mode)", async () => {
    const spec = await call(rt, "GET", B.host, "/_wizard/spec");
    expect(spec.json.loginMethods).toEqual(["email_otp", "phone_otp", "telegram"]);
    const r = await otpLogin(rt, B.host, "phone", uniquePhone(), {
      role: "participant",
      consent: await consentOf(B.host),
    });
    expect(r.res.status, r.text).toBe(200);
    expect(r.res.headers.getSetCookie().join("\n")).not.toMatch(/SameSite=None/);
    expect(cookieOf(r.res, "wz_prev")).toBeUndefined();
  });

  test("buildRoleSpec: prod without the feature drops phone_otp; draft keeps it with the note", () => {
    const s = loginSpec();
    const compliance = { consentText: null, policyPage: null, policyVersion: "v", consentTextHash: "" };
    const prod = buildRoleSpec(s, { role: null, compliance, features: { phoneOtp: false }, env: "prod" });
    const draft = buildRoleSpec(s, { role: null, compliance, features: { phoneOtp: false }, env: "draft" });
    const paid = buildRoleSpec(s, { role: null, compliance, features: { phoneOtp: true }, env: "prod" });
    expect(prod.loginMethods).not.toContain("phone_otp");
    expect(draft.loginMethods).toContain("phone_otp");
    expect(draft.phoneOtpPlanNote).toBe(true);
    expect(paid.phoneOtpPlanNote).toBeUndefined();
  });
});

// ---------- limits (L3-25) ----------

describe("OTP limits", () => {
  test("resend after 60 s; per destination over all systems 5/h and 10/day → 429 with Retry-After", async () => {
    const email = uniqueEmail();
    const start = (host: string) =>
      call(rt, "POST", host, "/api/auth/otp/start", { channel: "email", destination: email });
    tick(3_600_000 * 25);
    expect((await start(A.host)).res.status).toBe(200);
    const again = await start(A.host);
    expect(again.res.status).toBe(429);
    expect(Number(again.res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(again.res.headers.get("retry-after"))).toBeLessThanOrEqual(OTP_LIMITS.resendAfterSec);
    // Other systems count too (global per destination).
    const hosts = [B.host, C.host, A.host, B.host];
    for (const h of hosts) {
      tick(61_000);
      expect((await start(h)).res.status).toBe(200);
    }
    tick(61_000);
    const sixth = await start(C.host);
    expect(sixth.res.status).toBe(429);
    expect(sixth.json.error.code).toBe("RATE_LIMITED");
    // After the hour: 5 more fit into the day, the 11th does not.
    tick(3_600_000);
    for (let i = 0; i < 5; i++) {
      tick(61_000);
      expect((await start([A.host, B.host, C.host][i % 3] as string)).res.status).toBe(200);
    }
    tick(3_600_000);
    const eleventh = await start(A.host);
    expect(eleventh.res.status).toBe(429);
    expect(Number(eleventh.res.headers.get("retry-after"))).toBeGreaterThan(3600);
  });

  test("per client network: 20/h in a system (IPv6 by /64)", async () => {
    const limiter = pgOtpLimiter(sql);
    const keys = authKeys(SECRETS_KEY, "test");
    const ip = keys.ip("2001:db8:1:2:aaaa::1");
    expect(ip?.equals(keys.ip("2001:db8:1:2:ffff::9") as Buffer)).toBe(true);
    expect(clientNetwork("::ffff:10.1.2.3")).toBe("10.1.2.3");
    const systemId = `iptest${randomBytes(3).toString("hex")}`;
    const now = new Date(clock.getTime() + 3_600_000 * 100);
    const send = () =>
      limiter.admit(
        {
          destination: randomBytes(32),
          systemId,
          env: "prod",
          channel: "email",
          ip,
          orgKey: null,
          billable: false,
          dailyBudget: 0,
        },
        now,
      );
    for (let i = 0; i < OTP_LIMITS.ipPerHour; i++) expect((await send()).ok).toBe(true);
    const v = await send();
    expect(v).toMatchObject({ ok: false, code: "RATE_LIMITED", reason: "ip_hour" });
  });

  test("SMS budget of the org per day: Старт 100 → 429 OTP_BUDGET_EXCEEDED; drafts do not spend it", async () => {
    expect(SMS_DAILY_BUDGET).toMatchObject({ start: 100, business: 300 });
    tick(3_600_000 * 24);
    for (let i = 0; i < 3; i++) {
      const r = await call(rt, "POST", A.host, "/api/auth/otp/start", {
        channel: "phone",
        destination: uniquePhone(),
      });
      expect(r.res.status).toBe(200);
    }
    const day = clock.toISOString().slice(0, 10);
    // Fill the budget of today directly (99 sends), then two through the API.
    await sql.unsafe(
      `insert into wz_runtime.otp_sends (destination_hmac, system_id, env, channel, org_key, billable, sent_at)
       select sha256(random()::text::bytea), $1, 'prod', 'phone', $2, true, $3::timestamptz from generate_series(1, 99)`,
      [B.key, `org:${org.start}`, `${day}T00:30:00Z`],
    );
    const last = await call(rt, "POST", B.host, "/api/auth/otp/start", {
      channel: "phone",
      destination: uniquePhone(),
    });
    expect(last.res.status, last.text).toBe(200);
    const over = await call(rt, "POST", B.host, "/api/auth/otp/start", {
      channel: "phone",
      destination: uniquePhone(),
    });
    expect(over.res.status).toBe(429);
    expect(over.json.error.code).toBe("OTP_BUDGET_EXCEEDED");
    expect(Number(over.res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(logs.some((l) => l.msg === "sms_budget_exceeded")).toBe(true);
    // Email is not an SMS.
    const mail = await call(rt, "POST", B.host, "/api/auth/otp/start", {
      channel: "email",
      destination: uniqueEmail(),
    });
    expect(mail.res.status).toBe(200);
  });
});

// ---------- Telegram OIDC (L3-26) ----------

describe("Telegram OIDC", () => {
  async function startTg(host: string, q: string) {
    const res = await rt.fetch(request("GET", host, `/api/auth/telegram/start?${q}`));
    const location = res.headers.get("location") ?? "";
    return {
      res,
      location,
      url: location.startsWith("http") ? new URL(location) : null,
      cookie: cookieOf(res, "wz_oidc"),
    };
  }

  async function callback(host: string, cookie: string | undefined, q: Record<string, string>) {
    const res = await rt.fetch(
      request("GET", host, `/api/auth/telegram/callback?${new URLSearchParams(q).toString()}`, { cookie }),
    );
    return { res, location: res.headers.get("location") ?? "" };
  }

  function grant(url: URL, claims: Record<string, unknown> = {}) {
    const code = randomBytes(12).toString("hex");
    const tgId = String(5_000_000_000 + Math.floor(Math.random() * 1e9));
    grants.set(code, {
      challenge: url.searchParams.get("code_challenge") ?? "",
      claims: {
        iss: oauthBase,
        aud: CLIENT_ID,
        sub: tgId,
        id: Number(tgId),
        name: "Тест Телеграмов",
        nonce: url.searchParams.get("nonce"),
        iat: Math.floor(clock.getTime() / 1000),
        exp: Math.floor(clock.getTime() / 1000) + 600,
        ...claims,
      },
    });
    return { code, tgId };
  }

  test("start: PKCE S256, state and nonce, fixed redirect_uri, sealed wz_oidc cookie for 10 min", async () => {
    const c = await consentOf(A.host);
    const s = await startTg(A.host, `role=participant&next=%2Fmy&pv=${c.policyVersion}&th=${c.textHash}`);
    expect(s.res.status).toBe(302);
    expect(s.url?.origin + (s.url?.pathname ?? "")).toBe(`${oauthBase}/auth`);
    const p = s.url?.searchParams;
    expect(p?.get("client_id")).toBe(CLIENT_ID);
    expect(p?.get("response_type")).toBe("code");
    expect(p?.get("redirect_uri")).toBe(`http://${A.host}/api/auth/telegram/callback`);
    expect(p?.get("scope")).toBe("openid telegram:bot_access phone");
    expect(p?.get("code_challenge_method")).toBe("S256");
    expect(p?.get("state")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(p?.get("nonce")).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const set = s.res.headers.getSetCookie().join("\n");
    expect(set).toMatch(/wz_oidc=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600/);
    expect(s.cookie).not.toContain(p?.get("state") ?? "-");
  });

  test("callback: code → id_token (JWKS, iss, aud, exp, nonce) → session, chat linked, redirect to next", async () => {
    const c = await consentOf(A.host);
    const s = await startTg(
      A.host,
      `role=participant&next=%2Fmy%3Ftab%3D1&pv=${c.policyVersion}&th=${c.textHash}`,
    );
    const url = s.url as URL;
    const { code, tgId } = grant(url);
    const r = await callback(A.host, s.cookie, { code, state: url.searchParams.get("state") ?? "" });
    expect(r.res.status).toBe(302);
    expect(r.location).toBe("/my?tab=1");
    const sess = cookieOf(r.res, "wz_sess");
    expect(sess).toBeDefined();
    expect(r.res.headers.getSetCookie().join("\n")).toMatch(
      /wz_oidc=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0/,
    );
    const last = tokenRequests.at(-1);
    expect(last?.body.get("redirect_uri")).toBe(`http://${A.host}/api/auth/telegram/callback`);
    expect(last?.body.get("client_id")).toBe(CLIENT_ID);
    const me = await call(rt, "GET", A.host, "/api/auth/me", undefined, sess);
    expect(me.json.user).toMatchObject({ role: "participant", displayName: "Тест Телеграмов" });
    const [u] = await sql.unsafe(
      `select telegram_id::text as t, telegram_chat_id::text as c from ${quoteIdent(A.schema)}.users where id = $1`,
      [me.json.user.id],
    );
    expect(u).toEqual({ t: tgId, c: tgId });
    // The state cookie is single-use in practice: the same callback again has no cookie after the redirect.
    const replay = await callback(A.host, undefined, { code, state: url.searchParams.get("state") ?? "" });
    expect(replay.location).toContain("error=OIDC_EXPIRED");
  });

  test("wrong state, wrong nonce, expired state, foreign aud → back to /login with an error; no session", async () => {
    const c = await consentOf(A.host);
    const q = `role=participant&pv=${c.policyVersion}&th=${c.textHash}`;
    let s = await startTg(A.host, q);
    let g = grant(s.url as URL);
    let r = await callback(A.host, s.cookie, { code: g.code, state: "x".repeat(22) });
    expect(r.location).toMatch(/^\/login\?error=OIDC_FAILED&method=telegram/);
    expect(cookieOf(r.res, "wz_sess")).toBeUndefined();

    s = await startTg(A.host, q);
    g = grant(s.url as URL, { nonce: "other-nonce" });
    r = await callback(A.host, s.cookie, {
      code: g.code,
      state: (s.url as URL).searchParams.get("state") ?? "",
    });
    expect(r.location).toContain("error=OIDC_FAILED");

    s = await startTg(A.host, q);
    g = grant(s.url as URL, { aud: "999" });
    r = await callback(A.host, s.cookie, {
      code: g.code,
      state: (s.url as URL).searchParams.get("state") ?? "",
    });
    expect(r.location).toContain("error=OIDC_FAILED");

    s = await startTg(A.host, q);
    g = grant(s.url as URL);
    tick(11 * 60_000);
    r = await callback(A.host, s.cookie, {
      code: g.code,
      state: (s.url as URL).searchParams.get("state") ?? "",
    });
    expect(r.location).toContain("error=OIDC_EXPIRED");
  });

  test("next is a local path only; a new user without consent → /login?error=CONSENT_REQUIRED", async () => {
    const s = await startTg(A.host, "role=participant&next=%2F%2Fevil.example");
    const g = grant(s.url as URL);
    const r = await callback(A.host, s.cookie, {
      code: g.code,
      state: (s.url as URL).searchParams.get("state") ?? "",
    });
    expect(r.location).toBe("/login?error=CONSENT_REQUIRED&method=telegram&next=%2F&role=participant");
    expect(r.location).not.toContain("evil");
  });

  test("Telegram works on Free prod; without an own-bot integration the method is unavailable", async () => {
    const s = await startTg(C.host, "role=participant");
    expect(s.res.status).toBe(302);
    expect(s.location.startsWith(`${oauthBase}/auth?`)).toBe(true);
    const spec = loginSpec();
    spec.integrations = (spec.integrations ?? []).filter((i) => i.connector !== "telegram");
    const D = await addSystem(rt, "lgnotg", "prod", { spec });
    const d = await startTg(D.host, "");
    expect(d.location).toBe("/login?error=LOGIN_METHOD_UNAVAILABLE&method=telegram&next=%2F");
  });
});

// ---------- cookies (L3-14) ----------

describe("session cookie", () => {
  test("https: only __Host-wz_sess (Secure) is accepted; wz_sess is ignored; duplicates → 401", async () => {
    const https = makeApp({ publicScheme: "https" });
    const H = await addSystem(https, "lghttps", "prod");
    const host = H.host;
    const req = (method: string, path: string, o: { body?: unknown; cookie?: string } = {}) =>
      https.fetch(
        new Request(`https://${host}${path}`, {
          method,
          headers: {
            host,
            ...(method !== "GET" ? { origin: `https://${host}`, "x-wizard-request": "1" } : {}),
            ...(o.body ? { "content-type": "application/json" } : {}),
            ...(o.cookie ? { cookie: o.cookie } : {}),
          },
          body: o.body ? JSON.stringify(o.body) : undefined,
        }),
      );
    const email = uniqueEmail();
    tick(61_000);
    const s = (await (
      await req("POST", "/api/auth/otp/start", {
        body: { channel: "email", destination: email, role: "participant" },
      })
    ).json()) as Json;
    const specRes = (await (await req("GET", "/_wizard/spec")).json()) as Json;
    const v = await req("POST", "/api/auth/otp/verify", {
      body: {
        challengeId: s.challengeId,
        code: lastCode(https, email),
        _consent: {
          policyVersion: specRes.compliance.policyVersion,
          textHash: specRes.compliance.consentTextHash,
        },
      },
    });
    expect(v.status).toBe(200);
    const set = v.headers.getSetCookie().join("\n");
    expect(set).toMatch(
      /^__Host-wz_sess=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/m,
    );
    expect(set).not.toMatch(/SameSite=None/);
    const token = cookieOf(v, "__Host-wz_sess")?.split("=")[1] as string;
    expect((await req("GET", "/api/auth/me", { cookie: `__Host-wz_sess=${token}` })).status).toBe(200);
    expect((await req("GET", "/api/auth/me", { cookie: `wz_sess=${token}` })).status).toBe(401);
    expect(
      (await req("GET", "/api/auth/me", { cookie: `__Host-wz_sess=${token}; __Host-wz_sess=${token}` }))
        .status,
    ).toBe(401);
    // Telegram state cookie is __Host- on https as well.
    const t = await req("GET", "/api/auth/telegram/start?role=participant");
    expect(t.headers.getSetCookie().join("\n")).toMatch(
      /^__Host-wz_oidc=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/m,
    );
    expect(new URL(t.headers.get("location") ?? "").searchParams.get("redirect_uri")).toBe(
      `https://${host}/api/auth/telegram/callback`,
    );
  });

  test("a session of one system is not accepted by another", async () => {
    const r = await otpLogin(rt, B.host, "email", uniqueEmail(), {
      role: "participant",
      consent: await consentOf(B.host),
    });
    const sess = cookieOf(r.res, "wz_sess");
    expect((await call(rt, "GET", B.host, "/api/auth/me", undefined, sess)).res.status).toBe(200);
    expect((await call(rt, "GET", C.host, "/api/auth/me", undefined, sess)).res.status).toBe(401);
  });

  test("NODE_ENV=production without a long WIZARD_SECRETS_KEY refuses to start", () => {
    expect(() =>
      createRuntimeApp({
        db: sql,
        registry: new MemoryRegistry(),
        env: { ...devEnv, authModeDev: false, devLogin: false, nodeEnv: "production" },
        auth: { secretsKey: "short" },
      }),
    ).toThrow(StartupError);
  });
});

// ---------- consent withdrawal and pages ----------

describe("consent withdrawal (L3-33)", () => {
  test("revoke: sessions end, login blocked, contacts and owned pii anonymized, audit row", async () => {
    const email = uniqueEmail();
    const r = await otpLogin(rt, A.host, "email", email, {
      role: "participant",
      consent: await consentOf(A.host),
    });
    const sess = cookieOf(r.res, "wz_sess") as string;
    const userId = r.json.user.id as string;
    const page = await call(rt, "GET", A.host, "/_wizard/privacy", undefined, sess);
    expect(page.text).toContain('data-testid="wz-privacy-revoke"');
    expect(page.res.headers.get("content-security-policy")).toContain("script-src 'self'");
    const js = await call(rt, "GET", A.host, "/_wizard/privacy.js");
    expect(js.text).toContain("/api/auth/consent/revoke");
    const guest = await call(rt, "GET", A.host, "/_wizard/privacy");
    expect(guest.text).toContain("/login?next=%2F_wizard%2Fprivacy");

    const rev = await call(rt, "POST", A.host, "/api/auth/consent/revoke", {}, sess);
    expect(rev.res.status).toBe(200);
    expect(rev.res.headers.getSetCookie().join("\n")).toMatch(/wz_sess=; .*Max-Age=0/);
    expect((await call(rt, "GET", A.host, "/api/auth/me", undefined, sess)).res.status).toBe(401);
    const [u] = await sql.unsafe(`select * from ${quoteIdent(A.schema)}.users where id = $1`, [userId]);
    expect(u?.email).toBeNull();
    expect(u?.blocked_at).not.toBeNull();
    const [a] = await sql.unsafe(
      `select op from ${quoteIdent(A.schema)}._w_audit where record_id = $1 and op like 'consent_revoked%'`,
      [userId],
    );
    expect(a?.op).toMatch(/^consent_revoked/);
    expect(JSON.stringify(logs.filter((l) => l.msg === "consent_revoked"))).not.toContain(userId);
    const unauth = await call(rt, "POST", A.host, "/api/auth/consent/revoke", {});
    expect(unauth.res.status).toBe(401);
  });

  test("owned rows: pii fields of rows where the user is the owner are anonymized", async () => {
    const r = await otpLogin(rt, A.host, "email", uniqueEmail(), {
      role: "speaker",
      consent: await consentOf(A.host),
    });
    const sess = cookieOf(r.res, "wz_sess") as string;
    const userId = r.json.user.id as string;
    const cols = await sql.unsafe<{ column_name: string }[]>(
      `select column_name from information_schema.columns where table_schema = $1 and table_name = 'speaker_application'`,
      [A.schema],
    );
    expect(cols.map((c) => c.column_name)).toContain("full_name");
    const spec = forumSpec();
    const ent = spec.entities.find((e) => e.name === "speaker_application");
    const values: Record<string, unknown> = {
      speaker_user: userId,
      full_name: "Иван Секретов",
      email: "ivan@example.ru",
    };
    for (const f of ent?.fields ?? []) {
      if (values[f.name] !== undefined || !f.required) continue;
      values[f.name] =
        f.type === "enum"
          ? f.enum?.[0]?.value
          : f.type === "int" || f.type === "money"
            ? 1
            : f.type === "bool"
              ? false
              : "Тема";
    }
    const names = Object.keys(values);
    await sql.unsafe(
      `insert into ${quoteIdent(A.schema)}.speaker_application (${names.map(quoteIdent).join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(values) as never[],
    );
    const rev = await call(rt, "POST", A.host, "/api/auth/consent/revoke", {}, sess);
    expect(rev.res.status).toBe(200);
    const [row] = await sql.unsafe(
      `select full_name, email, phone from ${quoteIdent(A.schema)}.speaker_application where speaker_user = $1`,
      [userId],
    );
    expect(row?.full_name).not.toBe("Иван Секретов");
    expect(row?.email).not.toBe("ivan@example.ru");
  });
});

describe("/login page", () => {
  test("serves the bundle (AppShell.Login) on prod; without a bundle — a plain page", async () => {
    mkdirSync(join(artifactDir, "client"), { recursive: true });
    writeFileSync(join(artifactDir, "client", "index.html"), "<!doctype html><div id=root>SPA</div>");
    const S = await addSystem(rt, "lgspa", "prod", { artifactDir });
    const spa = await call(rt, "GET", S.host, "/login?next=/x");
    expect(spa.text).toContain("SPA");
    expect(spa.res.headers.get("cache-control")).toBe("no-store");
    const plain = await call(rt, "GET", C.host, "/login");
    expect(plain.text).toContain("Вход в систему пока недоступен");
  });
});
