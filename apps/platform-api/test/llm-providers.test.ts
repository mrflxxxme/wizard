// D76 (B2-22): founder alerts about the model providers — an empty balance or an opened breaker reported by the
// router hook (run engine and AI gateway), and the early balance warning estimated from llm_calls.
import type { RouterOptions } from "@wizard/llm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { LlmMonthlyCap } from "../src/billing/llm-cap.js";
import { assertStartupAllowed, loadConfig } from "../src/config.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import type { OpsAlert } from "../src/ops/alert.js";
import { reportProviderDegraded } from "../src/runs/models-outage.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitFor,
  waitRun,
} from "./helpers.js";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
const alerts: OpsAlert[] = [];
const routerOpts: RouterOptions[] = [];

beforeAll(async () => {
  tdb = await createTestDb("llmproviders");
  const fake = fakeRouterFactory();
  api = await startApi(tdb.url, {
    executors: fakeExecutors({ spec: "forum" }),
    alert: async (a) => {
      alerts.push(a);
    },
    createRouter: (o) => {
      routerOpts.push(o);
      return fake(o);
    },
  });
});
afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
});

const PII = /@|\+7|\d{3}-\d{2}-\d{2}/;

describe("provider degraded → founder alert (onProviderDegraded)", () => {
  test("the run engine passes the hook; an empty Z.ai balance alerts once per day in Russian, without PII", async () => {
    alerts.length = 0;
    const created = await api.req("POST", "/systems", { body: { prompt: "Регистрация на форум" } });
    expect(created.status, created.text).toBe(201);
    await waitRun(api, created.body.run.id, ["succeeded"]);
    const hook = routerOpts.at(-1)?.onProviderDegraded;
    expect(hook).toBeTypeOf("function");
    hook?.({ provider: "zai", reason: "balance_exhausted" });
    hook?.({ provider: "zai", reason: "balance_exhausted" });
    await waitFor(async () => alerts.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    const sent = alerts.filter((a) => a.event === "llm_provider_balance_exhausted");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      level: "error",
      fields: { code: "PROVIDER_BALANCE_EXHAUSTED", reason: "zai" },
    });
    expect(sent[0]?.text).toMatch(/у провайдера моделей Z\.ai закончился баланс/);
    expect(sent[0]?.text).toMatch(/Cloud\.ru/);
    expect(sent[0]?.text).not.toMatch(PII);
  });

  test("the AI gateway passes the hook too; an opened breaker warns once per hour and model", async () => {
    alerts.length = 0;
    const captured: RouterOptions[] = [];
    const gw = new AiGateway({
      db: api.deps.db,
      config: api.deps.config,
      billing: api.deps.billing,
      alert: async (a) => {
        alerts.push(a);
      },
      createRouter: (o) => {
        captured.push(o);
        return fakeRouterFactory()(o);
      },
    });
    gw.router();
    const hook = captured[0]?.onProviderDegraded;
    expect(hook).toBeTypeOf("function");
    hook?.({ provider: "cloudru", reason: "circuit_open", model: "gigachat-3.5" });
    await waitFor(async () => alerts.length > 0);
    const now = new Date();
    const again = await reportProviderDegraded({
      db: api.deps.db,
      event: { provider: "cloudru", reason: "circuit_open", model: "gigachat-3.5" },
      now,
    });
    expect(again).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: "warn", event: "llm_provider_circuit_open" });
    expect(alerts[0]?.text).toMatch(/модель gigachat-3\.5 провайдера Cloud\.ru не отвечает/);
  });
});

describe("early balance warning (WIZARD_LLM_BALANCE_*, D76)", () => {
  async function spend(provider: string, rub: number, at: string): Promise<void> {
    await api.deps.pg`
      insert into platform.llm_calls (org_id, call_type, tier, provider, model_id, status, route_reason,
        policy_version, scrubbed, cost_rub, billable, mode, created_at)
      values (${DEFAULT_ORG_ID}, 'plan', 'T1', ${provider}, 'glm-5.3', 'ok', 'default_T1', 'test', true, ${rub},
        true, 'live', ${at})`;
  }

  test("config: «<₽>@<ISO>» per provider, threshold 300 ₽ by default; a malformed value is refused at startup", () => {
    const c = loadConfig({
      WIZARD_LLM_BALANCE_ZAI: "1000@2026-10-20T09:00:00+03:00",
      WIZARD_LLM_BALANCE_CLOUDRU: "2500,5@2026-10-20T06:00:00Z",
    });
    expect(c.llmBalanceWarnRub).toBe(300);
    expect(c.llmBalances).toEqual([
      { provider: "zai", rub: 1000, since: new Date("2026-10-20T06:00:00Z") },
      { provider: "cloudru", rub: 2500.5, since: new Date("2026-10-20T06:00:00Z") },
    ]);
    expect(loadConfig({}).llmBalances).toEqual([]);
    expect(() => assertStartupAllowed(loadConfig({ WIZARD_LLM_BALANCE_ZAI: "1000" }))).toThrow(
      /WIZARD_LLM_BALANCE_ZAI/,
    );
    expect(() => assertStartupAllowed(loadConfig({ WIZARD_LLM_BALANCE_WARN_RUB: "-1" }))).toThrow(
      /WIZARD_LLM_BALANCE_WARN_RUB/,
    );
  });

  test("reconciled balance minus the provider's spend since then ≤ threshold → one warning per reconciliation", async () => {
    const got: OpsAlert[] = [];
    const since = new Date("2026-10-20T06:00:00Z");
    const mk = (rub: number, at: Date) =>
      new LlmMonthlyCap({
        db: api.deps.db,
        capRub: 1_000_000,
        alert: async (a) => {
          got.push(a);
        },
        now: () => new Date("2026-10-20T12:00:00Z"),
        balances: [{ provider: "zai", rub, since: at }],
        balanceWarnRub: 300,
      });
    await spend("zai", 500, "2026-10-20T05:00:00Z"); // before the reconciliation: not counted
    await spend("zai", 650, "2026-10-20T07:00:00Z");
    await spend("cloudru", 900, "2026-10-20T07:00:00Z"); // another provider
    await mk(1000, since).assert();
    expect(got).toEqual([]); // 1000 − 650 = 350 > 300
    await spend("zai", 100, "2026-10-20T08:00:00Z");
    await mk(1000, since).assert();
    await mk(1000, since).assert();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ level: "warn", event: "llm_provider_balance_low" });
    expect(got[0]?.text).toMatch(
      /по оценке на балансе Z\.ai осталось около 250 ₽ — порог предупреждения 300 ₽/,
    );
    // A new reconciliation re-arms the warning.
    await mk(3000, new Date("2026-10-20T09:00:00Z")).assert();
    expect(got).toHaveLength(1);
    await mk(200, new Date("2026-10-20T09:00:00Z")).assert();
    expect(got).toHaveLength(2);
  });
});
