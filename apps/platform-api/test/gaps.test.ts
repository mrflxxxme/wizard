// «Запросы на развитие» (D73, M2-59 mvp_scope): the agent host of a run records a request (category, quote after the
// PII scrub, offered substitute); /admin groups them by category and frequency and links to the system and the client.
// Also M2-32: when the whole model chain refuses, the run journal has models_unavailable (internal), the founder gets
// one alert an hour, the client a plain message.
import { LlmError, type Router, type RouterOptions } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import type { OpsAlert } from "../src/ops/alert.js";
import { grantPilotCredits } from "../src/pilot/service.js";
import { MODELS_UNAVAILABLE_RU } from "../src/runs/models-outage.js";
import type { InterviewHost } from "../src/runs/types.js";
import {
  createTestDb,
  fakeExecutors,
  fakeInterview,
  fakeRouterFactory,
  parseSse,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { devLogin, expectContract, type Session } from "./session.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let client: Session;
let staff: Session;
const alerts: OpsAlert[] = [];
const mode = { outage: false };

const interviewTurn = async (host: InterviewHost) => {
  const last = [...host.context.messages].reverse().find((m) => m.role === "user")?.text ?? "";
  if (last.includes("оплат")) {
    const req = {
      category: "payments" as const,
      quote: "Хочу принимать оплату картой, мой телефон +7 916 123-45-67",
      offered: "Заявка с оплатой по счёту",
    };
    await host.recordDevelopmentRequest(req);
    await host.recordDevelopmentRequest(req); // a retried step: still one row
    // An unknown category from a model is kept as «other».
    if (last.includes("салон"))
      await host.recordDevelopmentRequest({
        category: "teleport" as never,
        quote: "Телепорт к клиенту",
        offered: null,
      });
  }
  return fakeInterview(host);
};

function outageRouterFactory(opts: RouterOptions): Router {
  const ok = fakeRouterFactory()(opts);
  return {
    ...ok,
    async route(input) {
      if (!mode.outage) return ok.route(input);
      await api.deps.pg`
        insert into platform.llm_calls (org_id, run_id, call_type, tier, provider, model_id, status, error_code,
          route_reason, policy_version, scrubbed, cost_rub, billable, mode)
        values (${input.ctx.orgId}, ${input.ctx.runId ?? null}, ${input.callType}, 'T1', 'zai', 'glm-5.3', 'timeout',
          'TIMEOUT', 'default_T1', 'test', true, 0, false, 'live')`;
      throw new LlmError("LLM_UNAVAILABLE", "Модели сейчас недоступны. Попробуйте позже.", {
        callType: input.callType,
      });
    },
  };
}

beforeAll(async () => {
  tdb = await createTestDb("gaps");
  api = await startApi(tdb.url, {
    executors: { ...fakeExecutors({ spec: "forum" }), interviewTurn },
    createRouter: outageRouterFactory,
    abuseSlaMs: 0,
    alert: async (a) => {
      alerts.push(a);
    },
  });
  client = await devLogin(api, "olga@salon.example");
  // Pilot plan: more drafts than Free allows, credits from the founder.
  const orgId = (await client.req("GET", "/me")).body.memberships[0].orgId;
  await api.deps.db.updateTable("platform.orgs").set({ plan: "pilot" }).where("id", "=", orgId).execute();
  await grantPilotCredits(api.deps.db, api.deps.billing, { orgId, credits: 1000, reference: "test" });
  staff = await devLogin(api, "founder-gaps@example.test");
  await setStaff(api.deps.db, "founder-gaps@example.test", true);
  const en = await staff.req("POST", "/admin/mfa/enroll");
  await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const asClient = () => ({ ...api, req: client.req }) as TestApi;

describe("«Запросы на развитие»", () => {
  let systemId = "";

  test("a run records the request once, quote scrubbed; unknown category → other", async () => {
    const created = await client.req("POST", "/systems", {
      body: { prompt: "Запись в салон с онлайн-оплатой" },
    });
    expect(created.status, created.text).toBe(201);
    systemId = created.body.system.id;
    await waitRun(asClient(), created.body.run.id, ["succeeded"]);
    const rows = await api.deps.db
      .selectFrom("platform.development_requests")
      .selectAll()
      .orderBy("category")
      .execute();
    expect(rows.map((r) => r.category)).toEqual(["other", "payments"]);
    const pay = rows.find((r) => r.category === "payments");
    expect(pay?.quote).toContain("[ТЕЛЕФОН_1]");
    expect(pay?.quote).not.toContain("123-45-67");
    expect(pay).toMatchObject({
      system_id: systemId,
      run_id: created.body.run.id,
      offered: "Заявка с оплатой по счёту",
    });
  });

  test("/admin: categories by frequency with 7/30-day counts; latest requests with system and client address", async () => {
    expect((await client.req("GET", "/admin/development-requests")).status).toBe(404);
    // Another payments request from another system: payments goes first by frequency.
    const again = await client.req("POST", "/systems", { body: { prompt: "Курсы с оплатой" } });
    await waitRun(asClient(), again.body.run.id, ["succeeded"]);
    const r = await staff.req("GET", "/admin/development-requests");
    expect(r.status, r.text).toBe(200);
    expectContract("adminDevelopmentRequests", r);
    expect(r.body.categories.map((c: { category: string }) => c.category)).toEqual(["payments", "other"]);
    expect(r.body.categories[0]).toMatchObject({ last7: 2, last30: 2, total: 2, systems: 2 });
    const item = r.body.items.find(
      (x: { systemId: string }) => x.systemId === systemId && x.category === "payments",
    );
    expect(item).toMatchObject({ email: "olga@salon.example", systemName: expect.any(String) });
    const only = await staff.req("GET", "/admin/development-requests?category=other");
    expect(only.body.items.every((x: { category: string }) => x.category === "other")).toBe(true);
    expect((await staff.req("GET", "/admin/development-requests?category=nope")).status).toBe(400);
  });
});

describe("M2-32: the whole model chain refuses", () => {
  test("journal models_unavailable (not streamed), plain client text, one founder alert an hour", async () => {
    mode.outage = true;
    try {
      const created = await client.req("POST", "/systems", { body: { prompt: "Учёт заказов" } });
      expect(created.status, created.text).toBe(201);
      const run = await waitRun(asClient(), created.body.run.id, ["failed"]);
      expect(run.failure).toMatchObject({ code: "LLM_UNAVAILABLE", message_ru: MODELS_UNAVAILABLE_RU });
      const events = await api.deps.db
        .selectFrom("platform.run_events")
        .select(["type", "payload"])
        .where("run_id", "=", created.body.run.id)
        .orderBy("seq")
        .execute();
      const types = events.map((e) => e.type);
      expect(types.indexOf("models_unavailable")).toBeLessThan(types.indexOf("run_failed"));
      const ev = events.find((e) => e.type === "models_unavailable");
      expect(ev?.payload).toEqual({
        callType: "interview",
        attempts: [{ model: "glm-5.3", tier: "T1", status: "timeout", errorCode: "TIMEOUT", count: 1 }],
      });
      const sse = await client.req("GET", `/runs/${created.body.run.id}/events`);
      expect(parseSse(sse.text).map((f) => f.event)).not.toContain("models_unavailable");
      expect(sse.text).not.toContain("glm-5.3");
      const outage = alerts.filter((a) => a.event === "llm_chain_failed");
      expect(outage).toHaveLength(1);
      expect(outage[0]?.text).toContain(created.body.run.id);
      expect(outage[0]?.text).toContain("glm-5.3 (T1): timeout TIMEOUT ×1");

      const second = await client.req("POST", "/systems", { body: { prompt: "Учёт склада" } });
      expect(second.status, second.text).toBe(201);
      await waitRun(asClient(), second.body.run.id, ["failed"]);
      expect(alerts.filter((a) => a.event === "llm_chain_failed")).toHaveLength(1);
    } finally {
      mode.outage = false;
    }
  });
});
