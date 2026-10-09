// V3-20 acceptance 3 (runtime side): the system's own API /api/v1 on the system host — only a key of this system and
// env (sessions do not count, CSRF does not apply), scopes narrow the key's role, the data API keeps the role's
// permissions, hidden fields, rowFilter and RLS; OpenAPI 3.1 of what the key can do; requests per minute per key and
// failed attempts per address; an audit row per request without values. Forum spec, memory key store.
import { quoteIdent } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rememberClientIp } from "../src/auth/client-ip.js";
import { API_AUTH_FAILURES_PER_MINUTE, MemoryApiKeyStore, newApiKey } from "../src/index.js";
import { forumSpec, type Harness, harness, login, request, seedRow, seedUser } from "./helpers.js";

const spec = forumSpec();
const A = "shop--draft.localhost:4100";
const B = "other--draft.localhost:4100";
const store = new MemoryApiKeyStore();
let h: Harness;
let schema = "";
let keyA = "";
let keyB = "";
const keys: Record<string, string> = {};

const call = (host: string, method: string, path: string, key: string | null, body?: unknown) =>
  h.rt.fetch(
    request(method, host, path, {
      csrf: false,
      ...(body !== undefined ? { body } : {}),
      ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}),
    }),
  );
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;
const code = async (r: Response) => ((await json(r)).error as { code: string }).code;

beforeAll(async () => {
  h = await harness({}, { apiKeys: store });
  ({ key: keyA, schema } = await h.system("shop", spec));
  ({ key: keyB } = await h.system("other", spec));
  const base = { systemId: "00000000-0000-4000-8000-0000000000a1", systemKey: keyA, env: "draft" as const };
  keys.volunteer = store.add({
    ...base,
    name: "Сканер на входе",
    role: "volunteer",
    scopes: [
      { entity: "ticket", ops: ["read"] },
      { entity: "checkin", ops: ["read", "create"] },
    ],
  });
  keys.partner = store.add({
    ...base,
    name: "Партнёр",
    role: "partner",
    scopes: [{ entity: "partner_quota", ops: ["read"] }],
  });
  keys.onec = store.add({
    ...base,
    name: "1С",
    role: "organizer",
    scopes: [
      { entity: "stream", ops: ["read", "create", "update", "delete"] },
      { entity: "ticket", ops: ["read", "create"] },
      { fn: "ticketAvailability" },
    ],
  });
  keys.slow = store.add({
    ...base,
    name: "Медленный",
    role: "volunteer",
    scopes: [{ entity: "ticket", ops: ["read"] }],
    ratePerMinute: 2,
  });
  keys.prod = store.add({
    ...base,
    env: "prod",
    name: "Прод",
    role: "organizer",
    scopes: [{ entity: "stream", ops: ["read"] }],
  });
  keys.revoked = store.add({
    ...base,
    name: "Отозван",
    role: "organizer",
    scopes: [{ entity: "stream", ops: ["read"] }],
  });
  store.revoke(keys.revoked);
  keys.ghost = store.add({
    ...base,
    name: "Роль удалена",
    role: "ghost_role",
    scopes: [{ entity: "stream", ops: ["read"] }],
  });
  const partnerUser = await seedUser(h.sql, schema, "partner");
  await seedRow(h.sql, schema, spec, "partner_quota", {}, partnerUser);
  await seedRow(h.sql, schema, spec, "ticket");
});

afterAll(async () => {
  await h?.close();
});

describe("authentication by key only", () => {
  it("no key, a malformed key, an unknown key → 401 with WWW-Authenticate; a session cookie does not count", async () => {
    const none = await call(A, "GET", "/api/v1/data/stream", null);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await call(A, "GET", "/api/v1/data/stream", "wzk_short")).status).toBe(401);
    expect((await call(A, "GET", "/api/v1/data/stream", newApiKey().key)).status).toBe(401);
    const cookie = await login(h.rt, A, "organizer");
    const withCookie = await h.rt.fetch(request("GET", A, "/api/v1/data/stream", { cookie }));
    expect(withCookie.status).toBe(401);
  });

  it("a key of another system, of another env, a revoked key → 401; a key whose role left the spec → 403", async () => {
    expect((await call(B, "GET", "/api/v1/data/ticket", keys.volunteer as string)).status).toBe(401);
    expect((await call(A, "GET", "/api/v1/data/stream", keys.prod as string)).status).toBe(401);
    expect((await call(A, "GET", "/api/v1/data/stream", keys.revoked as string)).status).toBe(401);
    const ghost = await call(A, "GET", "/api/v1/data/stream", keys.ghost as string);
    expect(ghost.status).toBe(403);
    expect(keyB).not.toBe(keyA);
  });

  it("writes need no Origin or X-Wizard-Request: the key is the credential (CSRF does not apply)", async () => {
    const r = await call(A, "POST", "/api/v1/data/stream", keys.onec as string, {
      name: "Поток 1С",
      capacity: 50,
    });
    expect(r.status).toBe(201);
  });
});

describe("scopes ∩ role permissions ∩ RLS", () => {
  it("volunteer key: tickets without the hidden fields; a stream (the role may read it) is outside the scope → 403", async () => {
    const r = await call(A, "GET", "/api/v1/data/ticket", keys.volunteer as string);
    expect(r.status).toBe(200);
    const items = (await json(r)).items as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    for (const k of ["holder_name", "holder_email", "holder_phone", "amount", "qr_token"])
      expect(Object.hasOwn(items[0] as object, k)).toBe(false);
    expect((await call(A, "GET", "/api/v1/data/stream", keys.volunteer as string)).status).toBe(403);
    expect(await code(await call(A, "POST", "/api/v1/data/ticket", keys.volunteer as string, {}))).toBe(
      "FORBIDDEN",
    );
  });

  it("partner key: rowFilter $user.id has no user behind a key → 0 rows, the row by id → 404 (RLS holds)", async () => {
    const [row] = await h.sql.unsafe(`select id from ${quoteIdent(schema)}.partner_quota limit 1`);
    const r = await call(A, "GET", "/api/v1/data/partner_quota", keys.partner as string);
    expect(r.status).toBe(200);
    expect((await json(r)).items).toEqual([]);
    expect(
      (await call(A, "GET", `/api/v1/data/partner_quota/${row?.id}`, keys.partner as string)).status,
    ).toBe(404);
  });

  it("organizer key: full stream cycle; a scope wider than the role (ticket create) is still refused by the role", async () => {
    const created = await call(A, "POST", "/api/v1/data/stream", keys.onec as string, {
      name: "Главный зал",
      capacity: 300,
    });
    expect(created.status).toBe(201);
    const id = ((await json(created)).item as { id: string }).id;
    const patched = await call(A, "PATCH", `/api/v1/data/stream/${id}`, keys.onec as string, {
      capacity: 320,
    });
    expect(((await json(patched)).item as { capacity: number }).capacity).toBe(320);
    expect((await call(A, "DELETE", `/api/v1/data/stream/${id}`, keys.onec as string)).status).toBe(204);
    const ticket = await call(A, "POST", "/api/v1/data/ticket", keys.onec as string, { status: "paid" });
    expect(ticket.status).toBe(403);
  });

  it("functions: outside the scope → 403; in scope without the executor → 503 FUNCTIONS_DISABLED", async () => {
    expect((await call(A, "POST", "/api/v1/fn/partnerQuota", keys.onec as string, { args: {} })).status).toBe(
      403,
    );
    const r = await call(A, "POST", "/api/v1/fn/ticketAvailability", keys.onec as string, { args: {} });
    expect(await code(r)).toBe("FUNCTIONS_DISABLED");
  });
});

describe("OpenAPI of the key", () => {
  it("3.1, only the key's entities and operations, hidden fields absent, bearer security, server on the system host", async () => {
    const r = await call(A, "GET", "/api/v1/openapi.json", keys.volunteer as string);
    expect(r.status).toBe(200);
    const doc = await json(r);
    expect(doc.openapi).toBe("3.1.0");
    expect((doc.servers as { url: string }[])[0]?.url).toBe(`http://${A}/api/v1`);
    const paths = doc.paths as Record<string, Record<string, unknown>>;
    expect(Object.keys(paths).sort()).toEqual([
      "/data/checkin",
      "/data/checkin/{id}",
      "/data/ticket",
      "/data/ticket/{id}",
    ]);
    expect(Object.keys(paths["/data/ticket"] ?? {})).toEqual(["get"]);
    expect(Object.keys(paths["/data/checkin"] ?? {}).sort()).toEqual(["get", "post"]);
    const schemas = (doc.components as { schemas: Record<string, { properties: Record<string, unknown> }> })
      .schemas;
    expect(Object.keys(schemas.Ticket?.properties ?? {})).not.toContain("holder_phone");
    expect(Object.keys(schemas.Ticket?.properties ?? {})).toContain("status");
    expect((doc.components as { securitySchemes: unknown }).securitySchemes).toEqual({
      apiKey: { type: "http", scheme: "bearer", bearerFormat: "wzk_…" },
    });
  });
});

describe("limits and audit", () => {
  it("requests per minute per key → 429 with Retry-After", async () => {
    expect((await call(A, "GET", "/api/v1/data/ticket", keys.slow as string)).status).toBe(200);
    expect((await call(A, "GET", "/api/v1/data/ticket", keys.slow as string)).status).toBe(200);
    const third = await call(A, "GET", "/api/v1/data/ticket", keys.slow as string);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("failed key attempts from one address → 429 after the limit", async () => {
    let last = 0;
    for (let i = 0; i <= API_AUTH_FAILURES_PER_MINUTE; i++) {
      const req = request("GET", A, "/api/v1/data/stream", {
        headers: { authorization: `Bearer ${newApiKey().key}` },
      });
      rememberClientIp(req, "203.0.113.77");
      last = (await h.rt.fetch(req)).status;
    }
    expect(last).toBe(429);
  });

  it("every request of a key is journaled: method, target, status — no values, no key", async () => {
    const calls = store.calls.filter((c) => c.target === "data:ticket");
    expect(calls.some((c) => c.method === "GET" && c.status === 200)).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.status === 403)).toBe(true);
    expect(
      store.calls.some((c) => c.target === "data:stream/:id" && c.method === "DELETE" && c.status === 204),
    ).toBe(true);
    const text = JSON.stringify(store.calls);
    expect(text).not.toContain("wzk_");
    expect(text).not.toContain("Главный зал");
  });
});
