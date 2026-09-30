// Host allowlist (421), tunnel headers (403), startup guards, CSRF/Origin, CORS, route stubs (501).

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostname, parseSystemHost } from "../src/http/guards.js";
import {
  assertStartupAllowed,
  createRuntimeApp,
  MemoryRegistry,
  type RuntimeApp,
  readEnv,
  StartupError,
  safeNext,
  startRuntime,
} from "../src/index.js";
import { devEnv, forumSpec, request } from "./helpers.js";

const HOST = "forum--draft.localhost:4100";
// No query in this file touches the database: guards run before any data access.
const sql = postgres("postgres://nobody@127.0.0.1:1/none", { max: 1, connect_timeout: 1 });
let rt: RuntimeApp;

beforeAll(async () => {
  rt = createRuntimeApp({ db: sql, registry: new MemoryRegistry(), env: devEnv });
  await rt.loadSystem({ systemKey: "aaaaaaaaaaaa", env: "draft", spec: forumSpec(), slug: "forum" });
});

afterAll(async () => {
  await sql.end({ timeout: 0 });
});

describe("host guard (deploy.yaml#local.host_guard)", () => {
  it.each([
    "evil.example",
    "evil.example:4100",
    "localhost.evil.example",
    "10.0.0.1:4100",
    "forum--draft.localhost.evil",
  ])("Host %s → 421", async (host) => {
    expect((await rt.fetch(request("GET", host, "/_wizard/health"))).status).toBe(421);
  });

  it("missing Host → 421", async () => {
    expect((await rt.fetch(new Request("http://127.0.0.1:4100/_wizard/health"))).status).toBe(421);
  });

  it.each(["localhost:4100", "127.0.0.1:4100", "[::1]:4100", "localhost", HOST])(
    "Host %s is allowed",
    async (host) => {
      expect((await rt.fetch(request("GET", host, "/_wizard/health"))).status).toBe(200);
    },
  );

  it.each([
    ["x-forwarded-for", "1.2.3.4"],
    ["x-forwarded-host", "evil.example"],
    ["forwarded", "for=1.2.3.4"],
    ["cf-connecting-ip", "1.2.3.4"],
  ])("%s in local mode → 403", async (name, value) => {
    const res = await rt.fetch(request("GET", HOST, "/_wizard/health", { headers: { [name]: value } }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
  });

  it("unknown system → 404 page, unknown label → 404", async () => {
    const res = await rt.fetch(request("GET", "nope--draft.localhost:4100", "/"));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Система не найдена");
    expect((await rt.fetch(request("GET", "forum--staging.localhost:4100", "/"))).status).toBe(404);
    expect((await rt.fetch(request("GET", "forum.localhost:4100", "/"))).status).toBe(404);
  });

  it("outside local mode foreign hosts are still 421 and tunnel headers pass", async () => {
    const prod = createRuntimeApp({
      db: sql,
      registry: new MemoryRegistry(),
      env: { ...devEnv, authModeDev: false, devLogin: false, systemsDomain: "sys.example" },
    });
    await prod.loadSystem({ systemKey: "bbbbbbbbbbbb", env: "prod", spec: forumSpec(), slug: "forum" });
    expect((await prod.fetch(request("GET", "platform.example", "/_wizard/health"))).status).toBe(421);
    const ok = await prod.fetch(
      request("GET", "forum.sys.example", "/_wizard/health", { headers: { "x-forwarded-for": "1.1.1.1" } }),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
  });
});

describe("startup guard (L3-11)", () => {
  const base = readEnv({ WIZARD_DEV_LOGIN: "1" });
  it("refuses production, Kubernetes and non-loopback binds", () => {
    expect(() => assertStartupAllowed({ ...base, nodeEnv: "production" })).toThrow(StartupError);
    expect(() =>
      assertStartupAllowed(readEnv({ WIZARD_DEV_LOGIN: "1", KUBERNETES_SERVICE_HOST: "10.0.0.1" })),
    ).toThrow(StartupError);
    expect(() => assertStartupAllowed(base, "0.0.0.0")).toThrow(StartupError);
    expect(() => assertStartupAllowed(base, "192.168.1.5")).toThrow(StartupError);
    expect(() => assertStartupAllowed(readEnv({ WIZARD_UNSAFE_LOCAL_EXEC: "1" }), "0.0.0.0")).toThrow(
      StartupError,
    );
    expect(() => assertStartupAllowed(base, "127.0.0.1")).not.toThrow();
    expect(() => assertStartupAllowed(base, "::1")).not.toThrow();
    expect(() => assertStartupAllowed(readEnv({}), "0.0.0.0")).not.toThrow();
  });

  it("createRuntimeApp and startRuntime refuse to start", async () => {
    expect(() =>
      createRuntimeApp({
        db: sql,
        registry: new MemoryRegistry(),
        env: { ...devEnv, nodeEnv: "production" },
      }),
    ).toThrow(StartupError);
    await expect(
      startRuntime({ db: sql, registry: new MemoryRegistry(), env: devEnv, hostname: "0.0.0.0", port: 0 }),
    ).rejects.toThrow(StartupError);
  });

  it("starts on loopback and serves health", async () => {
    const { close } = await startRuntime({
      db: sql,
      registry: new MemoryRegistry(),
      env: devEnv,
      port: 45_991,
    });
    try {
      const res = await fetch("http://127.0.0.1:45991/_wizard/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    } finally {
      await close();
    }
  });
});

describe("CSRF and CORS (L3-14)", () => {
  const noHeaders = { csrf: false } as const;
  it.each(["/api/data/stream", "/api/fn/partnerQuota", "/_wizard/qr/sync", "/api/auth/logout"])(
    "POST %s without Origin/X-Wizard-Request → 403",
    async (path) => {
      expect((await rt.fetch(request("POST", HOST, path, { ...noHeaders, body: {} }))).status).toBe(403);
      const wrongOrigin = request("POST", HOST, path, {
        ...noHeaders,
        body: {},
        headers: { origin: "http://evil--draft.localhost:4100", "x-wizard-request": "1" },
      });
      expect((await rt.fetch(wrongOrigin)).status).toBe(403);
      const noMarker = request("POST", HOST, path, {
        ...noHeaders,
        body: {},
        headers: { origin: `http://${HOST}` },
      });
      expect((await rt.fetch(noMarker)).status).toBe(403);
    },
  );

  it("PATCH/DELETE are checked too; hooks are exempt", async () => {
    expect((await rt.fetch(request("DELETE", HOST, "/api/data/stream/x", noHeaders))).status).toBe(403);
    expect(
      (await rt.fetch(request("PATCH", HOST, "/api/data/stream/x", { ...noHeaders, body: {} }))).status,
    ).toBe(403);
    expect(
      (await rt.fetch(request("POST", HOST, "/_wizard/hooks/yookassa/pay/abc", { ...noHeaders, body: {} })))
        .status,
    ).toBe(501);
  });

  it("never sends CORS headers; sets nosniff and frame-ancestors", async () => {
    const res = await rt.fetch(
      request("OPTIONS", HOST, "/api/data/stream", {
        headers: { origin: "http://evil.example", "access-control-request-method": "POST" },
      }),
    );
    for (const [k] of res.headers) expect(k.startsWith("access-control-")).toBe(false);
    const ok = await rt.fetch(request("GET", HOST, "/_wizard/health"));
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("content-security-policy")).toBe("frame-ancestors http://localhost:5173");
    for (const [k] of ok.headers) expect(k.startsWith("access-control-")).toBe(false);
  });
});

describe("route stubs for M0-23/M0-24 (501)", () => {
  it.each([
    ["POST", "/api/fn/partnerQuota"],
    ["GET", "/api/events"],
    ["GET", "/_wizard/qr/manifest"],
    ["POST", "/_wizard/qr/check"],
    ["GET", "/"],
    ["GET", "/tickets/123"],
  ])("%s %s → 501", async (method, path) => {
    const res = await rt.fetch(request(method, HOST, path, method === "POST" ? { body: {} } : {}));
    expect(res.status).toBe(501);
  });

  it("unknown /api and /_wizard paths → 404; internal endpoints are not on the public port", async () => {
    expect((await rt.fetch(request("GET", HOST, "/api/nope"))).status).toBe(404);
    expect((await rt.fetch(request("POST", HOST, "/_wizard/internal/reload", { body: {} }))).status).toBe(
      404,
    );
  });
});

describe("logging (runtime.yaml#logging)", () => {
  it("logs the route without query string and masks hook tokens", async () => {
    const lines: Record<string, unknown>[] = [];
    const app = createRuntimeApp({
      db: sql,
      registry: new MemoryRegistry(),
      env: devEnv,
      log: (l) => lines.push(l),
    });
    await app.loadSystem({ systemKey: "cccccccccccc", env: "draft", spec: forumSpec(), slug: "forum" });
    await app.fetch(request("GET", HOST, "/_wizard/health?phone=%2B79990000000"));
    await app.fetch(
      request("POST", HOST, "/_wizard/hooks/yookassa/pay/SECRETTOKEN", { csrf: false, body: {} }),
    );
    expect(lines.map((l) => l.route)).toEqual(["/_wizard/health", "/_wizard/hooks/yookassa/pay/***"]);
    expect(JSON.stringify(lines)).not.toMatch(/7999|SECRETTOKEN/);
    expect(lines[0]).toMatchObject({ system: "forum", env: "draft", status: 200 });
  });
});

describe("helpers", () => {
  it("safeNext accepts only local paths", () => {
    expect(safeNext("/a/b?c=1")).toBe("/a/b?c=1");
    for (const bad of ["//evil", "/\\evil", "http://x", "", null, undefined, "a/b", "/\nx"])
      expect(safeNext(bad)).toBe("/");
  });

  it("hostname / parseSystemHost", () => {
    expect(hostname("Forum--Draft.LOCALHOST:4100")).toBe("forum--draft.localhost");
    expect(hostname("[::1]:4100")).toBe("[::1]");
    expect(hostname("a b")).toBeNull();
    expect(parseSystemHost("my-app--draft.localhost", devEnv)).toEqual({
      kind: "system",
      slug: "my-app",
      env: "draft",
    });
    expect(parseSystemHost("my-app.localhost", devEnv)).toEqual({
      kind: "system",
      slug: "my-app",
      env: "prod",
    });
    expect(parseSystemHost("my-app--prod.localhost", devEnv)).toEqual({
      kind: "prod-redirect",
      slug: "my-app",
    });
    expect(parseSystemHost("a--b--draft.localhost", devEnv).kind).toBe("unknown");
    expect(parseSystemHost("x.y.localhost", devEnv).kind).toBe("unknown");
    expect(parseSystemHost("evil.example", devEnv).kind).toBe("foreign");
  });
});
