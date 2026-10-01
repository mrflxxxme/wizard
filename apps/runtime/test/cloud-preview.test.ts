// M2-06 app side of the cloud deployment:
// * preview-login with a one-time HMAC token, exp ≤ 15 min (runtime.yaml#auth.preview_login_M2, L3-11);
// * cloud drafts are closed without it; __Host-wz_prev SameSite=None; Partitioned only on *--draft, prod never (L3-15);
// * public health is {status} only, /_wizard/internal/* only on the internal port (L3-19).
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostCtx } from "../src/exec/executor.js";
import {
  issuePreviewToken,
  newPreviewNonce,
  PREVIEW_TOKEN_TTL_MS,
  type PreviewClaims,
  remoteCapabilityAuthorizer,
  SandboxRpc,
  startRuntime,
  verifyPreviewToken,
} from "../src/index.js";
import { DB_URL, forumSpec, type Harness, harness, request } from "./helpers.js";

const SECRET = "s".repeat(48);
const INTERNAL = "internal-token-0123456789";
const DOMAIN = "sys.example";
const D = `forum--draft.${DOMAIN}`;
const P = `forum.${DOMAIN}`;
const cloud = {
  authModeDev: false,
  devLogin: false,
  unsafeLocalExec: false,
  publicScheme: "https" as const,
  platformOrigin: "https://platform.example",
  systemsDomain: DOMAIN,
  previewSecret: SECRET,
  internalToken: INTERNAL,
};

let h: Harness;
let draftKey: string;
const rpc = new SandboxRpc({ key: new Uint8Array(32).fill(7) });

beforeAll(async () => {
  h = await harness(cloud, { rpc, version: "1.2.3" });
  draftKey = (await h.system("forum", forumSpec(), "draft")).key;
  await h.system("forum", forumSpec(), "prod");
});
afterAll(async () => {
  await h?.close();
});

const claims = (over: Partial<PreviewClaims> = {}): PreviewClaims => ({
  systemId: draftKey,
  env: "draft",
  role: "organizer",
  revision: 0,
  platformUserId: "7f1c2a9e-0000-4000-8000-000000000001",
  exp: Date.now() + 10 * 60_000,
  nonce: newPreviewNonce(),
  ...over,
});
const token = (over: Partial<PreviewClaims> = {}, secret = SECRET) => issuePreviewToken(secret, claims(over));
const login = (t: string, next = "/") =>
  h.rt.fetch(
    request("GET", D, `/_wizard/preview-login?t=${encodeURIComponent(t)}&next=${encodeURIComponent(next)}`),
  );
const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieHeader = (res: Response, name: string) =>
  setCookies(res)
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] as string;

describe("preview tokens (unit)", () => {
  it("round-trips; tampering, wrong secret, expiry and exp > 15 min are refused", () => {
    const now = Date.now();
    const c = claims({ exp: now + PREVIEW_TOKEN_TTL_MS });
    const t = issuePreviewToken(SECRET, c);
    expect(verifyPreviewToken(SECRET, t, now)).toEqual({ ok: true, claims: c });
    const [v, body, sig] = t.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ ...c, role: "moderator" })).toString("base64url");
    expect(verifyPreviewToken(SECRET, `${v}.${forged}.${sig}`, now)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verifyPreviewToken("x".repeat(40), t, now)).toEqual({ ok: false, reason: "signature" });
    expect(verifyPreviewToken(SECRET, `${v}.${body}`, now)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyPreviewToken(SECRET, t, c.exp)).toEqual({ ok: false, reason: "expired" });
    const long = issuePreviewToken(SECRET, claims({ exp: now + PREVIEW_TOKEN_TTL_MS + 1 }));
    expect(verifyPreviewToken(SECRET, long, now)).toEqual({ ok: false, reason: "too_long" });
  });

  it("only env=draft, well-formed claims and a ≥ 256-bit secret", () => {
    expect(() => issuePreviewToken(SECRET, { ...claims(), env: "prod" as "draft" })).toThrow();
    expect(() => issuePreviewToken(SECRET, { ...claims(), nonce: "short" })).toThrow();
    expect(() => issuePreviewToken(SECRET, { ...claims(), extra: 1 } as PreviewClaims)).toThrow();
    expect(() => issuePreviewToken("short", claims())).toThrow(/32 bytes/);
    expect(() => verifyPreviewToken("short", "p1.a.b")).toThrow(/32 bytes/);
  });
});

describe("cloud draft host (L3-11, L3-15)", () => {
  it("is closed without preview-login: pages and API → 404, dev-login does not exist", async () => {
    for (const path of ["/", "/_wizard/spec", "/api/auth/me", "/_wizard/dev-login?role=organizer"]) {
      const res = await h.rt.fetch(request("GET", D, path));
      expect(res.status, path).toBe(404);
    }
    const health = await h.rt.fetch(request("GET", D, "/_wizard/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("a valid token logs in once: __Host- cookies, preview cookie partitioned, nonce burnt", async () => {
    const t = token();
    const res = await login(t, "/tickets");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/tickets");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const [sess, prev] = setCookies(res);
    expect(sess).toMatch(/^__Host-wz_sess=[A-Za-z0-9_-]{43}; /);
    expect(sess?.split("; ")).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]),
    );
    expect(prev).toMatch(/^__Host-wz_prev=[A-Za-z0-9_-]{43}; /);
    expect(prev?.split("; ")).toEqual(
      expect.arrayContaining(["Path=/", "HttpOnly", "Secure", "SameSite=None", "Partitioned"]),
    );
    for (const c of [sess, prev]) expect(c).not.toMatch(/Domain=/i);
    // The framed preview carries only the partitioned cookie; it passes the draft gate and is the organizer.
    const cookie = cookieHeader(res, "__Host-wz_prev");
    const me = await h.rt.fetch(request("GET", D, "/api/auth/me", { cookie }));
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { role: string } }).user.role).toBe("organizer");
    expect((await h.rt.fetch(request("GET", D, "/_wizard/spec", { cookie }))).status).toBe(200);
    // Replay of the same token → 404, no cookies.
    const again = await login(t);
    expect(again.status).toBe(404);
    expect(setCookies(again)).toEqual([]);
    const nonces = await h.sql.unsafe(
      `select count(*)::int as n from "app_${draftKey}_draft"."_w_preview_nonces"`,
    );
    expect(nonces[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("forged, expired, too long, foreign-system, unknown-role tokens → 404", async () => {
    const bad = [
      token({}, "z".repeat(48)),
      token({ exp: Date.now() - 1000 }),
      token({ exp: Date.now() + PREVIEW_TOKEN_TTL_MS + 60_000 }),
      token({ systemId: "aaaaaaaaaaaa" }),
      token({ role: "nosuchrole" }),
      `${token().slice(0, -2)}xx`,
      "",
    ];
    for (const t of bad) {
      const res = await login(t);
      expect(res.status).toBe(404);
      expect(setCookies(res)).toEqual([]);
    }
  });

  it("next is a local path only (L3-26)", async () => {
    const res = await login(token(), "//evil.example/x");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("a public role gets through the gate as the public subject", async () => {
    const res = await login(token({ role: "visitor" }));
    expect(res.status).toBe(302);
    const cookie = cookieHeader(res, "__Host-wz_prev");
    expect((await h.rt.fetch(request("GET", D, "/_wizard/spec", { cookie }))).status).toBe(200);
    expect((await h.rt.fetch(request("GET", D, "/api/auth/me", { cookie }))).status).toBe(401);
  });

  it("a session cookie of another system does not open this draft", async () => {
    const res = await h.rt.fetch(request("GET", D, "/", { cookie: `__Host-wz_prev=${"a".repeat(43)}` }));
    expect(res.status).toBe(404);
  });
});

describe("cloud prod host (L3-15, L3-19)", () => {
  it("preview-login does not exist; no response carries SameSite=None", async () => {
    const t = token();
    const pl = await h.rt.fetch(request("GET", P, `/_wizard/preview-login?t=${encodeURIComponent(t)}`));
    expect(pl.status).toBe(404);
    const logout = await h.rt.fetch(
      request("POST", P, "/api/auth/logout", {
        csrf: false,
        headers: { origin: `https://${P}`, "x-wizard-request": "1" },
      }),
    );
    expect(logout.status).toBe(204);
    const page = await h.rt.fetch(request("GET", P, "/", { cookie: `__Host-wz_prev=${"a".repeat(43)}` }));
    const all = [pl, logout, page].flatMap(setCookies).join("\n");
    expect(all).not.toContain("SameSite=None");
    expect(all).not.toContain("wz_prev");
  });

  it("health on public hosts is only {status}", async () => {
    for (const host of [P, D]) {
      const res = await h.rt.fetch(request("GET", host, "/_wizard/health"));
      expect(await res.json()).toEqual({ status: "ok" });
    }
  });

  it("/_wizard/internal/* on the public port → 404 even with the internal token", async () => {
    for (const host of [P, D]) {
      const res = await h.rt.fetch(
        request("POST", host, "/_wizard/internal/reload", {
          csrf: false,
          headers: {
            "x-wizard-internal-token": INTERNAL,
            origin: `https://${host}`,
            "x-wizard-request": "1",
          },
          body: { systemId: draftKey, env: "draft" },
        }),
      );
      expect(res.status).toBe(404);
    }
  });
});

describe("internal port (L3-19)", () => {
  const internal = (
    path: string,
    init: { method?: string; host?: string; token?: string; body?: unknown } = {},
  ) =>
    h.rt.internalFetch(
      new Request(`http://127.0.0.1:4101${path}`, {
        method: init.method ?? "GET",
        headers: {
          host: init.host ?? "127.0.0.1:4101",
          ...(init.token ? { "x-wizard-internal-token": init.token } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      }),
    );

  it("health reports version, db and loaded systems; on a system Host also its revision", async () => {
    const bare = await internal("/_wizard/health");
    expect(bare.status).toBe(200);
    expect(await bare.json()).toMatchObject({ status: "ok", version: "1.2.3", db: "ok" });
    const sys = await internal("/_wizard/health", { host: P });
    expect(await sys.json()).toMatchObject({ status: "ok", system: "forum", env: "prod", revision: 0 });
  });

  it("reload needs the internal token (constant-time compare)", async () => {
    const body = { systemId: draftKey, env: "draft" };
    expect((await internal("/_wizard/internal/reload", { method: "POST", body })).status).toBe(403);
    expect(
      (await internal("/_wizard/internal/reload", { method: "POST", body, token: `${INTERNAL}x` })).status,
    ).toBe(403);
    const ok = await internal("/_wizard/internal/reload", { method: "POST", body, token: INTERNAL });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ evicted: false });
    const bad = await internal("/_wizard/internal/reload", {
      method: "POST",
      body: { systemId: draftKey, env: "x" },
      token: INTERNAL,
    });
    expect(bad.status).toBe(400);
    expect(
      (await internal("/_wizard/internal/unknown", { method: "POST", body, token: INTERNAL })).status,
    ).toBe(404);
  });

  it("egress-authorize: policy only for an open call; the proxy authorizer goes through it", async () => {
    const call = rpc.open({ systemId: draftKey, env: "draft", hostCtx: {} as HostCtx, timeoutMs: 5000 });
    const res = await internal("/_wizard/internal/egress-authorize", {
      method: "POST",
      token: INTERNAL,
      body: { token: call.token },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      https: expect.any(Array),
      smtp: expect.any(Array),
      label: draftKey,
    });
    const authorize = remoteCapabilityAuthorizer({
      runtimeInternalUrl: "http://127.0.0.1:4101",
      internalToken: INTERNAL,
      fetch: (async (url: string, init: RequestInit) =>
        h.rt.internalFetch(new Request(url, init))) as unknown as typeof fetch,
    });
    expect(await authorize(`Bearer ${call.token}`)).toMatchObject({ label: draftKey });
    expect(await authorize("Bearer v1.forged.token")).toBeNull();
    expect(await authorize(undefined)).toBeNull();
    call.close();
    const closed = await internal("/_wizard/internal/egress-authorize", {
      method: "POST",
      token: INTERNAL,
      body: { token: call.token },
    });
    expect(closed.status).toBe(403);
  });
});

describe("two listeners (startRuntime)", () => {
  const freePort = () =>
    new Promise<number>((resolve) => {
      const s = createServer().listen(0, "127.0.0.1", () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });

  it("internal paths answer only on the internal port", async () => {
    const postgres = (await import("postgres")).default;
    const db = postgres(DB_URL, { max: 2, onnotice: () => {} });
    const { MemoryRegistry } = await import("../src/index.js");
    const [port, internalPort] = [await freePort(), await freePort()];
    const srv = await startRuntime({
      db,
      registry: new MemoryRegistry(),
      port,
      internalPort,
      env: { ...cloud },
      files: null,
      retentionTickMs: 0,
    });
    try {
      const pub = await fetch(`http://127.0.0.1:${port}/_wizard/internal/reload`, {
        method: "POST",
        headers: { "x-wizard-internal-token": INTERNAL, "content-type": "application/json" },
        body: JSON.stringify({ systemId: "x", env: "draft" }),
      });
      expect(pub.status).toBe(404);
      expect(await (await fetch(`http://127.0.0.1:${port}/_wizard/health`)).json()).toEqual({ status: "ok" });
      const inner = await fetch(`http://127.0.0.1:${internalPort}/_wizard/health`);
      expect(await inner.json()).toMatchObject({ status: "ok", db: "ok" });
      const reload = await fetch(`http://127.0.0.1:${internalPort}/_wizard/internal/reload`, {
        method: "POST",
        headers: { "x-wizard-internal-token": INTERNAL, "content-type": "application/json" },
        body: JSON.stringify({ systemId: "x", env: "draft" }),
      });
      expect(reload.status).toBe(200);
    } finally {
      await srv.close();
      await db.end();
    }
  });
});
