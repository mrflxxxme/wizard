// M2-06: system URLs in the cloud (deploy.yaml#cloud.domains), getPreviewUrl with a one-time HMAC preview token
// (api.yaml#getPreviewUrl, L3-11) and the publish smoke reading the revision from the runtime's internal port (L3-19).
import { createServer, type Server } from "node:http";
import { verifyPreviewToken } from "@wizard/runtime";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { httpSmoke, prodUrl, systemOrigin } from "../src/publish/prod.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

const SECRET = "p".repeat(40);

describe("system origins", () => {
  test("localhost keeps the M0 port; a systems domain goes through the ingress", () => {
    const local = { runtimePort: 4100, systemsDomain: "localhost", publicScheme: "http" as const };
    expect(systemOrigin(local, "shop", "draft")).toBe("http://shop--draft.localhost:4100");
    expect(prodUrl(local, "shop")).toBe("http://shop.localhost:4100/");
    const cloud = { runtimePort: 4100, systemsDomain: "sys.example", publicScheme: "https" as const };
    expect(systemOrigin(cloud, "shop", "draft")).toBe("https://shop--draft.sys.example");
    expect(prodUrl(cloud, "shop")).toBe("https://shop.sys.example/");
    expect(prodUrl({ runtimePort: 4100 }, "shop")).toBe("http://shop.localhost:4100/");
  });
});

describe("publish smoke via the internal port", () => {
  const servers: Server[] = [];
  const listen = (handler: Parameters<typeof createServer>[1]) =>
    new Promise<number>((resolve) => {
      const s = createServer(handler).listen(0, "127.0.0.1", () =>
        resolve((s.address() as { port: number }).port),
      );
      servers.push(s);
    });
  afterAll(() => {
    for (const s of servers) s.close();
  });

  test("public health {status} only; the revision comes from the internal health with the system Host", async () => {
    const pub = await listen((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(req.url === "/_wizard/health" ? JSON.stringify({ status: "ok" }) : "{}");
    });
    let seenHost = "";
    const internal = await listen((req, res) => {
      seenHost = req.headers.host ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", system: "shop", env: "prod", revision: 7 }));
    });
    const url = `http://shop.localhost:${pub}/`;
    const input = { slug: "shop", systemKey: "k", revision: 7, url };
    expect(await httpSmoke(2000)(input)).toEqual({ ok: false, reason: "health → 200, revision undefined" });
    expect(await httpSmoke(2000, { internalUrl: `http://127.0.0.1:${internal}` })(input)).toEqual({
      ok: true,
    });
    expect(seenHost).toBe(`shop.localhost:${pub}`);
  });
});

describe("getPreviewUrl in the cloud (L3-11)", () => {
  let tdb: Awaited<ReturnType<typeof createTestDb>>;
  let api: TestApi;
  let systemId = "";

  beforeAll(async () => {
    tdb = await createTestDb("cloudurls");
    api = await startApi(tdb.url, {
      executors: fakeExecutors({ spec: "forum" }),
      createRouter: fakeRouterFactory(),
      config: { previewSecret: SECRET, systemsDomain: "sys.example", publicScheme: "https" },
    });
    const b = await startBuild(api);
    systemId = b.systemId;
    expect((await waitRun(api, b.buildRunId, ["succeeded"], 20_000)).status).toBe("succeeded");
  }, 60_000);
  afterAll(async () => {
    await api?.dispose();
    await tdb?.drop();
  });

  test("one-time HMAC token over {systemId, env, role, revision, platformUserId, exp ≤ 15 min, nonce}", async () => {
    const sys = await api.deps.db
      .selectFrom("platform.systems")
      .select(["schema_key", "slug", "preview_revision", "created_by"])
      .where("id", "=", systemId)
      .executeTakeFirstOrThrow();
    const before = Date.now();
    const r = await api.req("GET", `/systems/${systemId}/preview-url?role=participant`);
    expect(r.status, r.text).toBe(200);
    const url = new URL(r.body.url);
    expect(url.origin).toBe(`https://${sys.slug}--draft.sys.example`);
    expect(url.pathname).toBe("/_wizard/preview-login");
    expect(url.searchParams.get("next")).toBe("/");
    const check = verifyPreviewToken(SECRET, url.searchParams.get("t") ?? "", Date.now());
    if (!check.ok) throw new Error(check.reason);
    expect(check.claims).toMatchObject({
      systemId: sys.schema_key,
      env: "draft",
      role: "participant",
      revision: sys.preview_revision,
      platformUserId: sys.created_by,
    });
    // ≤ 15 min even for a runtime clock up to a minute behind the platform's.
    expect(verifyPreviewToken(SECRET, url.searchParams.get("t") ?? "", before - 50_000).ok).toBe(true);
    expect(check.claims.exp - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(new Date(r.body.expiresAt).getTime()).toBe(check.claims.exp);
    // The public role also gets a token (the draft gate needs a preview session), and every URL has a fresh nonce.
    const pub = await api.req("GET", `/systems/${systemId}/preview-url`);
    const t2 = new URL(pub.body.url).searchParams.get("t") ?? "";
    const c2 = verifyPreviewToken(SECRET, t2, Date.now());
    if (!c2.ok) throw new Error(c2.reason);
    expect(c2.claims.role).toBe("visitor");
    expect(c2.claims.nonce).not.toBe(check.claims.nonce);
  });
});
