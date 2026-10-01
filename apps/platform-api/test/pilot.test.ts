// Acceptance M2-15 (product.yaml#decisions.D24_pilot_free, D23_pilot; billing.yaml#plans.pilot): invite-only
// registration with the founder CLI, plan pilot (CLI only, limits, login methods, prod without a card),
// WIZARD_PAYMENTS=off (403 PAYMENTS_DISABLED, webhook off), pilot credits (pilot_grant) and the org list, the platform
// LLM cap of the calendar month (Europe/Moscow) with the 80 % warning and the founder alert.
import type { AppSpec } from "@wizard/appspec";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { agentPlan } from "../src/agents/executors.js";
import { MEMBER_LIMITS } from "../src/auth/accounts.js";
import { moscowMonth } from "../src/billing/llm-cap.js";
import { PILOT_GRANT_DAYS, PLANS, phoneOtpAllowed } from "../src/billing/plans.js";
import { assertStartupAllowed, type Config, loadConfig } from "../src/config.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import type { OpsAlert } from "../src/ops/alert.js";
import { createOpsAlert } from "../src/ops/alert.js";
import { parseArgs, runPilotCli } from "../src/pilot/cli.js";
import { PilotError } from "../src/pilot/invites.js";
import { specPublishBlockers } from "../src/publish/blockers.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { asSession, expectContract, MemoryMailer, ORIGIN, otpLogin } from "./session.js";

const h = { origin: ORIGIN };
const DAY = 24 * 3600_000;

interface Fx {
  api: TestApi;
  mailer: MemoryMailer;
  alerts: OpsAlert[];
  clock: { t: number };
  cli(...argv: string[]): Promise<string>;
  drop(): Promise<void>;
}

async function fixture(tag: string, over: Partial<Config> = {}, migrator = false): Promise<Fx> {
  const tdb = await createTestDb(tag, { migrator });
  const mailer = new MemoryMailer();
  const alerts: OpsAlert[] = [];
  const clock = { t: Date.now() };
  const api = await startApi(tdb.url, {
    config: { billingExemptOrgs: [DEFAULT_ORG_ID], runConcurrency: 4, ...over },
    mailer,
    alert: async (a) => {
      alerts.push(a);
    },
    now: () => new Date(clock.t),
    creditsCronMs: 0,
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    publish: { smoke: async () => ({ ok: true }), lockRetryDelaysMs: [10, 10, 10] },
  });
  return {
    api,
    mailer,
    alerts,
    clock,
    cli: (...argv) =>
      runPilotCli(argv, {
        db: api.deps.db,
        billing: api.deps.billing,
        mailer,
        platformOrigin: api.deps.config.platformOrigin,
        llmMonthlyCapRub: api.deps.config.llmMonthlyCapRub,
        now: () => new Date(clock.t),
      }),
    async drop() {
      await api.dispose();
      await tdb.drop();
    },
  };
}

const requestOtp = (api: TestApi, email: string) =>
  api.req("POST", "/auth/otp/request", { body: { email }, headers: h });
const verify = (api: TestApi, email: string, code: string) =>
  api.req("POST", "/auth/otp/verify", {
    body: { email, code, acceptOffer: true, pdConsent: true },
    headers: h,
  });

describe("WIZARD_REGISTRATION=invite: sign-in of a new e-mail only with an invitation", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("pilotreg", { authMode: "session", registration: "invite", devLogin: true });
  });
  afterAll(async () => {
    await fx?.drop();
  });
  beforeEach(async () => {
    await fx.api.deps.pg`delete from platform.auth_otps`;
  });

  test("config: open by default, invite from the env, unknown value refused at startup", () => {
    expect(loadConfig({}).registration).toBe("open");
    expect(loadConfig({ WIZARD_REGISTRATION: "invite" }).registration).toBe("invite");
    expect(() => assertStartupAllowed(loadConfig({ WIZARD_REGISTRATION: "closed" }))).toThrow(
      /WIZARD_REGISTRATION/,
    );
  });

  test("new e-mail without an invitation: code is sent (204), sign-in → 403 REGISTRATION_INVITE_ONLY in Russian", async () => {
    const email = "stranger@example.ru";
    const r = await requestOtp(fx.api, email);
    expect(r.status).toBe(204);
    const res = await verify(fx.api, email, fx.mailer.code(email));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REGISTRATION_INVITE_ONLY");
    expect(res.body.message_ru).toMatch(/^Регистрация в Wizard пока только по приглашению/);
    expectContract("verifyOtp", res);
    // Nothing is created; dev-login does not bypass the invitation either.
    expect(await fx.api.deps.pg`select id from platform.users where email = ${email}`).toHaveLength(0);
    const dev = await fx.api.req("POST", "/auth/dev-login", { body: { email }, headers: h });
    expect(dev.status).toBe(403);
    expect(dev.body.code).toBe("REGISTRATION_INVITE_ONLY");
  });

  test("CLI invite → letter with the link → sign-in creates the pilot org with the invited credits", async () => {
    const email = "Owner@Coffee.example";
    const out = await fx.cli("invite", email, "--org-name", "Кофейня «Зерно»", "--credits=120");
    expect(out).toMatch(/приглашение отправлено: owner@coffee\.example/);
    const letter = fx.mailer.last("owner@coffee.example", "invite");
    expect(letter?.subject).toBe("Приглашение в пилот Wizard");
    expect(letter?.text).toContain(`${ORIGIN}/login?email=owner%40coffee.example`);
    expect(letter?.text).toContain("«Кофейня «Зерно»»");

    const s = await otpLogin(fx.api, fx.mailer, "owner@coffee.example");
    const me = await s.req("GET", "/me");
    expect(me.body.memberships).toHaveLength(1);
    const orgId = me.body.memberships[0].orgId as string;
    const org = await s.req("GET", `/orgs/${orgId}`);
    expect(org.body).toMatchObject({ name: "Кофейня «Зерно»", plan: "pilot", role: "owner" });
    expectContract("getOrg", org);
    const credits = await s.req("GET", `/orgs/${orgId}/credits`);
    expect(credits.body.available).toBe(120);
    expect(credits.body.buckets).toEqual([expect.objectContaining({ source: "topup", remaining: 120 })]);
    const [inv] = await fx.api.deps
      .pg`select accepted_at, org_id from platform.pilot_invites where email = 'owner@coffee.example'`;
    expect(inv?.accepted_at).not.toBeNull();
    expect(inv?.org_id).toBe(orgId);
    // Signing in again needs no invitation (existing user) and the accepted invitation is not reused.
    await fx.api.deps.pg`delete from platform.auth_otps`;
    await otpLogin(fx.api, fx.mailer, "owner@coffee.example");
    expect(await fx.cli("invites")).toMatch(/owner@coffee\.example\tКофейня «Зерно»\t120 кр\.\tпринято/);
    // A registered address needs no invitation: the CLI says how to assign the plan.
    await expect(fx.cli("invite", "owner@coffee.example")).rejects.toThrow(/уже зарегистрирован/);
  });

  test("existing org member invites keep working for a new e-mail", async () => {
    const owner = await otpLogin(fx.api, fx.mailer, "owner@coffee.example");
    const orgId = (await owner.req("GET", "/me")).body.memberships[0].orgId as string;
    const inv = await owner.req("POST", `/orgs/${orgId}/invites`, {
      body: { email: "barista@coffee.example", role: "editor" },
    });
    expect(inv.status, inv.text).toBe(201);
    await fx.api.deps.pg`delete from platform.auth_otps`;
    const barista = await otpLogin(fx.api, fx.mailer, "barista@coffee.example");
    const accepted = await barista.req(
      "POST",
      `/invites/${fx.mailer.inviteToken("barista@coffee.example")}/accept`,
    );
    expect(accepted.status, accepted.text).toBe(200);
  });

  test("a revoked or re-sent invitation: only the latest one is active", async () => {
    await fx.cli("invite", "late@example.ru");
    expect(await fx.cli("revoke", "late@example.ru")).toBe("приглашение отозвано");
    await requestOtp(fx.api, "late@example.ru");
    expect((await verify(fx.api, "late@example.ru", fx.mailer.code("late@example.ru"))).status).toBe(403);
    await fx.cli("invite", "late@example.ru", "--credits", "5");
    await fx.cli("invite", "late@example.ru", "--credits", "7");
    const rows = await fx.api.deps.pg`
      select credits from platform.pilot_invites where email = 'late@example.ru' and revoked_at is null`;
    expect(rows.map((r) => r.credits)).toEqual([7]);
    const s = asSession(
      fx.api,
      await verifyAfterRequest(fx.api, fx.mailer, "late@example.ru"),
      "late@example.ru",
    );
    const orgId = (await s.req("GET", "/me")).body.memberships[0].orgId as string;
    expect((await s.req("GET", `/orgs/${orgId}/credits`)).body.available).toBe(7);
  });

  test("CLI arguments: bad e-mail, unknown command, missing option value", async () => {
    await expect(fx.cli("invite", "not-an-email")).rejects.toThrow(PilotError);
    await expect(fx.cli("nope")).rejects.toThrow(/команды:/);
    expect(() => parseArgs(["invite", "a@b.ru", "--org-name"])).toThrow(/нужно значение/);
    expect(parseArgs(["x", "--a=1", "--b", "2"])).toEqual({ pos: ["x"], opts: { a: "1", b: "2" } });
  });
});

async function verifyAfterRequest(api: TestApi, mailer: MemoryMailer, email: string) {
  await api.deps.pg`delete from platform.auth_otps`;
  expect((await requestOtp(api, email)).status).toBe(204);
  const res = await verify(api, email, mailer.code(email));
  expect(res.status, res.text).toBe(200);
  return res;
}

describe("WIZARD_REGISTRATION=open (default) keeps the M1 behaviour", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("pilotopen", { authMode: "session" });
  });
  afterAll(async () => {
    await fx?.drop();
  });

  test("any new e-mail signs up with a Free org; a founder invitation still makes it a pilot org", async () => {
    const free = await otpLogin(fx.api, fx.mailer, "free@example.ru");
    const freeOrg = (await free.req("GET", "/me")).body.memberships[0].orgId as string;
    expect((await free.req("GET", `/orgs/${freeOrg}`)).body.plan).toBe("free");
    await fx.api.deps.pg`delete from platform.auth_otps`;
    await fx.cli("invite", "pilot@example.ru");
    const pilot = await otpLogin(fx.api, fx.mailer, "pilot@example.ru");
    const pilotOrg = (await pilot.req("GET", "/me")).body.memberships[0].orgId as string;
    expect((await pilot.req("GET", `/orgs/${pilotOrg}`)).body).toMatchObject({
      plan: "pilot",
      name: "Моя организация",
      paymentsEnabled: true,
    });
    // No Free welcome grant on pilot: credits come only from the founder.
    expect((await pilot.req("GET", `/orgs/${pilotOrg}/credits`)).body.available).toBe(0);
  });
});

describe("plan pilot: CLI only, limits and login methods of billing.yaml#plans.pilot, prod without a card", () => {
  let fx: Fx;
  let orgId: string;
  beforeAll(async () => {
    fx = await fixture("pilotplan", { cardBindingRequired: true }, true);
    const r = await fx.api.req("POST", "/orgs", { body: { name: "Пилотная org", regionCode: "77" } });
    expect(r.status, r.text).toBe(201);
    orgId = r.body.id;
  }, 60_000);
  afterAll(async () => {
    await fx?.drop();
  });

  test("plan table: pilot = 0 ₽, 5 prod / 30 drafts / 30 members, no monthly grant, no phone_otp", () => {
    expect(PLANS.pilot).toEqual({
      priceRubMonth: 0,
      monthlyMilli: 0,
      limits: { prod_systems: 5, draft_systems: 30, members: 30 },
    });
    expect(MEMBER_LIMITS.pilot).toBe(30);
    expect(phoneOtpAllowed("pilot")).toBe(false);
    expect(phoneOtpAllowed("free")).toBe(false);
    expect(phoneOtpAllowed("start")).toBe(true);
    // The orchestrator offers pilot orgs the Free login methods.
    expect(agentPlan("pilot")).toBe("free");
    expect(agentPlan("business")).toBe("business");
    const spec = {
      entities: [],
      roles: [{ name: "client", loginMethods: ["email_otp", "phone_otp"] }],
    } as unknown as AppSpec;
    expect(specPublishBlockers(spec, "pilot")).toEqual(["PHONE_LOGIN_PLAN_REQUIRED"]);
    expect(specPublishBlockers(spec, "start")).toEqual([]);
  });

  test("the owner cannot choose pilot through the API; the CLI assigns it and can return to free", async () => {
    const put = await fx.api.req("PUT", `/orgs/${orgId}/billing/subscription`, { body: { plan: "pilot" } });
    expect(put.status).toBe(400);
    expect(await fx.cli("plan", orgId, "pilot")).toBe("«Пилотная org»: тариф free → pilot");
    await expect(fx.cli("plan", orgId, "business")).rejects.toThrow(/pilot\|free/);
    await expect(fx.cli("plan", "00000000-0000-0000-0000-00000000ffff", "pilot")).rejects.toThrow(
      /не найдена/,
    );
    const billing = await fx.api.req("GET", `/orgs/${orgId}/billing`);
    expect(billing.status).toBe(200);
    expect(billing.body).toMatchObject({
      plan: "pilot",
      limits: { prodSystems: 5, members: 30, monthlyCredits: 0 },
      paymentsEnabled: true,
    });
    expectContract("getBilling", billing);
  });

  test("CLI grant: ledger grant in bucket topup, reason pilot_grant, 365 days; idempotent by reference", async () => {
    const out = await fx.cli("grant", orgId, "200", "first-month");
    expect(out).toMatch(/начислено 200 кр\./);
    expect(await fx.cli("grant", orgId, "200", "first-month")).toMatch(/уже начислено ранее/);
    const rows = await fx.api.deps.pg`
      select kind, bucket, amount_milli, idempotency_key, note_ru, bucket_expires_at, created_at
      from platform.credit_ledger where org_id = ${orgId} and kind = 'grant'`;
    expect(rows).toHaveLength(1);
    const g = rows[0] as Record<string, unknown>;
    expect(g).toMatchObject({
      kind: "grant",
      bucket: "topup",
      amount_milli: "200000",
      idempotency_key: "pilot_grant:first-month",
    });
    expect(g.note_ru).toMatch(/Кредиты пилота/);
    const days = (new Date(g.bucket_expires_at as Date).getTime() - fx.clock.t) / DAY;
    expect(days).toBeCloseTo(PILOT_GRANT_DAYS, 1);
    await expect(fx.cli("grant", orgId, "-5")).rejects.toThrow(PilotError);
  });

  test("prod publication of a pilot org needs no card (CARD_BINDING_REQUIRED does not apply)", async () => {
    const created = await fx.api.req("POST", "/systems", { body: { prompt: "Форум ритейла", orgId } });
    expect(created.status, created.text).toBe(201);
    const id: string = created.body.system.id;
    await waitRun(fx.api, created.body.run.id, ["succeeded"]);
    const ans = await fx.api.req("POST", `/systems/${id}/answers`, { body: { restByRecommendation: true } });
    await waitRun(fx.api, ans.body.run.id, ["succeeded"]);
    const s = await fx.api.req("GET", `/systems/${id}`);
    const ap = await fx.api.req("POST", `/systems/${id}/card/approve`, {
      body: { cardVersion: s.body.card.cardVersion },
    });
    expect(ap.status, ap.text).toBe(202);
    await waitRun(fx.api, ap.body.run.id, ["succeeded"], 20_000);
    const put = await fx.api.req("PUT", `/systems/${id}/compliance`, {
      body: {
        expectedVersion: (await fx.api.req("GET", `/systems/${id}`)).body.system.draftRevision,
        operatorName: "ООО «Пилот»",
        operatorContact: "privacy@pilot.example",
        operatorAddress: "г. Москва, ул. Тверская, д. 1",
      },
    });
    expect(put.status, put.text).toBe(200);
    const get = await fx.api.req("GET", `/systems/${id}`);
    expect(get.body.publishBlockers).toEqual([]);
    expect(get.body.org ?? {}).not.toHaveProperty("cardBound", true);
    const ok = await fx.api.req("POST", `/systems/${id}/publish`, {
      body: { revision: get.body.system.draftRevision, confirmDiff: true },
    });
    expect(ok.status, ok.text).toBe(202);
    const run = await waitRun(fx.api, ok.body.run.id, ["succeeded", "failed"], 30_000);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");

    // The same org back on free needs the card again.
    await fx.cli("plan", orgId, "free");
    expect((await fx.api.req("GET", `/systems/${id}`)).body.publishBlockers).toContain(
      "CARD_BINDING_REQUIRED",
    );
    await fx.cli("plan", orgId, "pilot");
  }, 90_000);

  test("CLI orgs: plan, members, balance and the spend of the month", async () => {
    const out = await fx.cli("orgs");
    const line = out.split("\n").find((l) => l.startsWith(orgId));
    expect(out.split("\n")[0]).toBe(`месяц ${moscowMonth(new Date(fx.clock.t)).key} (МСК)`);
    const cols = (line ?? "").split("\t");
    expect(cols.slice(1, 4)).toEqual(["Пилотная org", "pilot", "1"]);
    // 200 granted minus what the interview turns and the build charged this month.
    const charged = Number((cols[5] ?? "").replace(",", ".").replace(/\s/g, ""));
    const available = Number((cols[4] ?? "").replace(",", ".").replace(/\s/g, ""));
    expect(charged).toBeGreaterThanOrEqual(0);
    expect(available + charged).toBeCloseTo(200, 0);
  });
});

describe("WIZARD_PAYMENTS=off: no purchase, subscriptions or card binding", () => {
  let fx: Fx;
  let orgId: string;
  beforeAll(async () => {
    fx = await fixture("pilotpay", {
      payments: false,
      // Shop keys present on purpose: the flag alone switches payments off.
      platformShop: { shopId: "1", secretKey: "s" },
      yookassaIpAllowlist: ["127.0.0.1/32"],
    });
    const r = await fx.api.req("POST", "/orgs", { body: { name: "Без оплаты", regionCode: "77" } });
    orgId = r.body.id;
  });
  afterAll(async () => {
    await fx?.drop();
  });

  test("config: on by default, off from the env", () => {
    expect(loadConfig({}).payments).toBe(true);
    expect(loadConfig({ WIZARD_PAYMENTS: "on" }).payments).toBe(true);
    expect(loadConfig({ WIZARD_PAYMENTS: "off" }).payments).toBe(false);
  });

  test("payment operations → 403 PAYMENTS_DISABLED; plan, balance and ledger stay readable", async () => {
    const calls: [string, string, unknown][] = [
      ["POST", "card-binding", {}],
      ["PUT", "subscription", { plan: "start" }],
      ["DELETE", "subscription", undefined],
      ["POST", "topups", { packs: 1 }],
    ];
    const ops = ["startCardBinding", "changeSubscription", "cancelSubscription", "createTopup"];
    for (const [i, [method, path, body]] of calls.entries()) {
      const res = await fx.api.req(method, `/orgs/${orgId}/billing/${path}`, body ? { body } : {});
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body).toEqual({
        code: "PAYMENTS_DISABLED",
        message_ru: "Оплата на пилоте отключена — кредиты начисляет команда Wizard",
      });
      expectContract(ops[i] as string, res);
    }
    const billing = await fx.api.req("GET", `/orgs/${orgId}/billing`);
    expect(billing.status).toBe(200);
    expect(billing.body).toMatchObject({ plan: "free", paymentsEnabled: false, card: null });
    expectContract("getBilling", billing);
    expect((await fx.api.req("GET", `/orgs/${orgId}`)).body.paymentsEnabled).toBe(false);
    expect((await fx.api.req("GET", `/orgs/${orgId}/credits`)).status).toBe(200);
    expect((await fx.api.req("GET", `/orgs/${orgId}/credits/ledger`)).status).toBe(200);
  });

  test("the shop webhook and the renewals sweep are off", async () => {
    const res = await fx.api.app.fetch(
      new Request("http://localhost:4000/api/v1/webhooks/yookassa", {
        method: "POST",
        headers: { host: "localhost:4000", "content-type": "application/json" },
        body: JSON.stringify({ type: "notification", event: "payment.succeeded", object: { id: "x" } }),
      }),
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(res.status).toBe(404);
    expect(fx.api.deps.payments.enabled).toBe(false);
    expect(await fx.api.deps.payments.sweep()).toEqual({ reminded: 0, ended: 0, charged: 0, reconciled: 0 });
  });
});

describe("platform LLM cap of the month (WIZARD_LLM_MONTHLY_CAP_RUB)", () => {
  let fx: Fx;
  let orgId: string;
  let firstSystem: string;
  beforeAll(async () => {
    fx = await fixture("pilotcap", { llmMonthlyCapRub: 100 });
    // 2026-10-15 12:00 MSK.
    fx.clock.t = Date.parse("2026-10-15T09:00:00Z");
    const r = await fx.api.req("POST", "/orgs", { body: { name: "Расходы", regionCode: "77" } });
    orgId = r.body.id;
    // Pilot: 30 drafts (the test creates several systems) and credits from the founder.
    await fx.cli("plan", orgId, "pilot");
    await fx.cli("grant", orgId, "500", "cap-test");
  });
  afterAll(async () => {
    await fx?.drop();
  });

  async function spend(rub: number, at: string, mode = "live", billable = true): Promise<void> {
    await fx.api.deps.pg`
      insert into platform.llm_calls (org_id, call_type, tier, provider, model_id, status, route_reason,
        policy_version, scrubbed, cost_rub, billable, mode, created_at)
      values (${orgId}, 'orchestrate', 'T0', 'cloudru', 'glm-5.1', 'ok', 'default_T0', 'test', false, ${rub},
        ${billable}, ${mode}, ${at})`;
  }
  const newSystem = () => fx.api.req("POST", "/systems", { body: { prompt: "Заявки на закупку", orgId } });

  test("config: 6000 ₽ by default; a non-positive cap is refused at startup", () => {
    expect(loadConfig({}).llmMonthlyCapRub).toBe(6000);
    expect(loadConfig({ WIZARD_LLM_MONTHLY_CAP_RUB: "2500" }).llmMonthlyCapRub).toBe(2500);
    expect(() => assertStartupAllowed(loadConfig({ WIZARD_LLM_MONTHLY_CAP_RUB: "0" }))).toThrow(
      /WIZARD_LLM_MONTHLY_CAP_RUB/,
    );
  });

  test("Moscow calendar month: 2026-09-30 21:30 UTC is already October", () => {
    const m = moscowMonth(new Date("2026-09-30T21:30:00Z"));
    expect(m).toEqual({
      key: "2026-10",
      start: new Date("2026-09-30T21:00:00Z"),
      end: new Date("2026-10-31T21:00:00Z"),
    });
  });

  test("below 80 %: no alert; previous month, fixture and non-billable calls do not count", async () => {
    await spend(500, "2026-09-30T20:59:00Z"); // September in Moscow
    await spend(500, "2026-10-10T10:00:00Z", "fixture");
    await spend(500, "2026-10-10T10:00:00Z", "live", false);
    await spend(30, "2026-09-30T21:30:00Z"); // October in Moscow
    await spend(49.5, "2026-10-14T10:00:00Z", "record");
    const r = await newSystem();
    expect(r.status, r.text).toBe(201);
    firstSystem = r.body.system.id;
    await waitRun(fx.api, r.body.run.id, ["succeeded"]);
    expect(fx.alerts).toEqual([]);
    expect(await fx.cli("spend")).toBe("модели за 2026-10 (МСК): 79,5 ₽ из 100 ₽ (79 %)");
  });

  test("≥ 80 %: the run starts and the founder gets one warning a month", async () => {
    await spend(1, "2026-10-15T08:00:00Z");
    const a = await newSystem();
    expect(a.status, a.text).toBe(201);
    await waitRun(fx.api, a.body.run.id, ["succeeded"]);
    const b = await newSystem();
    expect(b.status).toBe(201);
    await waitRun(fx.api, b.body.run.id, ["succeeded"]);
    expect(fx.alerts).toHaveLength(1);
    expect(fx.alerts[0]).toMatchObject({ level: "warn", event: "llm_monthly_cap_warning" });
    expect(fx.alerts[0]?.text).toMatch(/80 % месячного лимита/);
  });

  test("≥ cap: new interview turns and builds → 503 LLM_BUDGET_EXHAUSTED in Russian, one founder alert", async () => {
    await spend(20, "2026-10-15T08:30:00Z");
    const r = await newSystem();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("LLM_BUDGET_EXHAUSTED");
    expect(r.body.message_ru).toMatch(/^Месячный лимит платформы на работу моделей исчерпан/);
    expectContract("createSystem", r);
    const msg = await fx.api.req("POST", `/systems/${firstSystem}/messages`, {
      body: { text: "Добавь отчёт" },
    });
    expect(msg.status).toBe(503);
    expect(msg.body.code).toBe("LLM_BUDGET_EXHAUSTED");
    expectContract("postMessage", msg);
    expect((await newSystem()).status).toBe(503);
    const errors = fx.alerts.filter((x) => x.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ event: "llm_monthly_cap_reached" });
    expect(errors[0]?.text).toMatch(/месячный лимит расходов на модели исчерпан — 101 ₽ из 100 ₽ за 2026-10/);
    // Reading stays available.
    expect((await fx.api.req("GET", `/orgs/${orgId}/credits`)).status).toBe(200);
  });

  test("a new Moscow month starts from zero", async () => {
    fx.clock.t = Date.parse("2026-10-31T21:05:00Z"); // 1 November 00:05 MSK
    const r = await newSystem();
    expect(r.status, r.text).toBe(201);
    await waitRun(fx.api, r.body.run.id, ["succeeded"]);
  });
});

describe("founder alert channel", () => {
  test("structured log line and the optional webhook {text, chat_id}; webhook failures never throw", async () => {
    const lines: string[] = [];
    const posts: { url: string; body: unknown }[] = [];
    const alert = createOpsAlert({
      logger: {
        warn: (m) => lines.push(`warn ${m}`),
        error: (m) => lines.push(`error ${m}`),
      },
      webhook: { url: "https://api.telegram.example/bot1/sendMessage", chatId: "42" },
      fetch: (async (url: string, init: RequestInit) => {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await alert({ level: "error", event: "llm_monthly_cap_reached", text: "лимит" });
    expect(lines).toEqual(["error llm_monthly_cap_reached"]);
    expect(posts).toEqual([
      { url: "https://api.telegram.example/bot1/sendMessage", body: { text: "лимит", chat_id: "42" } },
    ]);
    const failing = createOpsAlert({
      webhook: { url: "http://127.0.0.1:9/x", chatId: null },
      fetch: (async () => {
        throw new Error("down");
      }) as unknown as typeof fetch,
    });
    await expect(failing({ level: "warn", event: "e", text: "t" })).resolves.toBeUndefined();
    expect(
      loadConfig({ WIZARD_OPS_ALERT_URL: "https://x/y", WIZARD_OPS_ALERT_CHAT_ID: "7" }).opsAlert,
    ).toEqual({
      url: "https://x/y",
      chatId: "7",
    });
    expect(loadConfig({}).opsAlert).toBeNull();
  });
});
