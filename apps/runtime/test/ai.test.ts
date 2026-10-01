// M3-02 (runtime.yaml#ai_actions, L4-07, L3-41) in fixture mode: the button POST /api/ai/:action fills the target fields
// as __system and the record carries `_aiFilled`; a later user edit clears the mark; permissions and rowFilter are
// checked before anything is called; the public role is limited to 10 calls per hour per client network; generate
// output is stored as plain text; file fields go as image attachments (T0-only multimodal); workflow steps
// ai_extract/ai_generate run without self-trigger loops; the internal backfill fills old records and stops at a limit;
// a gateway answer that is not T0 is never written.
import { randomUUID } from "node:crypto";
import { resolveAiAction } from "@wizard/appspec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { aiRequest, findAiAction, runAiAction } from "../src/ai/actions.js";
import { rememberClientIp } from "../src/auth/client-ip.js";
import {
  AI_PUBLIC_PER_HOUR,
  type AiGatewayClient,
  httpAiGateway,
  type LoadedSystem,
  MemoryFileStorage,
} from "../src/index.js";
import {
  fixtureGateway,
  helpdeskSpec,
  LOGIN_TICKET,
  PAYMENT_TICKET,
  PNG_BYTES,
  scenario,
  type TestGateway,
} from "./ai-helpers.js";
import { type Harness, harness, login, request } from "./helpers.js";

const TOKEN = "internal-test-token";
let gateway: TestGateway;
let current: AiGatewayClient | null;
let h: Harness;
let now = new Date("2026-10-01T09:00:00Z");
const storage = new MemoryFileStorage();
const host = "helpdesk--draft.localhost";
let agent = "";
let viewer = "";

async function call(method: string, path: string, cookie: string | null, body?: unknown) {
  const res = await h.rt.fetch(request(method, host, path, { cookie, body }));
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked field by field
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, json, text };
}

async function ticket(values: Record<string, unknown>): Promise<string> {
  const r = await call("POST", "/api/data/ticket", agent, values);
  expect(r.res.status, r.text).toBe(201);
  return String(r.json.item.id);
}

const sys = async () => (await h.rt.systems.resolve("helpdesk", "draft")) as LoadedSystem;

beforeAll(async () => {
  gateway = fixtureGateway();
  current = gateway;
  // The gateway is read per call (services.ai): tests swap it through this proxy.
  const proxy: AiGatewayClient = {
    run: (req) => {
      if (!current) throw new Error("no gateway");
      return current.run(req);
    },
  };
  h = await harness({ internalToken: TOKEN }, { files: storage, clock: () => now, ai: proxy });
  await h.system("helpdesk", helpdeskSpec());
  agent = await login(h.rt, host, "agent");
  viewer = await login(h.rt, host, "viewer");
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe("request: what the runtime sends (and the fixtures are keyed by)", () => {
  test("the spec's actions resolve to the scenario actions of tools/fixtures/unit/runtime-ai.scenarios.json", async () => {
    const s = await sys();
    const id = await ticket(PAYMENT_TICKET);
    const row = { ...PAYMENT_TICKET, id };
    for (const [name, sc] of [
      ["classify_ticket", "classify_payment"],
      ["draft_reply", "reply_payment"],
    ] as const) {
      const req = await aiRequest(s, findAiAction(s, name), row, { callId: "x".repeat(8), source: "button" });
      expect(req.action).toEqual(scenario(sc).action);
      expect(req.record).toEqual(scenario(sc).record);
      expect(req.attachments).toBeUndefined();
    }
    const r = resolveAiAction(s.spec, s.spec.aiActions?.[0] as never);
    expect(r.ok).toBe(true);
  });

  test("a record without source values → 422 in Russian; no gateway → 503 AI_UNAVAILABLE", async () => {
    const s = await sys();
    const a = findAiAction(s, "read_photo");
    await expect(
      aiRequest(s, a, { title: "" }, { callId: "x".repeat(8), source: "button" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Для ИИ-действия нет данных: заполните «Тема», «Фото»",
    });
    const id = await ticket(PAYMENT_TICKET);
    await expect(
      runAiAction(s, null, { action: a, recordId: id, callId: "x".repeat(8), source: "button" }),
    ).rejects.toMatchObject({ code: "AI_UNAVAILABLE" });
  });
});

describe("button: POST /api/ai/:action", () => {
  test("extract fills the fields as __system; GET shows `_aiFilled`; a user edit clears the mark", async () => {
    const id = await ticket(PAYMENT_TICKET);
    const r = await call("POST", "/api/ai/classify_ticket", agent, { entity: "ticket", id });
    expect(r.res.status, r.text).toBe(200);
    expect(r.json.item).toMatchObject({ category: "billing", priority: 2 });
    expect(r.json.item._aiFilled.sort()).toEqual(["category", "priority"]);
    expect(r.json.filled.sort()).toEqual(["category", "priority"]);
    const got = await call("GET", `/api/data/ticket/${id}`, agent);
    expect(got.json.item._aiFilled.sort()).toEqual(["category", "priority"]);
    const edit = await call("PATCH", `/api/data/ticket/${id}`, agent, { category: "tech" });
    expect(edit.res.status, edit.text).toBe(200);
    const after = await call("GET", `/api/data/ticket/${id}`, agent);
    expect(after.json.item._aiFilled).toEqual(["priority"]);
  });

  test("unusable model values are skipped, not written (enum by label kept, priority 9 dropped)", async () => {
    const id = await ticket(LOGIN_TICKET);
    const r = await call("POST", "/api/ai/classify_ticket", agent, { entity: "ticket", id });
    expect(r.res.status, r.text).toBe(200);
    expect(r.json.item).toMatchObject({ category: "tech", priority: null });
    expect(r.json.skipped).toEqual(["priority"]);
    expect(r.json.item._aiFilled).toEqual(["category"]);
  });

  test("generate: an XSS payload is stored verbatim as plain text (no HTML processing on the server)", async () => {
    const id = await ticket(PAYMENT_TICKET);
    const r = await call("POST", "/api/ai/draft_reply", agent, { entity: "ticket", id });
    expect(r.res.status, r.text).toBe(200);
    expect(r.res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(r.json.item.reply).toBe(
      '<img src=x onerror="window.__wzXss=1"><script>window.__wzXss=2</script>Здравствуйте! Проверим платёж и вернёмся с ответом сегодня.',
    );
    expect(r.json.item._aiFilled).toEqual(["reply"]);
  });

  test("multimodal: the file field goes as an image attachment without its name", async () => {
    const form = new FormData();
    form.set("file", new File([PNG_BYTES], "Паспорт Иванова.png", { type: "image/png" }));
    form.set("field", "photo");
    const up = await h.rt.fetch(
      new Request("http://127.0.0.1:4100/api/files", {
        method: "POST",
        headers: { host, origin: `http://${host}`, "x-wizard-request": "1", cookie: agent },
        body: form,
      }),
    );
    const { fileId } = (await up.json()) as { fileId: string };
    expect(up.status).toBe(201);
    const id = await ticket({ title: "Не включается терминал", photo: fileId });
    gateway.calls = [];
    const r = await call("POST", "/api/ai/read_photo", agent, { entity: "ticket", id });
    expect(r.res.status, r.text).toBe(200);
    expect(r.json.item.serial).toBe("SN-12345");
    const sent = gateway.calls[0];
    expect(sent?.attachments).toEqual([{ mime: "image/png", data: PNG_BYTES.toString("base64") }]);
    expect(JSON.stringify(sent)).not.toContain("Паспорт");
  });

  test("no update permission → 403; unknown action or invisible record → 404; nothing is called", async () => {
    const id = await ticket(PAYMENT_TICKET);
    gateway.calls = [];
    const v = await call("POST", "/api/ai/classify_ticket", viewer, { entity: "ticket", id });
    expect(v.res.status).toBe(403);
    expect(v.json.error.message).toBe("Недостаточно прав для этого действия");
    const u = await call("POST", "/api/ai/no_such", agent, { entity: "ticket", id });
    expect(u.res.status).toBe(404);
    expect(u.json.error.message).toBe("ИИ-действие не найдено");
    const n = await call("POST", "/api/ai/classify_ticket", agent, { entity: "ticket", id: randomUUID() });
    expect(n.res.status).toBe(404);
    const w = await call("POST", "/api/ai/classify_ticket", agent, { entity: "other", id });
    expect(w.res.status).toBe(422);
    expect(gateway.calls).toHaveLength(0);
  });

  test("gateway refusals reach the user in Russian: 429 limit, 402 credits, 503 unavailable", async () => {
    const id = await ticket(PAYMENT_TICKET);
    const cases: [string, number, string][] = [
      ["AI_LIMIT_REACHED", 429, "Лимит ИИ-действий на этот месяц исчерпан"],
      ["AI_CREDITS_EXHAUSTED", 402, "ИИ-действие временно недоступно"],
      ["AI_UNAVAILABLE", 503, "ИИ-действие временно недоступно, попробуйте позже"],
    ];
    for (const [code, status, message] of cases) {
      gateway.failWith = code;
      const r = await call("POST", "/api/ai/classify_ticket", agent, { entity: "ticket", id });
      expect(r.res.status, code).toBe(status);
      expect(r.json.error).toMatchObject({ code, message });
    }
    gateway.failWith = null;
    const got = await call("GET", `/api/data/ticket/${id}`, agent);
    expect(got.json.item.category).toBeNull();
  });

  test("a non-T0 answer of the gateway is refused by the client and nothing is written", async () => {
    const id = await ticket(PAYMENT_TICKET);
    const t1 = httpAiGateway({
      url: "http://platform.test",
      token: "t",
      fetch: (async () =>
        Response.json({
          values: { category: "billing" },
          skipped: [],
          tier: "T1",
          model: "glm-5.3",
        })) as never,
    });
    current = t1;
    const r = await call("POST", "/api/ai/classify_ticket", agent, { entity: "ticket", id });
    current = gateway;
    expect(r.res.status).toBe(503);
    expect(r.json.error.code).toBe("AI_UNAVAILABLE");
    expect((await call("GET", `/api/data/ticket/${id}`, agent)).json.item.category).toBeNull();
  });
});

describe("public role (L3-41): ≤ 10 calls per hour per client network", () => {
  test("the 11th call within an hour → 429 RATE_LIMITED before the model; another network still passes", async () => {
    const id = await ticket({ ...PAYMENT_TICKET, is_public: true });
    const counting: TestGateway = {
      calls: [],
      failWith: null,
      async run(req) {
        counting.calls.push(req);
        return { values: {}, skipped: ["category", "priority"], tier: "T0", model: "m", creditsMilli: 0 };
      },
    };
    current = counting;
    const anon = (ip: string) => {
      const req = request("POST", host, "/api/ai/classify_ticket", { body: { entity: "ticket", id } });
      rememberClientIp(req, ip);
      return h.rt.fetch(req);
    };
    const statuses: number[] = [];
    for (let i = 0; i < AI_PUBLIC_PER_HOUR; i++) statuses.push((await anon("10.0.0.1")).status);
    expect(statuses).toEqual(Array(AI_PUBLIC_PER_HOUR).fill(200));
    const last = await anon("10.0.0.1");
    expect(last.status).toBe(429);
    expect(Number(last.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await last.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: "RATE_LIMITED",
      message: "Слишком много запросов, попробуйте позже",
    });
    expect(counting.calls).toHaveLength(AI_PUBLIC_PER_HOUR);
    // Another client network and a logged-in user are not in this bucket.
    expect((await anon("10.0.0.2")).status).toBe(200);
    expect((await call("POST", "/api/ai/classify_ticket", agent, { entity: "ticket", id })).res.status).toBe(
      200,
    );
    // An hour later the window is free again.
    now = new Date(now.getTime() + 3600_000 + 1000);
    expect((await anon("10.0.0.1")).status).toBe(200);
    current = gateway;
  });
});

describe("workflow steps ai_extract / ai_generate and the internal backfill", () => {
  let wf: Harness;
  let wfAgent = "";
  const wfHost = "helpdeskwf--draft.localhost";
  let wfGateway: TestGateway;
  let key = "";

  beforeAll(async () => {
    wfGateway = fixtureGateway();
    wf = await harness({ internalToken: TOKEN }, { files: null, ai: wfGateway });
    ({ key } = await wf.system(
      "helpdeskwf",
      helpdeskSpec([
        {
          name: "auto_classify",
          trigger: { type: "on_create", entity: "ticket" },
          steps: [{ type: "ai_extract", params: { action: "classify_ticket" } }],
        },
        {
          // No field: any update would start it again — its own AI fill must not (loop guard).
          name: "auto_reply",
          trigger: { type: "on_update", entity: "ticket" },
          steps: [{ type: "ai_generate", params: { action: "draft_reply" } }],
        },
      ]),
    ));
    wfAgent = await login(wf.rt, wfHost, "agent");
  }, 60_000);

  afterAll(async () => {
    await wf?.close();
  });

  const wfCall = async (method: string, path: string, body?: unknown) => {
    const res = await wf.rt.fetch(request(method, wfHost, path, { cookie: wfAgent, body }));
    // biome-ignore lint/suspicious/noExplicitAny: checked field by field
    return { res, json: (await res.json()) as any };
  };

  test("on_create → ai_extract; the resulting update → ai_generate once; the reply does not re-trigger", async () => {
    const c = await wfCall("POST", "/api/data/ticket", PAYMENT_TICKET);
    expect(c.res.status).toBe(201);
    const id = String(c.json.item.id);
    const report = await wf.rt.runJobs({ slug: "helpdeskwf", env: "draft" });
    expect(report.failed).toEqual([]);
    expect(report.ran).toBe(2);
    const got = await wfCall("GET", `/api/data/ticket/${id}`);
    expect(got.json.item).toMatchObject({ category: "billing", priority: 2 });
    expect(got.json.item.reply).toContain("Здравствуйте!");
    expect(got.json.item._aiFilled.sort()).toEqual(["category", "priority", "reply"]);
    expect(wfGateway.calls.map((r) => [r.source, r.action.name, r.callId.startsWith("wf:")])).toEqual([
      ["workflow", "classify_ticket", true],
      ["workflow", "draft_reply", true],
    ]);
    const again = await wf.rt.runJobs({ slug: "helpdeskwf", env: "draft" });
    expect(again.ran).toBe(0);
  });

  const backfill = (action: string, backfillId = randomUUID(), token = TOKEN) =>
    wf.rt.internalFetch(
      new Request("http://127.0.0.1:4101/_wizard/internal/ai-backfill", {
        method: "POST",
        headers: { "content-type": "application/json", "x-wizard-internal-token": token },
        body: JSON.stringify({ systemId: key, env: "draft", action, backfillId }),
      }),
    );

  test("internal backfill: old records with empty targets are filled once; a limit stops the walk", async () => {
    const s = (await wf.rt.systems.resolve("helpdeskwf", "draft")) as LoadedSystem;
    // Old rows written directly (no workflow run for them): both lack category/priority.
    for (const t of [PAYMENT_TICKET, LOGIN_TICKET])
      await wf.sql.unsafe(`insert into "${s.schema}"."ticket" (title, body) values ($1, $2)`, [
        t.title,
        t.body,
      ]);
    expect((await backfill("classify_ticket", undefined, "wrong")).status).toBe(403);
    expect((await backfill("no_such")).status).toBe(404);
    wfGateway.calls = [];
    const res = await backfill("classify_ticket");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ filled: 2, skipped: 0, stopCode: null });
    expect(wfGateway.calls.every((c) => c.source === "backfill" && c.callId.startsWith("bf:"))).toBe(true);
    const rows = await wf.sql.unsafe(`select category from "${s.schema}"."ticket" where category is null`);
    expect(rows).toHaveLength(0);
    // Nothing left to fill: a second backfill makes no calls.
    wfGateway.calls = [];
    expect(await (await backfill("classify_ticket")).json()).toEqual({
      filled: 0,
      skipped: 0,
      stopCode: null,
    });
    expect(wfGateway.calls).toHaveLength(0);
    // A refusal of the monthly limit stops the walk at the first record.
    await wf.sql.unsafe(`insert into "${s.schema}"."ticket" (title, body) values ($1, $2), ($1, $2)`, [
      PAYMENT_TICKET.title,
      PAYMENT_TICKET.body,
    ]);
    wfGateway.failWith = "AI_LIMIT_REACHED";
    wfGateway.calls = [];
    expect(await (await backfill("classify_ticket")).json()).toEqual({
      filled: 0,
      skipped: 0,
      stopCode: "AI_LIMIT_REACHED",
    });
    expect(wfGateway.calls).toHaveLength(1);
    wfGateway.failWith = null;
  });
});
