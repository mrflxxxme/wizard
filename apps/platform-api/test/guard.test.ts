// Acceptance M0-15 (L3-10, deploy.yaml#local.host_guard): Host outside loopback → 421; tunnel headers → 403;
// foreign Origin on non-GET → 403.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hostAllowed } from "../src/http/guard.js";
import { createTestDb, startApi, type TestApi } from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

beforeAll(async () => {
  tdb = await createTestDb("guard");
  api = await startApi(tdb.url);
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const get = (headers: Record<string, string>, a: TestApi = api) => a.req("GET", "/systems", { headers });

describe("host guard (dev mode)", () => {
  test.each([
    "localhost",
    "localhost:4000",
    "127.0.0.1:4000",
    "[::1]:4000",
    "[::1]",
    "forum--draft.localhost:4000",
  ])("Host %s → 200", async (host) => {
    expect((await get({ host })).status).toBe(200);
  });

  test.each(["evil.example", "evil.example:4000", "localhost.evil.example", "127.0.0.2:4000", "10.0.0.1"])(
    "Host %s → 421 HOST_NOT_ALLOWED",
    async (host) => {
      const r = await get({ host });
      expect(r.status).toBe(421);
      expect(r.body).toEqual({ code: "HOST_NOT_ALLOWED", message_ru: expect.any(String) });
    },
  );

  test.each([
    ["x-forwarded-for", "1.2.3.4"],
    ["x-forwarded-host", "localhost"],
    ["forwarded", "for=1.2.3.4"],
    ["cf-connecting-ip", "1.2.3.4"],
    ["cf-ray", "abc"],
  ])("%s → 403 FORBIDDEN", async (name, value) => {
    const r = await get({ host: "localhost:4000", [name]: value });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("FORBIDDEN");
  });

  test("non-GET with a foreign Origin → 403; with the platform origin → allowed", async () => {
    const body = { prompt: "Запись к мастеру" };
    const bad = await api.req("POST", "/systems", { body, headers: { origin: "http://evil.example" } });
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe("FORBIDDEN");
    const good = await api.req("POST", "/systems", { body, headers: { origin: "http://localhost:5173" } });
    expect(good.status).toBe(201);
    const getOk = await api.req("GET", "/systems", { headers: { origin: "http://evil.example" } });
    expect(getOk.status).toBe(200);
  });

  test("unknown paths are JSON 404 behind the same guard", async () => {
    const r = await api.fetch(new Request("http://localhost/nope", { headers: { host: "evil.example" } }));
    expect(r.status).toBe(421);
  });

  test("guard is off outside dev mode unless WIZARD_UNSAFE_LOCAL_EXEC=1", async () => {
    const off = await startApi(tdb.url, {
      config: { authMode: "session", unsafeLocalExec: false },
      migrate: false,
    });
    const on = await startApi(tdb.url, {
      config: { authMode: "session", unsafeLocalExec: true },
      migrate: false,
    });
    try {
      // No guard: the request reaches authentication (session mode, no cookie → 401).
      expect((await get({ host: "evil.example" }, off)).status).toBe(401);
      expect((await get({ host: "evil.example" }, on)).status).toBe(421);
    } finally {
      await off.dispose();
      await on.dispose();
    }
  });

  test("hostAllowed parser", () => {
    expect(hostAllowed("LOCALHOST:5173")).toBe(true);
    expect(hostAllowed("a.b.localhost")).toBe(true);
    expect(hostAllowed("localhost:99999999")).toBe(false);
    expect(hostAllowed("[::2]:80")).toBe(false);
    expect(hostAllowed("")).toBe(false);
  });
});
