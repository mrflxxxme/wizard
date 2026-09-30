// M1-03 acceptance on the ledger itself (specs/platform/billing.yaml#ledger, #plans; product.yaml#decisions.D10_*):
// append-only, idempotency, D10 interpretations (Free 100/30 days + 25 from day 31 without accumulation, topup lives
// 365 days, plan credits burn at the period end), charge by fact = min(cap, Σ usage × rate), refunds, concurrency.
import { randomUUID } from "node:crypto";
import { creditsMilli, type UsageRecord } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MEMBER_LIMITS } from "../src/auth/accounts.js";
import { Billing, REFUND_CODES } from "../src/billing/ledger.js";
import { DAY_MS, PLANS, RUB_PER_CREDIT, TOPUP, WELCOME } from "../src/billing/plans.js";
import { createDb, type DbHandle, DEV_USER_ID, migrate } from "../src/db/index.js";
import { ApiError } from "../src/errors.js";
import { DbUsageSink } from "../src/runs/usage.js";
import { createTestDb, loadYaml } from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let h: DbHandle;
const T0 = new Date("2026-01-01T00:00:00Z");
let now = T0;
const billing = new Billing({ now: () => now });
const at = (days: number, ms = 0) => new Date(T0.getTime() + days * DAY_MS + ms);

beforeAll(async () => {
  tdb = await createTestDb("credits_ledger");
  h = createDb(tdb.url, 30);
  await migrate(h.db);
});
afterAll(async () => {
  await h?.close();
  await tdb?.drop();
});

const systemOf = new Map<string, string>();

async function newOrg(plan: "free" | "start" | "business" = "free"): Promise<string> {
  const o = await h.db
    .insertInto("platform.orgs")
    .values({ name: "Тест", plan, region_code: "77", created_at: T0 })
    .returning("id")
    .executeTakeFirstOrThrow();
  const key = randomUUID().replace(/-/g, "").slice(0, 12);
  const sys = await h.db
    .insertInto("platform.systems")
    .values({ org_id: o.id, slug: `s-${key}`, schema_key: key, name: "Тест", created_by: DEV_USER_ID })
    .returning("id")
    .executeTakeFirstOrThrow();
  systemOf.set(o.id, sys.id);
  return o.id;
}

/** A G0 report that passed for the run (the build delivered something). */
async function markG0(run: { id: string; org_id: string }) {
  await h.db
    .insertInto("platform.gate_reports")
    .values({
      run_id: run.id,
      system_id: systemOf.get(run.org_id) as string,
      revision: 1,
      level: "G0",
      passed: true,
      report: "{}",
    })
    .execute();
}

async function newRun(orgId: string, kind: "build" | "interview_turn" = "build", capMilli = 40_000) {
  return h.db
    .insertInto("platform.runs")
    .values({ org_id: orgId, system_id: systemOf.get(orgId) ?? null, kind, credits_cap_milli: capMilli })
    .returningAll()
    .executeTakeFirstOrThrow();
}

const sink = () => new DbUsageSink(h.db);
function usage(orgId: string, runId: string, costRub: number, billable = true): UsageRecord {
  return {
    id: randomUUID(),
    runId,
    orgId,
    systemId: null,
    step: "code",
    callType: "build_code",
    agentRole: "builder",
    tier: "T0",
    provider: "fixture",
    modelId: "fixture",
    attempt: 1,
    status: billable ? "ok" : "error",
    errorCode: billable ? null : "HTTP_500",
    routeReason: "default_T0",
    fallbackFrom: null,
    policyVersion: "test",
    scrubbed: false,
    piiCategoriesCount: {},
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 50,
    toolCalls: 0,
    latencyMs: 10,
    ttftMs: null,
    costRub,
    creditsMilli: billable ? creditsMilli(costRub, RUB_PER_CREDIT) : 0,
    billable,
    mode: "fixture",
    requestHash: "x",
    createdAt: now.toISOString(),
  };
}

async function bal(orgId: string) {
  return billing.readBalance(h.db, orgId);
}

async function ledger(orgId: string) {
  return h.db
    .selectFrom("platform.credit_ledger")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("id")
    .execute();
}

/** hold(cap) → usage rows → settleRun; returns the run. */
async function chargedRun(
  orgId: string,
  capMilli: number,
  costs: number[],
  outcome = { status: "succeeded" as const },
) {
  const run = await newRun(orgId, "build", capMilli);
  await h.db
    .transaction()
    .execute((trx) =>
      billing.hold(trx, { orgId, runId: run.id, amountMilli: capMilli, key: `hold:${run.id}` }),
    );
  for (const c of costs) await sink().write(usage(orgId, run.id, c));
  await markG0(run);
  await h.db.transaction().execute((trx) => billing.settleRun(trx, run, outcome));
  return run;
}

async function sumKind(runId: string, kind: string): Promise<number> {
  const r = await h.db
    .selectFrom("platform.credit_ledger")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amount_milli"), eb.lit(0)).as("s"))
    .where("run_id", "=", runId)
    .where("kind", "=", kind as never)
    .executeTakeFirstOrThrow();
  return Number(r.s);
}

async function billableUsage(runId: string): Promise<number> {
  const r = await h.db
    .selectFrom("platform.llm_calls")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<string>("credits_milli"), eb.lit(0)).as("s"))
    .where("run_id", "=", runId)
    .where("billable", "=", true)
    .executeTakeFirstOrThrow();
  return Number(r.s);
}

describe("ledger rules", () => {
  test("append-only: UPDATE, DELETE and TRUNCATE are refused by the trigger", async () => {
    now = T0;
    const org = await newOrg();
    await bal(org);
    await expect(
      h.pg`update platform.credit_ledger set amount_milli = 1 where org_id = ${org}`,
    ).rejects.toThrow(/append-only/);
    await expect(h.pg`delete from platform.credit_ledger where org_id = ${org}`).rejects.toThrow(
      /append-only/,
    );
    await expect(h.pg`truncate platform.credit_ledger`).rejects.toThrow(/append-only/);
  });

  test("idempotency: repeated grant / hold / settleRun write nothing new; the key is unique per org", async () => {
    now = T0;
    const org = await newOrg();
    await bal(org);
    await bal(org);
    const run = await newRun(org);
    for (let i = 0; i < 3; i++) {
      await h.db.transaction().execute(async (trx) => {
        await billing.grantTopup(trx, org, { packs: 1, key: "topup:p1" });
        await billing.hold(trx, { orgId: org, runId: run.id, amountMilli: 40_000, key: `hold:${run.id}` });
      });
    }
    await sink().write(usage(org, run.id, 10));
    for (let i = 0; i < 3; i++)
      await h.db.transaction().execute((trx) => billing.settleRun(trx, run, { status: "succeeded" }));
    const rows = await ledger(org);
    const keys = rows.map((r) => r.idempotency_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.filter((r) => r.kind === "grant").map((r) => r.bucket)).toEqual(["free_welcome", "topup"]);
    expect(await sumKind(run.id, "hold")).toBe(-40_000);
    expect(await sumKind(run.id, "release")).toBe(40_000);
    await expect(
      h.pg`insert into platform.credit_ledger (org_id, kind, amount_milli, bucket, idempotency_key)
           values (${org}, 'grant', 1, 'adjustment', 'topup:p1')`,
    ).rejects.toThrow(/unique|duplicate/);
  });

  test("hold beyond available → INSUFFICIENT_CREDITS {available, required}; available never below zero", async () => {
    now = T0;
    const org = await newOrg();
    const run = await newRun(org);
    const err = await h.db
      .transaction()
      .execute((trx) => billing.hold(trx, { orgId: org, runId: run.id, amountMilli: 150_000, key: "hold:x" }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("INSUFFICIENT_CREDITS");
    expect((err as ApiError).details).toEqual({ available: 100, required: 150 });
    expect((await bal(org)).available).toBe(100_000);
  });
});

describe("charge by fact (acceptance: Σ ledger = Σ usage × rate; cap bounds the charge)", () => {
  test("charge = min(cap, Σ ceil(cost_rub × 1000 / 5)) of billable llm_calls; release = hold", async () => {
    now = T0;
    const org = await newOrg();
    // Under the cap: 3 calls, one non-billable error row is ignored.
    const costs = [1.2345, 7.5, 0.0001];
    const run = await chargedRun(org, 40_000, costs);
    await sink().write(usage(org, run.id, 99, false));
    const used = costs.reduce((s, c) => s + creditsMilli(c, RUB_PER_CREDIT), 0);
    expect(used).toBe(247 + 1500 + 1);
    expect(-(await sumKind(run.id, "charge"))).toBe(used);
    expect(await sumKind(run.id, "hold")).toBe(-40_000);
    expect(await sumKind(run.id, "release")).toBe(40_000);
    // Over the cap: 3 × 75 ₽ = 45 credits against a cap of 20 → 20 charged, the rest is on the platform.
    const over = await chargedRun(org, 20_000, [75, 75, 75]);
    expect(await billableUsage(over.id)).toBe(45_000);
    expect(-(await sumKind(over.id, "charge"))).toBe(Math.min(20_000, await billableUsage(over.id)));
    const b = await bal(org);
    expect(b.held).toBe(0);
    expect(b.available).toBe(100_000 - used - 20_000);
  });

  test("refund: failed with a platform code, or a build where no revision passed G0; user errors are charged", async () => {
    now = T0;
    const org = await newOrg();
    for (const code of REFUND_CODES) {
      const run = await chargedRun(org, 10_000, [5], { status: "failed", code } as never);
      expect(await sumKind(run.id, "charge")).toBe(-1000);
      expect(await sumKind(run.id, "refund")).toBe(1000);
    }
    const noG0 = await newRun(org, "build", 10_000);
    await h.db
      .transaction()
      .execute((trx) =>
        billing.hold(trx, { orgId: org, runId: noG0.id, amountMilli: 10_000, key: `hold:${noG0.id}` }),
      );
    await sink().write(usage(org, noG0.id, 10));
    await h.db.transaction().execute((trx) => billing.settleRun(trx, noG0, { status: "cancelled" }));
    expect(await sumKind(noG0.id, "refund")).toBe(2000);
    const gatesFailed = await chargedRun(org, 10_000, [10], {
      status: "failed",
      code: "GATES_FAILED",
    } as never);
    expect(await sumKind(gatesFailed.id, "charge")).toBe(-2000);
    expect(await sumKind(gatesFailed.id, "refund")).toBe(0);
    expect((await bal(org)).available).toBe(100_000 - 2000);
  });

  test("interview turn: no hold; charge ≤ turn cap and never more than available", async () => {
    now = T0;
    const org = await newOrg();
    const turn = await newRun(org, "interview_turn", 2000);
    await sink().write(usage(org, turn.id, 15)); // 3 credits > cap 2
    await h.db.transaction().execute((trx) => billing.settleRun(trx, turn, { status: "succeeded" }));
    expect(await sumKind(turn.id, "charge")).toBe(-2000);
    await h.db
      .transaction()
      .execute((trx) => billing.adjust(trx, org, { amountMilli: -97_500, key: "adj:drain", note: "тест" }));
    const t2 = await newRun(org, "interview_turn", 2000);
    await sink().write(usage(org, t2.id, 5));
    await h.db.transaction().execute((trx) => billing.settleRun(trx, t2, { status: "succeeded" }));
    expect(await sumKind(t2.id, "charge")).toBe(-500);
    expect((await bal(org)).available).toBe(0);
    const err = await h.db
      .transaction()
      .execute((trx) => billing.requireForTurn(trx, org, 2000))
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe("INSUFFICIENT_CREDITS");
  });
});

describe("D10 interpretations (product.yaml#decisions.D10_interpretations)", () => {
  test("Free: 100 credits for 30 days; 25 from day 31; monthly credits do not accumulate", async () => {
    now = T0;
    const org = await newOrg();
    let b = await bal(org);
    expect(b.available).toBe(100_000);
    expect(b.buckets).toEqual([{ bucket: "free_welcome", expiresAt: at(30), remaining: 100_000 }]);
    await chargedRun(org, 50_000, [200]); // 40 credits
    now = at(30, -1); // the last millisecond of day 30
    expect((await bal(org)).available).toBe(60_000);
    now = at(30); // day 31
    b = await bal(org);
    expect(b.available).toBe(PLANS.free.monthlyMilli);
    expect(b.buckets).toEqual([{ bucket: "free_monthly", expiresAt: at(60), remaining: 25_000 }]);
    const rows = await ledger(org);
    expect(rows.filter((r) => r.kind === "expire").map((r) => [r.bucket, Number(r.amount_milli)])).toEqual([
      ["free_welcome", -60_000],
    ]);
    now = at(45);
    await chargedRun(org, 20_000, [50]); // 10 credits
    now = at(60);
    expect((await bal(org)).available).toBe(25_000); // 15 left over burned, not 40
    now = at(95); // periods skipped while nobody looked: still 25, never 50
    expect((await bal(org)).available).toBe(25_000);
    const grants = (await ledger(org)).filter((r) => r.bucket === "free_monthly" && r.kind === "grant");
    expect(grants.map((r) => new Date(r.bucket_expires_at as Date).toISOString())).toEqual(
      [at(60), at(90), at(120)].map((d) => d.toISOString()),
    );
  });

  test("paid plan credits burn at the period end; topup lives 365 days; plan credits are spent before topup", async () => {
    now = T0;
    const org = await newOrg("start");
    await h.db.transaction().execute(async (trx) => {
      await billing.grantPlanPeriod(trx, org, { plan: "start", start: T0, end: at(30) });
      await billing.grantTopup(trx, org, { packs: 1, key: "topup:test-1" });
    });
    let b = await bal(org);
    expect(b.available).toBe(110_000); // no Free grants on a paid plan
    expect(b.buckets.map((x) => [x.bucket, x.remaining])).toEqual([
      ["plan_monthly", 50_000],
      ["topup", 60_000],
    ]);
    await chargedRun(org, 60_000, [275]); // 55 credits: 50 from the plan, 5 from topup
    b = await bal(org);
    expect(b.buckets.map((x) => [x.bucket, x.remaining])).toEqual([["topup", 55_000]]);
    await h.db
      .transaction()
      .execute((trx) => billing.grantPlanPeriod(trx, org, { plan: "start", start: at(30), end: at(60) }));
    now = at(40);
    await chargedRun(org, 10_000, [25]); // 5 credits from the plan bucket
    now = at(60);
    b = await bal(org);
    expect(b.buckets.map((x) => [x.bucket, x.remaining])).toEqual([["topup", 55_000]]);
    expect((await ledger(org)).filter((r) => r.kind === "expire").map((r) => Number(r.amount_milli))).toEqual(
      [-45_000],
    );
    now = at(365, -1);
    expect((await bal(org)).available).toBe(55_000);
    now = at(365);
    expect((await bal(org)).available).toBe(0);
  });

  test("a hold in a bucket that expires during the run: the charge is taken, the released rest burns", async () => {
    now = at(29);
    const org = await newOrg();
    const run = await newRun(org, "build", 30_000);
    await h.db
      .transaction()
      .execute((trx) =>
        billing.hold(trx, { orgId: org, runId: run.id, amountMilli: 30_000, key: `hold:${run.id}` }),
      );
    now = at(30, 5000);
    await sink().write(usage(org, run.id, 50)); // 10 credits
    await markG0(run);
    await h.db.transaction().execute((trx) => billing.settleRun(trx, run, { status: "succeeded" }));
    expect(await sumKind(run.id, "charge")).toBe(-10_000);
    const b = await bal(org);
    expect(b.available).toBe(25_000);
    expect(b.held).toBe(0);
    const sum = (await ledger(org)).reduce((s, r) => s + Number(r.amount_milli), 0);
    expect(sum).toBe(25_000);
  });
});

describe("concurrency", () => {
  test("parallel holds of one org never overdraw; parallel settlements keep Σ ledger consistent", async () => {
    now = T0;
    const org = await newOrg();
    const runs = await Promise.all(Array.from({ length: 12 }, () => newRun(org, "build", 30_000)));
    const results = await Promise.allSettled(
      runs.map((r) =>
        h.db
          .transaction()
          .execute((trx) =>
            billing.hold(trx, { orgId: org, runId: r.id, amountMilli: 30_000, key: `hold:${r.id}` }),
          ),
      ),
    );
    const ok = runs.filter((_r, i) => results[i]?.status === "fulfilled");
    expect(ok).toHaveLength(3);
    for (const r of results)
      if (r.status === "rejected") expect((r.reason as ApiError).code).toBe("INSUFFICIENT_CREDITS");
    expect((await bal(org)).available).toBe(10_000);
    for (const [i, r] of ok.entries()) await sink().write(usage(org, r.id, 20 * (i + 1)));
    await Promise.all(ok.map((r) => markG0(r)));
    // Every run settled twice in parallel: once per run.
    await Promise.all(
      [...ok, ...ok].map((r) =>
        h.db.transaction().execute((trx) => billing.settleRun(trx, r, { status: "succeeded" })),
      ),
    );
    let charged = 0;
    for (const r of ok) {
      const c = -(await sumKind(r.id, "charge"));
      expect(c).toBe(Math.min(30_000, await billableUsage(r.id)));
      charged += c;
    }
    expect(charged).toBe(4000 + 8000 + 12_000);
    const b = await bal(org);
    expect(b).toMatchObject({ available: 100_000 - charged, held: 0, balance: 100_000 - charged });
  });
});

type PlanYaml = {
  price_rub_month?: number;
  price_rub?: number;
  credits?: number;
  expires_after_days?: number;
  grants?: { welcome?: { credits: number; expires_after_days: number }; monthly: { credits: number } };
  limits?: Record<string, number>;
};

describe("plans mirror specs/platform/billing.yaml#plans", () => {
  test("prices, grants and limits; the members limit of M1-02 is the same table", () => {
    const y = loadYaml("specs/platform/billing.yaml") as {
      credit: { rub_cost_rate: number };
      plans: Record<string, PlanYaml>;
    };
    expect(RUB_PER_CREDIT).toBe(y.credit.rub_cost_rate);
    for (const id of ["free", "start", "business"] as const) {
      const p = y.plans[id];
      expect(PLANS[id].priceRubMonth).toBe(p?.price_rub_month);
      expect(PLANS[id].monthlyMilli).toBe((p?.grants?.monthly.credits ?? 0) * 1000);
      expect(PLANS[id].limits).toEqual(p?.limits);
      expect(MEMBER_LIMITS[id]).toBe(p?.limits?.members);
    }
    expect(WELCOME).toEqual({
      milli: (y.plans.free?.grants?.welcome?.credits ?? 0) * 1000,
      days: y.plans.free?.grants?.welcome?.expires_after_days,
    });
    expect(TOPUP).toEqual({
      milli: (y.plans.topup?.credits ?? 0) * 1000,
      priceRub: y.plans.topup?.price_rub,
      days: y.plans.topup?.expires_after_days,
    });
  });
});
