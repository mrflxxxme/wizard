// Acceptance V3-01 (product.yaml#decisions.D77_v3 (18б), docs/plans/2026-10-08-v3.md §5): the model spend limits of the
// time of V3 come from the configuration — 3 000 ₽ a day, 15 000 ₽ a month, warnings at 50 % and 80 %; the founder's
// orgs (staff) have their own 2 500 ₽ a month, which clients and eval never take, and their spend stays out of the
// monthly cap of clients and eval; the v3 development budget (12 000 ₽ since 08.10) replaces the B2 one. The platform
// runs on the defaults here: nothing of the limits is set in the test's config.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  LLM_BUDGET_EXHAUSTED_RU,
  LLM_DAILY_BUDGET_EXHAUSTED_RU,
  LLM_FOUNDER_BUDGET_EXHAUSTED_RU,
  LLM_V3_BUDGET_EXHAUSTED_RU,
} from "../src/billing/llm-cap.js";
import { reachedSharePercent, V3_ALERT_SHARES, V3_LIMITS } from "../src/billing/v3-limits.js";
import { assertStartupAllowed, loadConfig } from "../src/config.js";
import type { OrgKind } from "../src/db/types.js";
import type { OpsAlert } from "../src/ops/alert.js";
import { createTestDb, loadYaml, ROOT, startApi, type TestApi } from "./helpers.js";
import { devLogin } from "./session.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const orgs: Record<OrgKind, string> = { client: "", staff: "", eval: "" };
const alerts: OpsAlert[] = [];
const clock = { t: Date.parse("2026-10-20T09:00:00Z") }; // 20 October 12:00 MSK

beforeAll(async () => {
  tdb = await createTestDb("v3limits");
  api = await startApi(tdb.url, {
    config: { runConcurrency: 4 },
    alert: async (a) => {
      alerts.push(a);
    },
    now: () => new Date(clock.t),
    creditsCronMs: 0,
    abuseSlaMs: 0,
  });
  for (const kind of ["client", "staff", "eval"] as const) {
    const s = await devLogin(api, `v3-${kind}@example.test`);
    const orgId = (await s.req("GET", "/me")).body.memberships[0].orgId as string;
    await api.deps.db.updateTable("platform.orgs").set({ kind }).where("id", "=", orgId).execute();
    orgs[kind] = orgId;
  }
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

/** A paid model call of the org of `kind` at `at`. */
async function spend(kind: OrgKind, rub: number, at: string): Promise<void> {
  await api.deps.pg`
    insert into platform.llm_calls (org_id, call_type, tier, provider, model_id, status, route_reason,
      policy_version, scrubbed, cost_rub, billable, mode, created_at)
    values (${orgs[kind]}, 'orchestrate', 'T0', 'cloudru', 'glm-5.1', 'ok', 'default_T0', 'test', false, ${rub},
      true, 'live', ${at})`;
}

const budget = (kind: OrgKind) => api.deps.billing.assertLlmBudget(orgs[kind]);
const passes = (kind: OrgKind) => expect(budget(kind), kind).resolves.toBeUndefined();
const refused = (kind: OrgKind, message_ru: string) =>
  expect(budget(kind), kind).rejects.toMatchObject({ code: "LLM_BUDGET_EXHAUSTED", message_ru });
const events = (event: string) => alerts.filter((a) => a.event === event);
/** Group separators of ru-RU numbers (U+202F / U+00A0) → a plain space. */
const plain = (s: string | undefined) => (s ?? "").replace(/[  ]/g, " ");

describe("configuration", () => {
  test("defaults of the time of V3: 3 000 ₽ a day, 15 000 ₽ a month, the founder's 2 500 ₽, v3 budget 12 000 ₽ since 08.10", () => {
    const c = loadConfig({});
    expect({
      day: c.llmDailyCapRub,
      month: c.llmMonthlyCapRub,
      founder: c.llmFounderMonthlyCapRub,
      evalDay: c.llmEvalDailyCapRub,
      v3: [c.v3BudgetRub, c.v3BudgetSince],
    }).toEqual({ day: 3000, month: 15000, founder: 2500, evalDay: 3000, v3: [12000, "2026-10-08"] });
    expect(V3_LIMITS).toEqual({
      dailyCapRub: 3000,
      monthlyCapRub: 15000,
      founderMonthlyCapRub: 2500,
      budgetRub: 12000,
      budgetSince: "2026-10-08",
    });
    expect(V3_ALERT_SHARES).toEqual([0.5, 0.8]);
    const env = loadConfig({
      WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB: "3000",
      WIZARD_V3_BUDGET_RUB: "13000",
      WIZARD_V3_BUDGET_SINCE: "2026-10-09",
    });
    expect([env.llmFounderMonthlyCapRub, env.v3BudgetRub, env.v3BudgetSince]).toEqual([
      3000,
      13000,
      "2026-10-09",
    ]);
    for (const [k, v] of [
      ["WIZARD_LLM_FOUNDER_MONTHLY_CAP_RUB", "0"],
      ["WIZARD_V3_BUDGET_RUB", "abc"],
      ["WIZARD_V3_BUDGET_SINCE", "08.10.2026"],
    ] as const)
      expect(() => assertStartupAllowed(loadConfig({ [k]: v })), k).toThrow(new RegExp(k));
  });

  test("the same numbers in the helm values of the pilot and in the spend journal", () => {
    for (const f of ["infra/helm/wizard/values.yaml", "infra/helm/profiles/pilot.yaml"])
      expect((loadYaml(f).config as { llmMonthlyCapRub: number }).llmMonthlyCapRub, f).toBe(
        V3_LIMITS.monthlyCapRub,
      );
    const journal = JSON.parse(readFileSync(join(ROOT, "docs/progress/v3-spend.json"), "utf8"));
    expect([journal.budgetRub, journal.since]).toEqual([V3_LIMITS.budgetRub, V3_LIMITS.budgetSince]);
  });

  test("reachedSharePercent: the highest share reached", () => {
    expect(reachedSharePercent(49.99, 100)).toBeNull();
    expect(reachedSharePercent(50, 100)).toBe(50);
    expect(reachedSharePercent(79, 100)).toBe(50);
    expect(reachedSharePercent(80, 100)).toBe(80);
    expect(reachedSharePercent(150, 100)).toBe(80);
  });
});

describe("the monthly cap and the founder's own pool (October)", () => {
  test("50 % and 80 % of 15 000 ₽ warn once each; eval counts, staff does not", async () => {
    await spend("client", 7400, "2026-10-05T09:00:00Z");
    await passes("client");
    expect(events("llm_monthly_cap_warning")).toEqual([]);
    await spend("client", 100, "2026-10-06T09:00:00Z"); // 7 500 ₽ = 50 %
    await passes("client");
    await passes("client");
    expect(events("llm_monthly_cap_warning")).toHaveLength(1);
    expect(plain(events("llm_monthly_cap_warning")[0]?.text)).toBe(
      "Wizard: израсходовано 50 % месячного лимита на модели — 7 500 ₽ из 15 000 ₽ за 2026-10 (МСК).",
    );
    // Eval takes the clients' pool; the B2 budget (1 000 ₽) is over — the v3 one replaced it.
    await spend("eval", 4500, "2026-10-09T09:00:00Z"); // 12 000 ₽ = 80 %
    await passes("eval");
    expect(events("b2_budget_reached")).toEqual([]);
    expect(events("llm_monthly_cap_warning")).toHaveLength(2);
    expect(events("llm_monthly_cap_warning")[1]?.text).toMatch(
      /^Wizard: израсходовано 80 % месячного лимита/,
    );
    // The founder's 2 000 ₽ do not move the clients' pool: no new warning, only the founder's own 80 %.
    await spend("staff", 2000, "2026-10-10T09:00:00Z");
    await passes("staff");
    await passes("client");
    expect(events("llm_monthly_cap_warning")).toHaveLength(2);
    expect(events("llm_founder_cap_warning")).toHaveLength(1);
    expect(plain(events("llm_founder_cap_warning")[0]?.text)).toBe(
      "Wizard: израсходовано 80 % месячного лимита организации основателя на модели — 2 000 ₽ из 2 500 ₽ за 2026-10 (МСК).",
    );
  });

  test("clients and eval reach 15 000 ₽: they are refused, the founder goes on — the pool is not taken", async () => {
    await spend("client", 3000, "2026-10-11T09:00:00Z"); // clients + eval = 15 000 ₽ (all orgs: 17 000 ₽)
    await refused("client", LLM_BUDGET_EXHAUSTED_RU);
    await refused("eval", LLM_BUDGET_EXHAUSTED_RU);
    await passes("staff");
    expect(events("llm_monthly_cap_reached")).toHaveLength(1);
    expect(plain(events("llm_monthly_cap_reached")[0]?.text)).toMatch(
      /месячный лимит расходов на модели исчерпан — 15 000 ₽ из 15 000 ₽ за 2026-10/,
    );
  });

  test("the founder reaches 2 500 ₽: refused with the founder's text, one alert", async () => {
    await spend("staff", 500, "2026-10-12T09:00:00Z");
    await refused("staff", LLM_FOUNDER_BUDGET_EXHAUSTED_RU);
    await refused("staff", LLM_FOUNDER_BUDGET_EXHAUSTED_RU);
    expect(events("llm_founder_cap_reached")).toHaveLength(1);
    expect(events("llm_founder_cap_reached")[0]).toMatchObject({ level: "error" });
    expect(plain(events("llm_founder_cap_reached")[0]?.text)).toMatch(
      /месячный лимит организации основателя на модели исчерпан — 2 500 ₽ из 2 500 ₽ за 2026-10.*клиенты и замеры работают/,
    );
  });
});

describe("the daily cap (November)", () => {
  test("50 % and 80 % of 3 000 ₽ warn once each; the staff reserve, then the cap", async () => {
    clock.t = Date.parse("2026-11-10T09:00:00Z"); // 10 November 12:00 MSK, a new month
    await passes("client");
    await passes("staff");
    await spend("client", 1500, "2026-11-10T06:00:00Z"); // 50 %
    await passes("client");
    expect(events("llm_daily_cap_warning")).toHaveLength(1);
    expect(plain(events("llm_daily_cap_warning")[0]?.text)).toBe(
      "Wizard: израсходовано 50 % дневного лимита на модели — 1 500 ₽ из 3 000 ₽ за 2026-11-10 (МСК).",
    );
    await spend("client", 900, "2026-11-10T07:00:00Z"); // 2 400 ₽ = 80 %
    await passes("client");
    await passes("client");
    expect(events("llm_daily_cap_warning")).toHaveLength(2);
    expect(events("llm_daily_cap_warning")[1]?.text).toMatch(/80 % дневного лимита/);
    await spend("client", 400, "2026-11-10T08:00:00Z"); // 2 800 ₽ = 3 000 − the 200 ₽ staff reserve
    await refused("client", LLM_DAILY_BUDGET_EXHAUSTED_RU);
    await passes("staff");
    await spend("staff", 200, "2026-11-10T08:30:00Z");
    await refused("staff", LLM_DAILY_BUDGET_EXHAUSTED_RU);
    expect(events("llm_daily_cap_reached")).toHaveLength(1);
    expect(events("llm_daily_cap_warning")).toHaveLength(2);
  });
});

describe("the v3 development budget (December)", () => {
  test("eval since 08.10: 50 % and 80 % of 12 000 ₽ warn once each, 100 % refuses eval only", async () => {
    clock.t = Date.parse("2026-12-15T09:00:00Z");
    await spend("eval", 1500, "2026-12-01T09:00:00Z"); // 4 500 + 1 500 = 6 000 ₽
    await passes("eval");
    expect(events("v3_budget_warning")).toHaveLength(1);
    expect(plain(events("v3_budget_warning")[0]?.text)).toBe(
      "Wizard: израсходовано 50 % бюджета разработки v3 на модели — 6 000 ₽ из 12 000 ₽ с 2026-10-08 (МСК).",
    );
    await spend("eval", 3600, "2026-12-02T09:00:00Z"); // 9 600 ₽ = 80 %
    await passes("eval");
    await passes("eval");
    expect(events("v3_budget_warning")).toHaveLength(2);
    await spend("eval", 2400, "2026-12-03T09:00:00Z"); // 12 000 ₽
    await refused("eval", LLM_V3_BUDGET_EXHAUSTED_RU);
    await refused("eval", LLM_V3_BUDGET_EXHAUSTED_RU);
    await passes("client");
    await passes("staff");
    expect(events("v3_budget_reached")).toHaveLength(1);
    expect(events("v3_budget_reached")[0]).toMatchObject({ level: "error" });
    // No personal data in any alert.
    for (const a of alerts) expect(a.text).not.toMatch(/@|example/);
  });
});
