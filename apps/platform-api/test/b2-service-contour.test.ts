// Acceptance B2-01 and B2-04 (product.yaml#decisions.D76_beta_v2 (10, 14); docs/reviews/grill-6.md № 12, 18): the kind
// of an org (client | staff | eval) — staff orgs are free of the D70 pilot limit and may use the staff reserve of the
// daily LLM cap, client and eval runs are refused before it; eval orgs have their own daily cap and the beta v2
// development budget with the 70 % / 100 % founder alerts; GET /admin/llm-spend gives the spend by day and purpose.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setStaff } from "../src/abuse/staff.js";
import { totpCode } from "../src/auth/totp.js";
import {
  LLM_B2_BUDGET_EXHAUSTED_RU,
  LLM_DAILY_BUDGET_EXHAUSTED_RU,
  LLM_EVAL_DAILY_BUDGET_EXHAUSTED_RU,
} from "../src/billing/llm-cap.js";
import { checkB2Budget, llmSpendByDay } from "../src/billing/llm-spend.js";
import { assertPilotLimit, pilotUsage } from "../src/billing/pilot-limits.js";
import { assertStartupAllowed, loadConfig } from "../src/config.js";
import type { OpsAlert } from "../src/ops/alert.js";
import { grantPilotCredits } from "../src/pilot/service.js";
import { createTestDb, fakeExecutors, fakeRouterFactory, startApi, type TestApi } from "./helpers.js";
import { devLogin, expectContract, type Session } from "./session.js";

const STAFF = "founder-b2@example.test";
const CLIENT = "owner-b2@bakery.example";
const EVAL = "eval+b2@example.test";
// Daily cap 100 ₽ with a staff reserve of 20 ₽: clients and eval stop at 80 ₽. Eval: 30 ₽ a day, B2 budget 50 ₽.
const CFG = {
  llmMonthlyCapRub: 100_000,
  llmDailyCapRub: 100,
  llmStaffReserveRub: 20,
  llmEvalDailyCapRub: 30,
  b2BudgetRub: 50,
  b2BudgetSince: "2026-10-06",
};

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let staff: Session;
let client: Session;
let evalUser: Session;
let staffOrg = "";
let clientOrg = "";
let evalOrg = "";
const alerts: OpsAlert[] = [];
const clock = { t: Date.parse("2026-10-15T09:00:00Z") }; // 15 October 12:00 MSK

const orgOf = async (s: Session) => (await s.req("GET", "/me")).body.memberships[0].orgId as string;
const kindOf = async (orgId: string) =>
  (
    await api.deps.db
      .selectFrom("platform.orgs")
      .select("kind")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow()
  ).kind;

beforeAll(async () => {
  tdb = await createTestDb("b2contour");
  api = await startApi(tdb.url, {
    config: { runConcurrency: 4, ...CFG },
    alert: async (a) => {
      alerts.push(a);
    },
    now: () => new Date(clock.t),
    creditsCronMs: 0,
    abuseSlaMs: 0,
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
  });
  staff = await devLogin(api, STAFF);
  client = await devLogin(api, CLIENT);
  evalUser = await devLogin(api, EVAL);
  [staffOrg, clientOrg, evalOrg] = await Promise.all([orgOf(staff), orgOf(client), orgOf(evalUser)]);
  for (const orgId of [staffOrg, clientOrg, evalOrg]) {
    await api.deps.db.updateTable("platform.orgs").set({ plan: "pilot" }).where("id", "=", orgId).execute();
    await grantPilotCredits(api.deps.db, api.deps.billing, {
      orgId,
      credits: 5000,
      reference: `b2-${orgId}`,
    });
  }
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

/** A paid model call of `orgId` at `at` (or a free one: fixture / non-billable). */
async function spend(orgId: string, rub: number, at: string, mode = "live", billable = true): Promise<void> {
  await api.deps.pg`
    insert into platform.llm_calls (org_id, call_type, tier, provider, model_id, status, route_reason,
      policy_version, scrubbed, cost_rub, billable, mode, created_at)
    values (${orgId}, 'orchestrate', 'T0', 'cloudru', 'glm-5.1', 'ok', 'default_T0', 'test', false, ${rub},
      ${billable}, ${mode}, ${at})`;
}

const budget = (orgId: string) => api.deps.billing.assertLlmBudget(orgId);
const refused = (orgId: string, message_ru: string) =>
  expect(budget(orgId)).rejects.toMatchObject({ code: "LLM_BUDGET_EXHAUSTED", message_ru });
const events = (event: string) => alerts.filter((a) => a.event === event);

describe("config", () => {
  test("defaults: reserve 200 ₽, eval 300 ₽ a day, B2 budget 1 000 ₽ since 2026-10-07; bad values refuse the start", () => {
    const c = loadConfig({});
    expect([c.llmStaffReserveRub, c.llmEvalDailyCapRub, c.b2BudgetRub, c.b2BudgetSince]).toEqual([
      200,
      300,
      1000,
      "2026-10-07",
    ]);
    const env = loadConfig({
      WIZARD_LLM_STAFF_RESERVE_RUB: "150",
      WIZARD_LLM_EVAL_DAILY_CAP_RUB: "250",
      WIZARD_B2_BUDGET_RUB: "1200",
      WIZARD_B2_BUDGET_SINCE: "2026-10-08",
    });
    expect([env.llmStaffReserveRub, env.llmEvalDailyCapRub, env.b2BudgetRub, env.b2BudgetSince]).toEqual([
      150,
      250,
      1200,
      "2026-10-08",
    ]);
    for (const [k, v] of [
      ["WIZARD_LLM_STAFF_RESERVE_RUB", "-1"],
      ["WIZARD_LLM_EVAL_DAILY_CAP_RUB", "0"],
      ["WIZARD_B2_BUDGET_RUB", "abc"],
      ["WIZARD_B2_BUDGET_SINCE", "06.10.2026"],
    ] as const)
      expect(() => assertStartupAllowed(loadConfig({ [k]: v })), k).toThrow(new RegExp(k));
  });
});

describe("org kind (B2-01)", () => {
  test("new orgs are client; setStaff makes the orgs a staff user owns staff; orgs a staff user creates are staff", async () => {
    expect(await kindOf(clientOrg)).toBe("client");
    expect(await kindOf(staffOrg)).toBe("client");
    await setStaff(api.deps.db, STAFF, true);
    expect(await kindOf(staffOrg)).toBe("staff");
    expect(await kindOf(clientOrg)).toBe("client");
    const created = await staff.req("POST", "/orgs", { body: { name: "Wizard — показ" } });
    expect(created.status, created.text).toBe(201);
    expect(await kindOf(created.body.id)).toBe("staff");
    const other = await client.req("POST", "/orgs", { body: { name: "Пекарня 2" } });
    expect(other.status, other.text).toBe(201);
    expect(await kindOf(other.body.id)).toBe("client");
  });

  test("PUT /admin/orgs/:id/flags sets the kind: staff only (404), MFA, 400 on an unknown kind, staff_audit_log", async () => {
    expect((await client.req("PUT", `/admin/orgs/${evalOrg}/flags`, { body: { kind: "eval" } })).status).toBe(
      404,
    );
    const en = await staff.req("POST", "/admin/mfa/enroll");
    expect(en.status, en.text).toBe(200);
    const ok = await staff.req("POST", "/admin/mfa/confirm", { body: { code: totpCode(en.body.secret) } });
    expect(ok.status, ok.text).toBe(200);
    const bad = await staff.req("PUT", `/admin/orgs/${evalOrg}/flags`, { body: { kind: "vip" } });
    expect(bad.status).toBe(400);
    const r = await staff.req("PUT", `/admin/orgs/${evalOrg}/flags`, { body: { kind: "eval" } });
    expect(r.status, r.text).toBe(200);
    expectContract("adminSetOrgFlags", r);
    expect(r.body).toMatchObject({ orgId: evalOrg, kind: "eval" });
    expect(await kindOf(evalOrg)).toBe("eval");
    const audit = await api.deps.db
      .selectFrom("platform.staff_audit_log")
      .selectAll()
      .where("action", "=", "org_flags")
      .where("target", "=", `org:${evalOrg}`)
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.note).toContain('"kind":"eval"');
    // Other flags keep the kind.
    const keep = await staff.req("PUT", `/admin/orgs/${evalOrg}/flags`, {
      body: { requireFounderReview: true },
    });
    expect(keep.body.kind).toBe("eval");
  });
});

describe("D70 pilot limit does not apply to staff orgs (B2-01)", () => {
  async function seedBuilds(orgId: string, n: number) {
    for (let i = 0; i < n; i++)
      await api.deps.db
        .insertInto("platform.runs")
        .values({
          id: randomUUID(),
          org_id: orgId,
          system_id: null,
          kind: "build",
          mode: "create",
          status: "succeeded",
          input: JSON.stringify({}) as never,
          created_at: new Date(clock.t - (i + 1) * 60_000),
        })
        .execute();
  }
  const check = (orgId: string) =>
    api.deps.db
      .transaction()
      .execute((trx) => assertPilotLimit(trx, { orgId, mode: "create", now: new Date(clock.t) }));

  test("6 builds in 30 days: the staff org passes with no limit, a client org of the same plan gets BUILDS_LIMIT", async () => {
    const other = (await client.req("POST", "/orgs", { body: { name: "Пекарня 3" } })).body.id as string;
    await api.deps.db.updateTable("platform.orgs").set({ plan: "pilot" }).where("id", "=", other).execute();
    await seedBuilds(staffOrg, 6);
    await seedBuilds(other, 6);
    await expect(check(staffOrg)).resolves.toBeUndefined();
    await expect(check(other)).rejects.toMatchObject({ code: "BUILDS_LIMIT" });
    const u = await pilotUsage(api.deps.db, staffOrg, new Date(clock.t));
    expect(u.builds).toEqual({ limit: null, used: 6, left: null, nextAt: null });
    expect(u.edits.limit).toBeNull();
  });
});

describe("daily cap with the staff reserve (B2-01)", () => {
  test("at cap − reserve clients and eval are refused (one warning), staff goes on; at the cap staff stops too", async () => {
    await spend(clientOrg, 79, "2026-10-15T08:00:00Z");
    await expect(budget(clientOrg)).resolves.toBeUndefined();
    await spend(clientOrg, 1, "2026-10-15T08:10:00Z"); // 80 ₽ = 100 − 20
    await refused(clientOrg, LLM_DAILY_BUDGET_EXHAUSTED_RU);
    await refused(evalOrg, LLM_DAILY_BUDGET_EXHAUSTED_RU);
    await expect(budget(staffOrg)).resolves.toBeUndefined();
    await refused(clientOrg, LLM_DAILY_BUDGET_EXHAUSTED_RU);
    expect(events("llm_daily_reserve_reached")).toHaveLength(1);
    expect(events("llm_daily_reserve_reached")[0]?.text).toMatch(
      /для клиентов и замеров исчерпан — 80 ₽ из 80 ₽ за 2026-10-15.*Резерв 20 ₽/,
    );
    expect(events("llm_daily_cap_reached")).toEqual([]);
  });

  test("over HTTP: a client's new system → 503 LLM_BUDGET_EXHAUSTED, the staff org builds", async () => {
    const r = await client.req("POST", "/systems", {
      body: { prompt: "Заявки на ремонт", orgId: clientOrg },
    });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("LLM_BUDGET_EXHAUSTED");
    expectContract("createSystem", r);
    const s = await staff.req("POST", "/systems", { body: { prompt: "Заявки на ремонт", orgId: staffOrg } });
    expect(s.status, s.text).toBe(201);
    // Admitted past the caps: the LLM run of the staff org is created.
    expect(s.body.run).toMatchObject({ kind: "interview_turn", status: "queued" });
  });

  test("the whole cap reached by staff: staff refused too, one daily-cap alert", async () => {
    await spend(staffOrg, 20, "2026-10-15T08:20:00Z");
    await refused(staffOrg, LLM_DAILY_BUDGET_EXHAUSTED_RU);
    await refused(clientOrg, LLM_DAILY_BUDGET_EXHAUSTED_RU);
    expect(events("llm_daily_cap_reached")).toHaveLength(1);
  });
});

describe("eval daily cap (B2-01)", () => {
  test("eval orgs' own spend reaches 30 ₽: eval refused with its text, clients and staff go on; the next day is free", async () => {
    clock.t = Date.parse("2026-10-16T09:00:00Z");
    await spend(clientOrg, 25, "2026-10-16T08:00:00Z"); // clients do not use the eval cap
    await spend(evalOrg, 29, "2026-10-16T08:00:00Z");
    await expect(budget(evalOrg)).resolves.toBeUndefined();
    await spend(evalOrg, 1, "2026-10-16T08:05:00Z");
    await refused(evalOrg, LLM_EVAL_DAILY_BUDGET_EXHAUSTED_RU);
    await refused(evalOrg, LLM_EVAL_DAILY_BUDGET_EXHAUSTED_RU);
    await expect(budget(clientOrg)).resolves.toBeUndefined();
    await expect(budget(staffOrg)).resolves.toBeUndefined();
    expect(events("llm_eval_daily_cap_reached")).toHaveLength(1);
    expect(events("llm_eval_daily_cap_reached")[0]?.text).toMatch(
      /замеров на модели исчерпан — 30 ₽ из 30 ₽/,
    );
    clock.t = Date.parse("2026-10-17T09:00:00Z");
    await expect(budget(evalOrg)).resolves.toBeUndefined();
  });
});

describe("beta v2 development budget (B2-04)", () => {
  test("eval spend since 06.10: 70 % → one warning, 100 % → one error and eval refused; clients and staff go on", async () => {
    // Before the window, free and non-billable calls do not count; spend so far: 30 ₽ of 16 October (60 %).
    await spend(evalOrg, 500, "2026-10-05T12:00:00Z");
    await spend(evalOrg, 500, "2026-10-17T08:00:00Z", "fixture");
    await spend(evalOrg, 500, "2026-10-17T08:00:00Z", "live", false);
    await expect(budget(evalOrg)).resolves.toBeUndefined();
    expect(events("b2_budget_warning")).toEqual([]);
    await spend(evalOrg, 6, "2026-10-17T08:10:00Z"); // 36 ₽ = 72 %
    await expect(budget(evalOrg)).resolves.toBeUndefined();
    await expect(budget(evalOrg)).resolves.toBeUndefined();
    expect(events("b2_budget_warning")).toHaveLength(1);
    expect(events("b2_budget_warning")[0]).toMatchObject({ level: "warn" });
    expect(events("b2_budget_warning")[0]?.text).toBe(
      "Wizard: израсходовано 72 % бюджета разработки беты v2 на модели — 36 ₽ из 50 ₽ с 2026-10-06 (МСК).",
    );
    await spend(evalOrg, 14, "2026-10-17T08:20:00Z"); // 50 ₽
    await refused(evalOrg, LLM_B2_BUDGET_EXHAUSTED_RU);
    await refused(evalOrg, LLM_B2_BUDGET_EXHAUSTED_RU);
    await expect(budget(clientOrg)).resolves.toBeUndefined();
    await expect(budget(staffOrg)).resolves.toBeUndefined();
    expect(events("b2_budget_reached")).toHaveLength(1);
    expect(events("b2_budget_reached")[0]).toMatchObject({ level: "error" });
    expect(events("b2_budget_reached")[0]?.text).toMatch(
      /бюджет разработки беты v2 на модели исчерпан — 50 ₽ из 50 ₽/,
    );
    expect(events("b2_budget_warning")).toHaveLength(1);
    // Staff spend never counts against the budget; raising the budget lets eval go on and arms the alerts again.
    const raised = await checkB2Budget(api.deps.db, { budgetRub: 60, since: "2026-10-06" });
    expect(raised).toMatchObject({
      spentRub: 50,
      budgetRub: 60,
      sharePercent: 83,
      warn: true,
      reached: false,
    });
    // Texts carry no personal data.
    for (const a of alerts) expect(a.text).not.toMatch(/@|bakery|founder/);
  });
});

describe("GET /admin/llm-spend (B2-04)", () => {
  test("non-staff → 404; days out of range → 400", async () => {
    const r = await client.req("GET", "/admin/llm-spend");
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("NOT_FOUND");
    expect((await api.req("GET", "/admin/llm-spend")).status).toBe(404);
    for (const d of ["0", "93", "x"])
      expect((await staff.req("GET", `/admin/llm-spend?days=${d}`)).status, d).toBe(400);
  });

  test("by Moscow day and purpose, oldest first, zeros for quiet days; the B2 budget", async () => {
    const r = await staff.req("GET", "/admin/llm-spend?days=4");
    expect(r.status, r.text).toBe(200);
    expectContract("adminLlmSpend", r);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toEqual({
      days: [
        { day: "2026-10-14", client: 0, staff: 0, eval: 0, total: 0 },
        { day: "2026-10-15", client: 80, staff: 20, eval: 0, total: 100 },
        { day: "2026-10-16", client: 25, staff: 0, eval: 30, total: 55 },
        { day: "2026-10-17", client: 0, staff: 0, eval: 20, total: 20 },
      ],
      b2: { since: "2026-10-06", spentRub: 50, budgetRub: 50, sharePercent: 100, warn: true, reached: true },
    });
    const def = await staff.req("GET", "/admin/llm-spend");
    expect(def.body.days).toHaveLength(14);
    expect(def.body.days.at(-1).day).toBe("2026-10-17");
  });

  test("the exported function: a call at 23:30 MSK belongs to that Moscow day", async () => {
    await spend(clientOrg, 7.5, "2026-10-17T20:30:00Z"); // 17 October 23:30 MSK
    await spend(clientOrg, 2.25, "2026-10-17T21:30:00Z"); // 18 October 00:30 MSK
    const rep = await llmSpendByDay(api.deps.db, {
      days: 2,
      now: new Date("2026-10-17T21:45:00Z"),
      b2: { budgetRub: 1000, since: "2026-10-06" },
    });
    expect(rep.days).toEqual([
      { day: "2026-10-17", client: 7.5, staff: 0, eval: 20, total: 27.5 },
      { day: "2026-10-18", client: 2.25, staff: 0, eval: 0, total: 2.25 },
    ]);
    expect(rep.b2).toMatchObject({ spentRub: 50, sharePercent: 5, warn: false, reached: false });
  });
});
