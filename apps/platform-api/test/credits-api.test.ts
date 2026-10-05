// M1-03 acceptance through the API: the card's cap is held on approve (402 INSUFFICIENT_CREDITS otherwise), builds
// and interview turns are charged by fact through the ledger (Σ charge = min(cap, Σ usage × rate)), exceeding the
// cap stops the run, refunds, draft_systems plan limit, getCredits/listLedger, parallel runs of one org.
import { randomUUID } from "node:crypto";
import {
  creditsMilli,
  type RouteOutput,
  type Router,
  type RouterOptions,
  type UsageRecord,
} from "@wizard/llm";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsCjs from "ajv-formats";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { RUB_PER_CREDIT } from "../src/billing/plans.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import type { BuildHost, RunExecutors } from "../src/runs/types.js";
import {
  createTestDb,
  fakeInterview,
  loadYaml,
  passingReport,
  type Res,
  startApi,
  type TestApi,
  waitFor,
  waitRun,
} from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;

/** ₽ per LLM call of the current test; every call also logs a non-billable failed attempt. */
const state = { costRub: 0.37, build: "normal" as "normal" | "loop" | "crash" };

/** Router stub that writes llm_calls through the platform's usage sink like the real router. */
function usageRouter(opts: RouterOptions): Router {
  return {
    mode: "fixture",
    registry: {} as Router["registry"],
    async route(input): Promise<RouteOutput> {
      const cost = state.costRub;
      const milli = creditsMilli(cost, RUB_PER_CREDIT);
      const base = {
        runId: input.ctx.runId ?? null,
        orgId: input.ctx.orgId,
        systemId: input.ctx.systemId ?? null,
        step: input.ctx.step ?? null,
        callType: input.callType as UsageRecord["callType"],
        agentRole: "test",
        tier: "T0" as const,
        provider: "fixture",
        modelId: "fixture",
        routeReason: "default_T0" as const,
        fallbackFrom: null,
        policyVersion: "test",
        scrubbed: false,
        piiCategoriesCount: {},
        cachedTokens: 0,
        toolCalls: 0,
        latencyMs: 5,
        ttftMs: null,
        mode: "fixture" as const,
        requestHash: "x",
        createdAt: new Date().toISOString(),
      };
      await opts.sink?.write({
        ...base,
        id: randomUUID(),
        attempt: 1,
        status: "error",
        errorCode: "HTTP_500",
        inputTokens: 0,
        outputTokens: 0,
        costRub: 0,
        creditsMilli: 0,
        billable: false,
      });
      await opts.sink?.write({
        ...base,
        id: randomUUID(),
        attempt: 2,
        status: "ok",
        errorCode: null,
        inputTokens: 100,
        outputTokens: 10,
        costRub: cost,
        creditsMilli: milli,
        billable: true,
      });
      return {
        tier: "T0",
        model: "fixture",
        result: { text: "ok", toolCalls: [], finishReason: "stop" },
        usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 10 },
        creditsCharged: milli / 1000,
        creditsMilli: milli,
        routeReason: "default_T0",
        scrubbed: false,
        ruFallback: false,
      };
    },
  };
}

const build: RunExecutors["build"] = async (host: BuildHost) => {
  const call = () =>
    host.route({ callType: "build_code", messages: [{ role: "user", content: "…" }], step: "code" });
  if (state.build === "crash") {
    await call();
    throw new Error("boom");
  }
  await host.runGates("G0");
  if (state.build === "loop") for (;;) await call(); // until the cap stops the run
  for (let i = 0; i < 3; i++) await call();
  return { summary_ru: "Система собрана" };
};

const executors: RunExecutors = {
  interviewTurn: fakeInterview,
  build,
  gates: async (level, ctx) => passingReport(level, ctx.specVersion),
  onG0Passed: async (a) => ({ bundleKey: `${a.systemKey}/${a.revision}` }),
};

beforeAll(async () => {
  tdb = await createTestDb("credits_api");
  api = await startApi(tdb.url, {
    config: { billingExemptOrgs: [], runConcurrency: 4 },
    executors,
    createRouter: usageRouter,
    creditsCronMs: 0,
  });
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

// --- helpers --------------------------------------------------------------------------------------------------

const addFormats = formatsCjs.default;
const doc = loadYaml("specs/platform/api.yaml") as { components: { schemas: Record<string, object> } };
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validBalance = ajv.compile(doc.components.schemas.CreditBalance as object);
const validEntry = ajv.compile(doc.components.schemas.LedgerEntry as object);

async function newOrg(name = "Кредиты"): Promise<string> {
  const r = await api.req("POST", "/orgs", { body: { name } });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

async function credits(orgId: string) {
  const r = await api.req("GET", `/orgs/${orgId}/credits`);
  expect(r.status).toBe(200);
  expect(validBalance(r.body), ajv.errorsText(validBalance.errors)).toBe(true);
  return r.body as { balance: number; held: number; available: number; buckets: unknown[] };
}

/** createSystem → answers → card, in the given org. */
async function toCard(orgId: string, prompt = "Регистрация на форум на 600 участников") {
  const created = await api.req("POST", "/systems", { body: { prompt, orgId } });
  expect(created.status).toBe(201);
  const systemId: string = created.body.system.id;
  await waitRun(api, created.body.run.id, ["succeeded"]);
  const ans = await api.req("POST", `/systems/${systemId}/answers`, { body: { restByRecommendation: true } });
  expect(ans.status).toBe(202);
  await waitRun(api, ans.body.run.id, ["succeeded"]);
  const sys = await api.req("GET", `/systems/${systemId}`);
  expect(sys.body.system.stage).toBe("card");
  return { systemId, cardVersion: sys.body.card.cardVersion as number };
}

const approve = (c: { systemId: string; cardVersion: number }, capCredits?: number): Promise<Res> =>
  api.req("POST", `/systems/${c.systemId}/card/approve`, {
    body: { cardVersion: c.cardVersion, ...(capCredits ? { capCredits } : {}) },
  });

async function sumLedger(where: { runId?: string; orgId?: string; kind?: string }): Promise<number> {
  let q = api.deps.db
    .selectFrom("platform.credit_ledger")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amount_milli"), eb.lit(0)).as("s"));
  if (where.runId) q = q.where("run_id", "=", where.runId);
  if (where.orgId) q = q.where("org_id", "=", where.orgId);
  if (where.kind) q = q.where("kind", "=", where.kind as never);
  return Number((await q.executeTakeFirstOrThrow()).s);
}

async function usedMilli(runId: string): Promise<number> {
  const r = await api.deps.db
    .selectFrom("platform.llm_calls")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("credits_milli"), eb.lit(0)).as("s"))
    .where("run_id", "=", runId)
    .where("billable", "=", true)
    .executeTakeFirstOrThrow();
  return Number(r.s);
}

/** billing.yaml#credit.test: for every finished run Σ charge = min(cap, Σ llm_calls.credits_milli billable). */
async function expectChargedByFact(orgId: string) {
  const runs = await api.deps.db
    .selectFrom("platform.runs")
    .select(["id", "kind", "credits_cap_milli", "status"])
    .where("org_id", "=", orgId)
    .execute();
  for (const r of runs) {
    expect(["succeeded", "failed", "cancelled"]).toContain(r.status);
    const cap = Number(r.credits_cap_milli);
    expect(-(await sumLedger({ runId: r.id, kind: "charge" })), `${r.kind} ${r.id}`).toBe(
      Math.min(cap, await usedMilli(r.id)),
    );
    const held =
      (await sumLedger({ runId: r.id, kind: "hold" })) + (await sumLedger({ runId: r.id, kind: "release" }));
    expect(held).toBe(0);
  }
  return runs;
}

async function pendingOf(runId: string) {
  await waitRun(api, runId, ["needs_input"]);
  const r = await api.deps.db
    .selectFrom("platform.runs")
    .select("pending_input")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return r.pending_input as { inputId: string; options: { id: string }[] };
}

async function answer(runId: string, inputId: string, choice: string) {
  const r = await api.req("POST", `/runs/${runId}/input`, { body: { inputId, choice } });
  expect(r.status).toBe(202);
}

async function drainTo(orgId: string, availableCredits: number) {
  const { available } = await credits(orgId);
  const delta = Math.round((availableCredits - available) * 1000);
  await api.deps.db
    .transaction()
    .execute((trx) =>
      api.deps.billing.adjust(trx, orgId, { amountMilli: delta, key: `test:${randomUUID()}`, note: "тест" }),
    );
}

// --- tests -----------------------------------------------------------------------------------------------------

describe("card → hold → charge by fact", () => {
  test("approve holds the cap; the build is charged Σ usage × rate; interview turns are charged per turn", async () => {
    state.costRub = 0.37;
    state.build = "normal";
    const org = await newOrg();
    expect(await credits(org)).toEqual({
      balance: 100,
      held: 0,
      available: 100,
      buckets: [{ source: "free_welcome", remaining: 100, expiresAt: expect.any(String) }],
    });
    const c = await toCard(org);
    const sys = await api.req("GET", `/systems/${c.systemId}`);
    expect(sys.body.card.estimate.credits).toEqual({ min: 10, expected: 20, max: 30 });
    expect(sys.body.card.cap.credits).toBe(40);
    const afterInterview = await credits(org);
    expect(afterInterview.available).toBe(100 - 0.074 * 2);

    state.costRub = 30; // 6 credits per call
    const ap = await approve(c);
    expect(ap.status).toBe(202);
    const runId: string = ap.body.run.id;
    expect(await sumLedger({ runId, kind: "hold" })).toBe(-40_000);
    await waitRun(api, runId, ["succeeded"]);
    expect(await usedMilli(runId)).toBe(18_000);
    expect(await sumLedger({ runId, kind: "charge" })).toBe(-18_000);
    const after = await credits(org);
    expect(after).toMatchObject({ held: 0, available: afterInterview.available - 18 });
    await expectChargedByFact(org);

    const list = await api.req("GET", `/orgs/${org}/credits/ledger?limit=3`);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(3);
    for (const e of list.body.items) expect(validEntry(e), ajv.errorsText(validEntry.errors)).toBe(true);
    expect(list.body.items.map((e: { kind: string }) => e.kind)).toEqual(["charge", "release", "hold"]);
    const next = await api.req("GET", `/orgs/${org}/credits/ledger?limit=50&cursor=${list.body.nextCursor}`);
    expect(next.body.nextCursor).toBeNull();
    expect(next.body.items.at(-1)).toMatchObject({ kind: "grant", amount: 100, source: "free_welcome" });
  });

  test("exceeding the cap stops the run; the charge equals the cap, the rest is on the platform", async () => {
    state.costRub = 45; // 9 credits per call
    state.build = "loop";
    const org = await newOrg();
    state.costRub = 0.01;
    const c = await toCard(org);
    state.costRub = 45;
    const ap = await approve(c, 20);
    expect(ap.status).toBe(202);
    const runId: string = ap.body.run.id;
    const pending = await pendingOf(runId);
    expect(pending.options.map((o) => o.id)).toEqual(["raise_cap_5", "stop"]);
    await answer(runId, pending.inputId, "stop");
    await waitRun(api, runId, ["cancelled"]);
    expect(await usedMilli(runId)).toBe(27_000); // 3 calls: the 4th was stopped by budget_exceeded
    expect(await sumLedger({ runId, kind: "charge" })).toBe(-20_000);
    expect(await sumLedger({ runId, kind: "refund" })).toBe(0); // G0 passed — the user got a preview
    await expectChargedByFact(org);
  });

  test("raise_cap holds more credits; without free credits the option is not offered", async () => {
    state.build = "loop";
    const org = await newOrg();
    state.costRub = 0.01;
    const c = await toCard(org);
    await drainTo(org, 20);
    state.costRub = 45;
    const ap = await approve(c, 20);
    expect(ap.status).toBe(202);
    const runId: string = ap.body.run.id;
    const pending = await pendingOf(runId);
    expect(pending.options.map((o) => o.id)).toEqual(["stop"]);
    await answer(runId, pending.inputId, "stop");
    await waitRun(api, runId, ["cancelled"]);
    expect((await credits(org)).available).toBe(0);

    // With credits: raise_cap_5 → one more hold of 5, then stop at 25.
    await drainTo(org, 40);
    state.costRub = 0.01;
    const c2 = await toCard(org, "Вторая система для лимита");
    state.costRub = 45;
    const ap2 = await approve(c2, 20);
    const run2: string = ap2.body.run.id;
    const p1 = await pendingOf(run2);
    expect(p1.options.map((o) => o.id)).toEqual(["raise_cap_5", "stop"]);
    await answer(run2, p1.inputId, "raise_cap_5");
    const p2 = await waitFor(async () => {
      const p = await pendingOf(run2);
      return p && p.inputId !== p1.inputId ? p : undefined;
    });
    expect(await sumLedger({ runId: run2, kind: "hold" })).toBe(-25_000);
    await answer(run2, p2.inputId, "stop");
    await waitRun(api, run2, ["cancelled"]);
    expect(await sumLedger({ runId: run2, kind: "charge" })).toBe(-25_000);
    await expectChargedByFact(org);
  });

  test("402 INSUFFICIENT_CREDITS {available, required} on approve; a lower cap fits", async () => {
    state.costRub = 0.01;
    state.build = "normal";
    const org = await newOrg();
    const c = await toCard(org);
    await drainTo(org, 30);
    const r = await approve(c);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: "INSUFFICIENT_CREDITS", details: { available: 30, required: 40 } });
    const sys = await api.req("GET", `/systems/${c.systemId}`);
    expect(sys.body.system.stage).toBe("card"); // nothing changed
    const ok = await approve(c, 25);
    expect(ok.status).toBe(202);
    await waitRun(api, ok.body.run.id, ["succeeded"]);
    await expectChargedByFact(org);
  });

  test("available ≤ 0 → 402 on createSystem, messages and answers", async () => {
    state.costRub = 0.01;
    const org = await newOrg();
    const created = await api.req("POST", "/systems", { body: { prompt: "Запись на курсы", orgId: org } });
    await waitRun(api, created.body.run.id, ["succeeded"]);
    await drainTo(org, 0);
    const id = created.body.system.id as string;
    for (const [path, body] of [
      [`/systems/${id}/messages`, { text: "Ещё вопрос" }],
      [`/systems/${id}/answers`, { restByRecommendation: true }],
      ["/systems", { prompt: "Другая система", orgId: org }],
    ] as const) {
      const r = await api.req("POST", path, { body });
      expect(r.status, path).toBe(402);
      expect(r.body.code).toBe("INSUFFICIENT_CREDITS");
    }
  });

  test("refund: a build failing with INTERNAL is refunded in full", async () => {
    state.costRub = 0.01;
    state.build = "crash";
    const org = await newOrg();
    const c = await toCard(org);
    state.costRub = 30;
    const ap = await approve(c);
    const runId: string = ap.body.run.id;
    const done = await waitRun(api, runId, ["failed"]);
    expect(done.failure?.code).toBe("INTERNAL");
    expect(await sumLedger({ runId, kind: "charge" })).toBe(-6000);
    expect(await sumLedger({ runId, kind: "refund" })).toBe(6000);
    expect(await sumLedger({ runId })).toBe(0);
    await expectChargedByFact(org);
  });
});

describe("plan limits", () => {
  test("Free: the 4th draft system → 402 PLAN_LIMIT {limit: 3, current: 3, plan: free}; parallel creates too", async () => {
    state.costRub = 0.01;
    const org = await newOrg();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_v, i) =>
        api.req("POST", "/systems", { body: { prompt: `Черновик номер ${i}`, orgId: org } }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(402);
      expect(r.body).toMatchObject({ code: "PLAN_LIMIT", details: { limit: 3, current: 3, plan: "free" } });
    }
    await api.deps.db.updateTable("platform.orgs").set({ plan: "start" }).where("id", "=", org).execute();
    const more = await api.req("POST", "/systems", {
      body: { prompt: "Черновик на тарифе Старт", orgId: org },
    });
    expect(more.status).toBe(201);
    await api.engine.idle();
  });

  test("dev stand: the local org (config.billingExemptOrgs) has no limits; missing credits are granted in the ledger", async () => {
    const dev = await startApi(tdb.url, { executors, createRouter: usageRouter, creditsCronMs: 0 });
    try {
      state.costRub = 0.01;
      for (let i = 0; i < 5; i++) {
        const r = await dev.req("POST", "/systems", { body: { prompt: `Локальная система ${i}` } });
        expect(r.status).toBe(201);
        await waitRun(dev, r.body.run.id, ["succeeded"]);
      }
      const { available } = await dev.deps.billing.readBalance(dev.deps.db, DEFAULT_ORG_ID);
      await dev.deps.db.transaction().execute((trx) =>
        dev.deps.billing.adjust(trx, DEFAULT_ORG_ID, {
          amountMilli: -available,
          key: "drain",
          note: "тест",
        }),
      );
      const r = await dev.req("POST", "/systems", { body: { prompt: "Локальная система без кредитов" } });
      expect(r.status).toBe(201);
      await waitRun(dev, r.body.run.id, ["succeeded"]);
      const topups = await dev.deps.db
        .selectFrom("platform.credit_ledger")
        .select(["kind", "bucket"])
        .where("org_id", "=", DEFAULT_ORG_ID)
        .where("idempotency_key", "like", "dev:%")
        .execute();
      expect(topups).toEqual([{ kind: "adjustment", bucket: "adjustment" }]);
      expect((await dev.deps.billing.readBalance(dev.deps.db, DEFAULT_ORG_ID)).available).toBeGreaterThan(0);
    } finally {
      await dev.dispose();
    }
  });
});

describe("parallel runs of one org", () => {
  test("parallel approvals: only what fits is held (402 for the rest); parallel builds are charged by fact", async () => {
    state.costRub = 0.01;
    state.build = "normal";
    const org = await newOrg();
    await api.deps.db.updateTable("platform.orgs").set({ plan: "business" }).where("id", "=", org).execute();
    await drainTo(org, 10); // a paid plan without a period grant: staff adjustment
    const cards = [];
    for (let i = 0; i < 6; i++) cards.push(await toCard(org, `Параллельная система ${i}`));
    await drainTo(org, 100);
    state.costRub = 5; // 1 credit per call
    const results = await Promise.all(cards.map((c) => approve(c)));
    const ok = results.filter((r) => r.status === 202);
    expect(ok).toHaveLength(2); // 2 × 40 ≤ 100 < 3 × 40
    for (const r of results.filter((x) => x.status !== 202))
      expect(r.body).toMatchObject({ code: "INSUFFICIENT_CREDITS", details: { required: 40 } });
    await Promise.all(ok.map((r) => waitRun(api, r.body.run.id, ["succeeded"])));
    await expectChargedByFact(org);
    const bal = await credits(org);
    expect(bal).toMatchObject({ held: 0, available: 100 - 2 * 3 });
    expect(await sumLedger({ orgId: org })).toBe(Math.round(bal.available * 1000));
  });
});
