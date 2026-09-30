// M1-07 data boundary: table import through schema + synthetic rows only (data-boundary.yaml#import.test) and the
// «только РФ» switch (PATCH /orgs/{orgId}/settings, #ru_only.effect, L3-42).
import { type AppSpec, validateSpec } from "@wizard/appspec";
import { createRouter, type LlmEvent, MemoryUsageSink, orgPolicyBus, type PolicyChange } from "@wizard/llm";
import { writeXlsx } from "@wizard/pii/import";
import { schemaName } from "@wizard/runtime";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { canaryGrid, canaryNeedles, canaryRows } from "../../../packages/pii/test/import-canaries.js";
import { migrateDraft } from "../src/agents/draft.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import { convertCell, loadRows } from "../src/imports/load.js";
import { proposeImport } from "../src/imports/pipeline.js";
import { createTestDb, fakeExecutors, fakeRouterFactory, startApi, type TestApi } from "./helpers.js";

const OPEN = { ruOnly: false, t1Restricted: false };
const ENV = {
  ZAI_BASE_URL: "http://mock.local/zai",
  ZAI_API_KEY: "k",
  CLOUDRU_BASE_URL: "http://mock.local/cloudru",
  CLOUDRU_API_KEY: "k",
};

function spec(): AppSpec {
  const r = validateSpec({
    specVersion: "1",
    app: { name: "Клиенты", locale: "ru" },
    entities: [
      {
        name: "client",
        label: "Клиент",
        fields: [
          { name: "full_name", label: "ФИО", type: "string", required: true, pii: "basic", piiKind: "fio" },
          { name: "phone", label: "Телефон", type: "phone", pii: "basic", piiKind: "phone" },
          { name: "email", label: "Почта", type: "email", pii: "basic", piiKind: "email" },
          { name: "city", label: "Город", type: "string" },
          { name: "total", label: "Сумма", type: "money" },
          { name: "note", label: "Комментарий", type: "text", pii: "basic", piiKind: "free_text" },
        ],
      },
    ],
    roles: [{ name: "manager", label: "Менеджер", access: "login", loginMethods: ["email_otp"] }],
    permissions: [{ role: "manager", entity: "client", ops: ["read", "create", "update", "delete"] }],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.spec;
}

const toolAnswer = (model: string) => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model,
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "propose_mapping",
              arguments: JSON.stringify({
                mappings: [
                  ["ФИО клиента", "full_name"],
                  ["Телефон", "phone"],
                  ["Почта", "email"],
                  ["Город", "city"],
                  ["Сумма заказа", "total"],
                  ["Комментарий", "note"],
                ].map(([column, field]) => ({
                  sheet: "Клиенты",
                  column,
                  action: "map",
                  entity: "client",
                  field,
                })),
              }),
            },
          },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 800, completion_tokens: 100, total_tokens: 900 },
});

/** Mock providers: records every request; T1 may hang until aborted. */
function mockFetch(o: { hangT1?: boolean } = {}) {
  const requests: { provider: "zai" | "cloudru"; body: string }[] = [];
  const waiters: Array<() => void> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const provider = String(url).includes("/zai") ? "zai" : "cloudru";
    const body = String(init?.body ?? "");
    requests.push({ provider, body });
    if (provider === "zai" && o.hangT1) {
      for (const w of waiters.splice(0)) w();
      await new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init?.signal?.reason)),
      );
    }
    const model = (JSON.parse(body) as { model: string }).model;
    return new Response(JSON.stringify(toolAnswer(model)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests, started: () => new Promise<void>((r) => waiters.push(r)) };
}

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let pg: postgres.Sql;
let api: TestApi;

beforeAll(async () => {
  tdb = await createTestDb("import", { migrator: true });
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
  });
  pg = postgres(tdb.url, { max: 2, onnotice: () => {} });
});
afterAll(async () => {
  await pg?.end();
  await api?.dispose();
  await tdb?.drop();
});

describe("import: only schema + synthetic rows reach T1 (data-boundary.yaml#import.test)", () => {
  test("xlsx with 50 canary rows → mock T1 sees no canary; the app schema holds all 50 rows", async () => {
    const s = spec();
    const systemKey = "imp0canary01";
    await migrateDraft(pg, { systemKey, spec: s, prevSpec: null });
    const rows = canaryRows(50);
    const file = writeXlsx([{ name: "Клиенты", rows: canaryGrid(rows) }]);
    const m = mockFetch();
    const sink = new MemoryUsageSink();
    const router = createRouter({ mode: "live", env: ENV, fetch: m.fetch, sink, sleep: async () => {} });

    const proposed = await proposeImport({
      router,
      file,
      filename: "clients.xlsx",
      spec: s,
      orgPolicy: OPEN,
      ctx: { orgId: DEFAULT_ORG_ID },
      seed: 11,
    });
    expect(m.requests.map((r) => r.provider)).toEqual(["zai"]);
    const needles = canaryNeedles(rows);
    for (const r of m.requests) for (const n of needles) expect(r.body, n).not.toContain(n);
    expect(sink.records.map((r) => [r.callType, r.tier, r.scrubbed])).toEqual([
      ["import_mapping", "T1", true],
    ]);
    expect(proposed.mapping.filter((x) => x.action === "map")).toHaveLength(6);
    // The profile for S-import carries no values either.
    const profileJson = JSON.stringify(proposed.profile);
    for (const r of rows) expect(profileJson).not.toContain(r.phone);

    const loaded = await loadRows(pg, {
      schema: schemaName(systemKey, "draft"),
      spec: s,
      table: proposed.table,
      payload: proposed.payload,
      mapping: proposed.mapping,
    });
    expect(loaded).toEqual({ rowsImported: 50, rowsSkipped: 0, byEntity: { client: 50 } });
    const db = await pg.unsafe(
      `select full_name, phone, email, city, total::float8 as total, note from ${schemaName(systemKey, "draft")}.client order by total`,
    );
    expect(db).toHaveLength(50);
    expect(db.map((r) => r.full_name)).toEqual(rows.map((r) => r.name));
    expect(db.map((r) => r.phone)).toEqual(rows.map((r) => r.phone.replace(/[^\d+]/g, "")));
    expect(db.map((r) => r.email)).toEqual(rows.map((r) => r.email));
    expect(db.map((r) => r.total)).toEqual(rows.map((r) => r.amount));
  });

  test("ruOnly org: the mapping call goes to T0; T1 is never contacted", async () => {
    const m = mockFetch();
    const router = createRouter({ mode: "live", env: ENV, fetch: m.fetch, sink: new MemoryUsageSink() });
    const out = await proposeImport({
      router,
      file: writeXlsx([{ name: "Клиенты", rows: canaryGrid(canaryRows(5)) }]),
      spec: spec(),
      orgPolicy: { ruOnly: true, t1Restricted: false },
      ctx: { orgId: DEFAULT_ORG_ID },
    });
    expect(m.requests.map((r) => r.provider)).toEqual(["cloudru"]);
    expect(out.mapping).toHaveLength(6);
  });

  test("files over the limits are refused with 413 before any LLM call", async () => {
    const m = mockFetch();
    const router = createRouter({ mode: "live", env: ENV, fetch: m.fetch, sink: new MemoryUsageSink() });
    await expect(
      proposeImport({
        router,
        file: writeXlsx([{ name: "S", rows: canaryGrid(canaryRows(5)) }]),
        spec: spec(),
        orgPolicy: OPEN,
        ctx: { orgId: DEFAULT_ORG_ID },
        limits: { maxCells: 10 },
      }),
    ).rejects.toMatchObject({ code: "TOO_MANY_CELLS", httpStatus: 413 });
    expect(m.requests).toHaveLength(0);
  });
});

describe("PATCH /orgs/{orgId}/settings (ruOnly)", () => {
  const path = `/orgs/${DEFAULT_ORG_ID}/settings`;

  test("owner only; readOnly fields ignored; unknown fields rejected", async () => {
    const editor = { "x-wizard-dev-user": "editor-m107@dev.localhost" };
    expect((await api.req("PATCH", path, { body: { ruOnly: true }, headers: editor })).status).toBe(403);
    expect((await api.req("PATCH", path, { body: { ruOnly: "yes" } })).status).toBe(400);
    expect((await api.req("PATCH", path, { body: { region: "91" } })).status).toBe(400);
    const r = await api.req("PATCH", path, {
      body: { ruOnly: false, buildModelLabel: "x", t1Restricted: false },
    });
    expect(r.status).toBe(200);
    expect(r.body.ruOnly).toBe(false);
  });

  test("switching ruOnly on publishes the change, aborts the org's in-flight T1 call and repeats it on T0", async () => {
    await api.deps.db
      .updateTable("platform.orgs")
      .set({ region_code: "77", t1_restricted: false })
      .where("id", "=", DEFAULT_ORG_ID)
      .execute();
    const seen: PolicyChange[] = [];
    const off = orgPolicyBus.subscribe((c) => seen.push(c));
    const m = mockFetch({ hangT1: true });
    const sink = new MemoryUsageSink();
    const events: LlmEvent[] = [];
    // A router as the run engine builds it: default (process-wide) policy bus.
    const router = createRouter({
      mode: "live",
      env: ENV,
      fetch: m.fetch,
      sink,
      onEvent: (e) => events.push(e),
    });
    const started = m.started();
    const call = router.route({
      callType: "build_ops",
      messages: [{ role: "user", content: "Собери CRM" }],
      orgPolicy: OPEN,
      ctx: { orgId: DEFAULT_ORG_ID },
    });
    await started;
    const r = await api.req("PATCH", path, { body: { ruOnly: true } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ruOnly: true, buildModelLabel: "модели в РФ" });
    const out = await call;
    off();
    expect(seen).toEqual([{ orgId: DEFAULT_ORG_ID, policy: { ruOnly: true, t1Restricted: false } }]);
    expect(out).toMatchObject({ tier: "T0", routeReason: "policy_ru_only", ruFallback: true });
    expect(m.requests.map((x) => x.provider)).toEqual(["zai", "cloudru"]);
    expect(sink.records.map((x) => [x.tier, x.status])).toEqual([
      ["T1", "aborted"],
      ["T0", "ok"],
    ]);
    expect(events.map((e) => e.type)).toEqual(["model_switched"]);
    const get = await api.req("GET", path);
    expect(get.body.ruOnly).toBe(true);
    await api.req("PATCH", path, { body: { ruOnly: false } });
  });
});

describe("convertCell (load_rows)", () => {
  const f = (type: string, extra: Record<string, unknown> = {}) =>
    ({ name: "x", label: "X", type, ...extra }) as never;
  test("types are converted or dropped, never passed through unchecked", () => {
    expect(convertCell(f("phone"), "8 (916) 123-45-67")).toBe("+79161234567");
    expect(convertCell(f("phone"), "позвонить")).toBeNull();
    expect(convertCell(f("email"), "not an email")).toBeNull();
    expect(convertCell(f("int"), "12")).toBe(12);
    expect(convertCell(f("int"), "1,5")).toBeNull();
    expect(convertCell(f("money"), "1 234,50")).toBe(1234.5);
    expect(convertCell(f("bool"), "да")).toBe(true);
    expect(convertCell(f("date"), "05.03.2024")).toBe("2024-03-05");
    expect(convertCell(f("datetime"), "2024-03-05T10:00:00")).toBe("2024-03-05T10:00:00+03:00");
    expect(convertCell(f("enum", { enum: [{ value: "new", label: "Новый" }] }), "новый")).toBe("new");
    expect(convertCell(f("enum", { enum: [{ value: "new", label: "Новый" }] }), "старый")).toBeNull();
    expect(convertCell(f("string"), "a".repeat(300))).toHaveLength(255);
  });
});
