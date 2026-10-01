// M3-02 on the platform (runtime.yaml#ai_actions, billing.yaml#run_charging.runtime_ai, models.yaml#credits.runtime_ai,
// M2-15 cap): the internal AI gateway routes runtime_ai_* to T0 only (fixture mode, no network), journals the call and
// charges the org by fact — once per call id; the monthly limit aiAction.monthlyLimit and empty credits refuse without
// calling the model (402 with one owner notice per month); the platform LLM cap of the month counts AI calls and
// refuses with 503; a change card's aiBackfill runs in draft at the end of the build and in prod after publication.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRouter,
  type LlmAttachment,
  type RouteOutput,
  type Router,
  type RouterOptions,
} from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OutboxMailer } from "../src/auth/mailer.js";
import { moscowMonth } from "../src/billing/llm-cap.js";
import { DEV_USER_ID } from "../src/db/index.js";
import { listEvents } from "../src/runs/events.js";
import { type BuildHost, type BuildParams, RunFailure } from "../src/runs/types.js";
import { loadEventSchemas } from "./event-schemas.js";
import { startBuild } from "./flow.js";
import {
  createTestDb,
  fakeBuild,
  fakeCard,
  fakeExecutors,
  fakeInterview,
  fakeRouterFactory,
  ROOT,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

const TOKEN = "internal-ai-token";
const SC = JSON.parse(readFileSync(join(ROOT, "tools/fixtures/unit/runtime-ai.scenarios.json"), "utf8")) as {
  png: string;
  scenarios: {
    name: string;
    action: Record<string, unknown>;
    record: { label: string; value: string }[];
    attachments?: { mime: LlmAttachment["mime"] }[];
  }[];
};
const scenario = (n: string) => SC.scenarios.find((s) => s.name === n) as (typeof SC.scenarios)[number];

/** The fixture router whatever the env says (eval.yaml#fixtures, suite unit). */
const fixtureRouter = (o: RouterOptions): Router =>
  createRouter({ ...o, mode: "fixture", env: {}, fixture: { suite: "unit", name: "runtime-ai" } });

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let now = new Date();
let outbox: OutboxMailer;
let mailDir = "";

beforeAll(async () => {
  tdb = await createTestDb("ai");
  mailDir = mkdtempSync(join(tmpdir(), "wz-ai-mail-"));
  outbox = new OutboxMailer(mailDir);
  api = await startApi(tdb.url, {
    config: { internalToken: TOKEN },
    createRouter: fixtureRouter,
    mailer: outbox,
    now: () => now,
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  if (mailDir) rmSync(mailDir, { recursive: true, force: true });
});

async function newSystem(o: { drained?: boolean; owner?: string } = {}) {
  const db = api.deps.db;
  const org = await db
    .insertInto("platform.orgs")
    .values({ name: "Поддержка", plan: "free", region_code: "77", created_at: now })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (o.owner) {
    const u = await db
      .insertInto("platform.users")
      .values({ email: o.owner })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("platform.memberships")
      .values({ org_id: org.id, user_id: u.id, role: "owner" })
      .execute();
  }
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const sys = await db
    .insertInto("platform.systems")
    .values({
      org_id: org.id,
      slug: `ai-${key}`,
      schema_key: key,
      name: "Поддержка",
      created_by: DEV_USER_ID,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (o.drained)
    await db.transaction().execute(async (trx) => {
      const billing = api.deps.billing;
      await billing.settleOrg(trx, org.id);
      const { available } = await billing.balance(trx, org.id);
      await billing.adjust(trx, org.id, { amountMilli: -available, key: `drain:${org.id}`, note: "тест" });
    });
  return { orgId: org.id, systemId: sys.id, key };
}

function body(key: string, name: string, extra: Record<string, unknown> = {}) {
  const s = scenario(name);
  return {
    systemKey: key,
    env: "prod",
    callId: `btn:${randomUUID()}`,
    source: "button",
    monthlyLimit: 50,
    action: s.action,
    record: s.record,
    ...(s.attachments ? { attachments: s.attachments.map((a) => ({ mime: a.mime, data: SC.png })) } : {}),
    ...extra,
  };
}

async function run(b: unknown, token = TOKEN, target: TestApi = api) {
  const res = await target.fetch(
    new Request("http://localhost:4000/internal/v1/ai/run", {
      method: "POST",
      headers: {
        host: "localhost:4000",
        "content-type": "application/json",
        "x-wizard-internal-token": token,
      },
      body: JSON.stringify(b),
    }),
  );
  // biome-ignore lint/suspicious/noExplicitAny: checked field by field
  return { status: res.status, json: (await res.json()) as any };
}

const llmCalls = (systemId: string) =>
  api.deps.db.selectFrom("platform.llm_calls").selectAll().where("system_id", "=", systemId).execute();
const charges = (orgId: string) =>
  api.deps.db
    .selectFrom("platform.credit_ledger")
    .selectAll()
    .where("org_id", "=", orgId)
    .where("kind", "=", "charge")
    .execute();

describe("internal gateway: T0 only, journal and charge by fact", () => {
  test("extract: T0 answer, llm_calls rows T0/runtime_ai_extract, one ledger charge keyed by the call", async () => {
    const s = await newSystem();
    const b = body(s.key, "classify_payment");
    const r = await run(b);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({
      values: { category: "billing", priority: 2 },
      tier: "T0",
      model: "gpt-oss-120b",
    });
    expect(r.json.creditsMilli).toBeGreaterThan(0);
    const calls = await llmCalls(s.systemId);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls)
      expect([c.tier, c.call_type, c.agent_role]).toEqual(["T0", "runtime_ai_extract", "runtime"]);
    const ch = await charges(s.orgId);
    expect(ch).toHaveLength(1);
    expect(ch[0]?.idempotency_key).toBe(`ai:${s.systemId}:${now.toISOString().slice(0, 13)}:${b.callId}`);
    expect(-Number(ch[0]?.amount_milli)).toBe(r.json.creditsMilli);
    expect(ch[0]?.system_id).toBe(s.systemId);
    const journal = await api.deps.db
      .selectFrom("platform.ai_action_calls")
      .selectAll()
      .where("id", "=", b.callId)
      .execute();
    expect(journal).toMatchObject([
      { status: "ok", source: "button", call_type: "runtime_ai_extract", env: "prod" },
    ]);
    expect(Number(journal[0]?.credits_milli)).toBe(r.json.creditsMilli);

    // The same call id again (a retry): no second charge, no second journal row.
    const again = await run(b);
    expect(again.status).toBe(200);
    expect(again.json.creditsMilli).toBe(0);
    expect(await charges(s.orgId)).toHaveLength(1);
  });

  test("generate (plain text) and multimodal (image) go to T0; the journal holds no values", async () => {
    const s = await newSystem();
    const g = await run(body(s.key, "reply_payment"));
    expect(g.status).toBe(200);
    expect(g.json.values.reply).toContain("<script>");
    const m = await run(body(s.key, "photo_serial"));
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    expect(m.json.values).toEqual({ serial: "SN-12345" });
    for (const c of await llmCalls(s.systemId)) expect(c.tier).toBe("T0");
    const rows = await api.deps.db
      .selectFrom("platform.ai_action_calls")
      .selectAll()
      .where("system_id", "=", s.systemId)
      .execute();
    expect(JSON.stringify(rows)).not.toContain("SN-12345");
    expect(JSON.stringify(rows)).not.toContain("Здравствуйте");
  });

  test("a router answering from T1 is refused: 503, nothing charged, journal error T1_FORBIDDEN", async () => {
    const hostile = await startApi(tdb.url, {
      config: { internalToken: TOKEN },
      migrate: false,
      recover: false,
      createRouter: () =>
        ({
          mode: "fixture",
          registry: {} as Router["registry"],
          route: async (): Promise<RouteOutput> => ({
            tier: "T1",
            model: "glm-5.3",
            result: { text: "x", toolCalls: [], finishReason: "stop" },
            usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1 },
            creditsCharged: 1,
            creditsMilli: 1000,
            routeReason: "default_T1",
            scrubbed: true,
            ruFallback: false,
          }),
        }) as Router,
    });
    try {
      const s = await newSystem();
      const b = body(s.key, "reply_payment");
      const r = await run(b, TOKEN, hostile);
      expect(r.status).toBe(503);
      expect(r.json).toEqual({
        code: "AI_UNAVAILABLE",
        message_ru: "ИИ-действие временно недоступно, попробуйте позже",
      });
      expect(await charges(s.orgId)).toHaveLength(0);
      const j = await api.deps.db
        .selectFrom("platform.ai_action_calls")
        .selectAll()
        .where("id", "=", b.callId)
        .executeTakeFirst();
      expect(j).toMatchObject({ status: "error", error_code: "T1_FORBIDDEN" });
    } finally {
      await hostile.dispose();
    }
  });

  test("token: wrong → 403; an invalid body → 400; unknown system → 404", async () => {
    const s = await newSystem();
    expect((await run(body(s.key, "classify_payment"), "wrong-token-wrong")).status).toBe(403);
    expect((await run({ systemKey: s.key })).status).toBe(400);
    const u = await run(body("zzzzzzzzzzzz", "classify_payment"));
    expect(u).toEqual({ status: 404, json: { code: "NOT_FOUND", message_ru: "Система не найдена" } });
  });
});

describe("Billing.chargeAi (billing.yaml#run_charging.runtime_ai)", () => {
  test("charges by fact up to what is available, once per call id, into the hour bucket of the call", async () => {
    const s = await newSystem();
    const billing = api.deps.billing;
    const db = api.deps.db;
    await db.transaction().execute(async (trx) => {
      await billing.settleOrg(trx, s.orgId);
      const { available } = await billing.balance(trx, s.orgId);
      // Leave 0.5 credit: the charge never goes below zero, the platform bears the rest.
      await billing.adjust(trx, s.orgId, {
        amountMilli: -(available - 500),
        key: `drain:${s.orgId}`,
        note: "тест",
      });
    });
    const at = new Date("2026-10-05T13:45:00Z");
    const charge = (callId: string, amountMilli: number) =>
      db.transaction().execute((trx) =>
        billing.chargeAi(trx, {
          orgId: s.orgId,
          systemId: s.systemId,
          callId,
          at,
          amountMilli,
          action: "a",
        }),
      );
    expect(await charge("btn:one", 2000)).toBe(500);
    expect(await charge("btn:one", 2000)).toBe(0);
    expect(await charge("btn:two", 0)).toBe(0);
    const rows = await charges(s.orgId);
    expect(rows.map((r) => [r.idempotency_key, Number(r.amount_milli), r.note_ru])).toEqual([
      [`ai:${s.systemId}:2026-10-05T13:btn:one`, -500, "ИИ-действие «a»"],
    ]);
    const bal = await billing.readBalance(db, s.orgId);
    expect(bal.available).toBe(0);
  });
});

describe("limits: monthly limit, credits, platform cap — refused without a model call", () => {
  test("monthlyLimit per system and action in the Moscow month; a retried call is not counted twice", async () => {
    const s = await newSystem();
    const first = body(s.key, "classify_payment", { monthlyLimit: 2 });
    expect((await run(first)).status).toBe(200);
    expect((await run(body(s.key, "classify_login", { monthlyLimit: 2 }))).status).toBe(200);
    const before = (await llmCalls(s.systemId)).length;
    const third = await run(body(s.key, "classify_payment", { monthlyLimit: 2 }));
    expect(third).toEqual({
      status: 429,
      json: { code: "AI_LIMIT_REACHED", message_ru: "Лимит ИИ-действий на этот месяц исчерпан" },
    });
    expect((await llmCalls(s.systemId)).length).toBe(before);
    // Another action of the system has its own limit; a retry of a counted call still goes.
    expect((await run(body(s.key, "reply_payment", { monthlyLimit: 2 }))).status).toBe(200);
    expect((await run(first)).status).toBe(200);
    // The next Moscow month starts from zero.
    const saved = now;
    now = new Date(moscowMonth(now).end.getTime() + 1000);
    try {
      expect((await run(body(s.key, "classify_payment", { monthlyLimit: 2 }))).status).toBe(200);
    } finally {
      now = saved;
    }
  });

  test("org credits at 0 → 402 AI_CREDITS_EXHAUSTED without a model call; one owner notice per month", async () => {
    const owner = `owner-${randomUUID().slice(0, 8)}@example.test`;
    const s = await newSystem({ drained: true, owner });
    for (let i = 0; i < 2; i++) {
      const r = await run(body(s.key, "classify_payment"));
      expect(r).toEqual({
        status: 402,
        json: { code: "AI_CREDITS_EXHAUSTED", message_ru: "ИИ-действие временно недоступно" },
      });
    }
    expect(await llmCalls(s.systemId)).toHaveLength(0);
    const letters = outbox.list(owner);
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({ kind: "notice", subject: "Кредиты для ИИ-действий закончились" });
    expect(letters[0]?.text).toContain("«Поддержка»");
  });

  test("M2-15 cap: live AI calls count towards WIZARD_LLM_MONTHLY_CAP_RUB; reached → 503 without a model call", async () => {
    let requests = 0;
    const live = (o: RouterOptions) =>
      createRouter({
        ...o,
        mode: "live",
        env: { CLOUDRU_BASE_URL: "http://mock.local/cloudru", CLOUDRU_API_KEY: "k" },
        sleep: async () => {},
        fetch: (async (_u: unknown, init?: RequestInit) => {
          requests++;
          const req = JSON.parse(String(init?.body)) as { model: string };
          return Response.json({
            id: "c",
            object: "chat.completion",
            created: 1,
            model: req.model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Ответ" } }],
            usage: { prompt_tokens: 50_000, completion_tokens: 10_000, total_tokens: 60_000 },
          });
        }) as typeof globalThis.fetch,
      });
    const capped = await startApi(tdb.url, {
      config: { internalToken: TOKEN, llmMonthlyCapRub: 5 },
      migrate: false,
      recover: false,
      createRouter: live,
      now: () => now,
    });
    try {
      // Fresh database month: the platform spend so far is this test's own.
      const s = await newSystem();
      const first = await run(body(s.key, "reply_payment"), TOKEN, capped);
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      const spent = (await llmCalls(s.systemId)).filter((c) => c.mode === "live");
      expect(spent.length).toBe(1);
      expect(Number(spent[0]?.cost_rub)).toBeGreaterThanOrEqual(5);
      const second = await run(body(s.key, "reply_payment"), TOKEN, capped);
      expect(second.status).toBe(503);
      expect(second.json.code).toBe("AI_UNAVAILABLE");
      expect(requests).toBe(1);
    } finally {
      await capped.dispose();
    }
  });
});

describe("backfill by the change card flag (card.aiBackfill)", () => {
  let bf: TestApi;
  let bfDb: Awaited<ReturnType<typeof createTestDb>>;
  const calls: { env: string; action: string; systemKey: string }[] = [];
  const schemas = loadEventSchemas();

  const changeOps = [
    {
      op: "add_field",
      entity: "speaker_application",
      field: { name: "ai_summary", label: "Резюме ИИ", type: "text", maxLength: 1000 },
    },
    {
      op: "add_ai_action",
      aiAction: {
        name: "summarize_application",
        kind: "generate",
        input: { entity: "speaker_application", fields: ["topic", "abstract"] },
        output: { field: "ai_summary" },
        monthlyLimit: 50,
        tier: "T0",
      },
    },
  ];

  async function build(host: BuildHost, p: BuildParams) {
    if (p.mode !== "change") return fakeBuild(host, p, { spec: "forum" });
    const { version } = await host.store.getSpec();
    const r = await host.store.applyOps(changeOps as never, version, `${host.run.id}:change:1`);
    if (!r.ok) throw new RunFailure("GATES_FAILED", JSON.stringify(r.errors));
    const report = await host.runGates("G0");
    if (!report.passed) throw new RunFailure("GATES_FAILED", "G0");
    return { summary_ru: "Добавил ИИ-резюме заявок" };
  }

  beforeAll(async () => {
    bfDb = await createTestDb("ai_bf", { migrator: true });
    bf = await startApi(bfDb.url, {
      executors: {
        ...fakeExecutors({ spec: "forum" }),
        build,
        interviewTurn: async (host) =>
          host.context.trigger === "message" && host.context.system.previewRevision !== null
            ? {
                kind: "card",
                text: "Правка",
                card: {
                  ...fakeCard(20),
                  summary: "ИИ-резюме заявок спикеров",
                  aiBackfill: ["summarize_application", "no_such_action"],
                },
              }
            : fakeInterview(host),
      },
      createRouter: fakeRouterFactory(),
      aiBackfill: async (req) => {
        calls.push({ env: req.env, action: req.action, systemKey: req.systemKey });
        return { filled: 3, skipped: 1, stopCode: null };
      },
      publish: {
        smoke: async () => ({ ok: true }),
        lockRetryDelaysMs: [10],
        telegram: { mode: "outbox", outboxDir: null },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await bf?.dispose();
    await bfDb?.drop();
  });

  test("change build → draft backfill at the end of the build; publish → prod backfill after the switch", async () => {
    const b = await startBuild(bf);
    expect((await waitRun(bf, b.buildRunId, ["succeeded", "failed"], 20_000)).status).toBe("succeeded");
    const sys = await bf.deps.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", b.systemId)
      .executeTakeFirstOrThrow();

    const m = await bf.req("POST", `/systems/${b.systemId}/messages`, {
      body: { text: "Добавь ИИ-резюме заявок" },
    });
    await waitRun(bf, m.body.run.id, ["succeeded"]);
    const card = (await bf.req("GET", `/systems/${b.systemId}`)).body.card;
    const ap = await bf.req("POST", `/systems/${b.systemId}/card/approve`, {
      body: { cardVersion: card.cardVersion },
    });
    expect(ap.status, ap.text).toBe(202);
    const built = await waitRun(bf, ap.body.run.id, ["succeeded", "failed"], 20_000);
    expect(built.status, JSON.stringify(built.failure)).toBe("succeeded");
    expect(calls).toEqual([{ env: "draft", action: "summarize_application", systemKey: sys.schema_key }]);
    const ev = await listEvents(bf.deps.db, ap.body.run.id, 0);
    expect(ev.map((e) => schemas.validate(e)).filter((x) => x !== null)).toEqual([]);
    expect(ev.filter((e) => e.type === "step_started").map((e) => e.payload.step)).toContain("ai_backfill");
    const rows = await bf.deps.db
      .selectFrom("platform.ai_backfills")
      .selectAll()
      .where("system_id", "=", b.systemId)
      .orderBy("env")
      .execute();
    expect(rows.map((r) => [r.env, r.action, r.status, r.filled])).toEqual([
      ["draft", "summarize_application", "done", 3],
      ["prod", "summarize_application", "pending", 0],
    ]);

    const s0 = await bf.deps.db
      .selectFrom("platform.systems")
      .selectAll()
      .where("id", "=", b.systemId)
      .executeTakeFirstOrThrow();
    const put = await bf.req("PUT", `/systems/${b.systemId}/compliance`, {
      body: {
        expectedVersion: s0.draft_revision,
        operatorName: "ООО «Северный ритейл»",
        operatorContact: "privacy@north-retail.example",
        operatorAddress: "г. Москва, ул. Тверская, д. 1",
      },
    });
    expect(put.status, put.text).toBe(200);
    const pub = await bf.req("POST", `/systems/${b.systemId}/publish`, {
      body: { revision: put.body.revision.version, confirmDiff: true },
    });
    expect(pub.status, pub.text).toBe(202);
    const published = await waitRun(bf, pub.body.run.id, ["succeeded", "failed"], 20_000);
    expect(published.status, JSON.stringify(published.failure)).toBe("succeeded");
    expect(calls.at(-1)).toEqual({ env: "prod", action: "summarize_application", systemKey: sys.schema_key });
    const prod = await bf.deps.db
      .selectFrom("platform.ai_backfills")
      .selectAll()
      .where("system_id", "=", b.systemId)
      .where("env", "=", "prod")
      .executeTakeFirstOrThrow();
    expect(prod).toMatchObject({ status: "done", filled: 3, skipped: 1, stop_code: null });
    // Nothing pending any more: the next publication does not backfill again.
    expect(calls).toHaveLength(2);
  });
});
