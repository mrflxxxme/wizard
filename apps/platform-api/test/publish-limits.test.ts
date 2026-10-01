// FU-6: publish under the prod_systems plan limit (billing.yaml#plans.enforcement, 402 PLAN_LIMIT), publish and
// rollback without credits (billing.yaml#run_charging.style_and_compliance), PHONE_LOGIN_PLAN_REQUIRED (F4) and the
// own Telegram bot set up by the publish workflow against the Bot API stub (telegram.yaml#bot_api).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppSpec } from "@wizard/appspec";
import { staticSecretReader } from "@wizard/connectors";
import { TelegramMock } from "@wizard/connectors/mocks";
import { testPlatform } from "@wizard/connectors/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import { BLOCKER_RU, specPublishBlockers } from "../src/publish/blockers.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  ROOT,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";

const OWN_TOKEN = "700000021:OWNtokenOWNtokenOWNtokenOWNtokenOWNto";

let tdb: Awaited<ReturnType<typeof createTestDb>>;
let api: TestApi;
let mock: TelegramMock;

beforeAll(async () => {
  tdb = await createTestDb("publimits", { migrator: true });
  mock = await new TelegramMock().start();
  api = await startApi(tdb.url, {
    // The local org stays exempt (dev stand); orgs created by the tests are ordinary Free orgs.
    config: { billingExemptOrgs: [DEFAULT_ORG_ID], runConcurrency: 4 },
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    creditsCronMs: 0,
    publish: {
      smoke: async () => ({ ok: true }),
      lockRetryDelaysMs: [10, 10, 10],
      telegram: {
        mode: "live",
        env: { publicScheme: "http", systemsDomain: "localhost" },
        platform: testPlatform({ telegram: { apiBase: mock.url, botUsername: "wizard_notify_bot" } }),
        secrets: () => staticSecretReader({ telegram_bot_token: OWN_TOKEN }),
      },
    },
  });
}, 60_000);

afterAll(async () => {
  await api?.dispose();
  await tdb?.drop();
  await mock?.stop();
});

async function newOrg(): Promise<string> {
  const r = await api.req("POST", "/orgs", { body: { name: "Тариф Free" } });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

/** createSystem → answers → card → approve → built draft with operator data (forum has PII). */
async function builtSystem(orgId: string, prompt: string): Promise<string> {
  // The local org is the default one (its fixed id is not a v4 UUID the body schema accepts).
  const body = orgId === DEFAULT_ORG_ID ? { prompt } : { prompt, orgId };
  const created = await api.req("POST", "/systems", { body });
  expect(created.status, created.text).toBe(201);
  const id: string = created.body.system.id;
  await waitRun(api, created.body.run.id, ["succeeded"]);
  const ans = await api.req("POST", `/systems/${id}/answers`, { body: { restByRecommendation: true } });
  await waitRun(api, ans.body.run.id, ["succeeded"]);
  const s = await api.req("GET", `/systems/${id}`);
  const ap = await api.req("POST", `/systems/${id}/card/approve`, {
    body: { cardVersion: s.body.card.cardVersion },
  });
  expect(ap.status, ap.text).toBe(202);
  await waitRun(api, ap.body.run.id, ["succeeded"], 20_000);
  const cur = await sys(id);
  const put = await api.req("PUT", `/systems/${id}/compliance`, {
    body: {
      expectedVersion: cur.draft_revision,
      operatorName: "ООО «Северный ритейл»",
      operatorContact: "privacy@north-retail.example",
    },
  });
  expect(put.status, put.text).toBe(200);
  return id;
}

const sys = (id: string) =>
  api.deps.db.selectFrom("platform.systems").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

const publishReq = async (id: string) =>
  api.req("POST", `/systems/${id}/publish`, {
    body: { revision: (await sys(id)).draft_revision, confirmDiff: true },
  });

async function ledgerRows(runIds: string[]): Promise<number> {
  const r = await api.deps.db
    .selectFrom("platform.credit_ledger")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("run_id", "in", runIds)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

async function blockers(id: string): Promise<string[]> {
  const r = await api.req("GET", `/systems/${id}`);
  expect(r.status).toBe(200);
  return r.body.publishBlockers as string[];
}

describe("prod_systems plan limit (Free: 1)", () => {
  let org = "";
  let a = "";
  let b = "";
  let prodId = "";
  let otherId = "";

  beforeAll(async () => {
    org = await newOrg();
    a = await builtSystem(org, "Форум северного ритейла");
    b = await builtSystem(org, "Форум южного ритейла");
  }, 120_000);

  test("parallel publishes of two systems: only one passes, the other → 402 PLAN_LIMIT", async () => {
    mock.calls.length = 0;
    const [ra, rb] = await Promise.all([publishReq(a), publishReq(b)]);
    const ok = [ra, rb].filter((r) => r.status === 202);
    const limited = [ra, rb].filter((r) => r.status !== 202);
    expect(ok).toHaveLength(1);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.status).toBe(402);
    expect(limited[0]?.body).toMatchObject({
      code: "PLAN_LIMIT",
      details: { limit: 1, current: 1, plan: "free" },
    });
    prodId = ra.status === 202 ? a : b;
    otherId = prodId === a ? b : a;
    const run = await waitRun(api, ok[0]?.body.run.id, ["succeeded", "failed"], 30_000);
    expect(run.status, JSON.stringify(run.failure)).toBe("succeeded");
    expect((await sys(prodId)).prod_revision).not.toBeNull();
    expect((await sys(otherId)).prod_revision).toBeNull();
    // The own bot (forum: botUsername) is checked and its webhook set at publication.
    expect(mock.calls.map((c) => [c.method, c.token])).toEqual([
      ["getMe", OWN_TOKEN],
      ["setWebhook", OWN_TOKEN],
    ]);
    const hook = mock.calls[1]?.body as { url: string };
    expect(hook.url).toMatch(
      new RegExp(
        `^http://${(await sys(prodId)).slug}\\.localhost/_wizard/hooks/telegram/telegram/[A-Za-z0-9_-]{32}$`,
      ),
    );
  }, 60_000);

  test("Free org with one system in prod: publishing a second → 402 {limit:1,current:1,plan:'free'}; blocker PLAN_LIMIT", async () => {
    const r = await publishReq(otherId);
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: "PLAN_LIMIT", details: { limit: 1, current: 1, plan: "free" } });
    expect(await blockers(otherId)).toContain("PLAN_LIMIT");
    expect(await blockers(prodId)).not.toContain("PLAN_LIMIT");
  });

  test("republishing and rolling back the prod system are allowed and cost no credits, even at 0 available", async () => {
    const { available } = await api.deps.billing.readBalance(api.deps.db, org);
    await api.deps.db
      .transaction()
      .execute((trx) =>
        api.deps.billing.adjust(trx, org, { amountMilli: -available, key: "fu6:zero", note: "тест" }),
      );
    expect((await api.deps.billing.readBalance(api.deps.db, org)).available).toBe(0);
    const rev = (await sys(prodId)).prod_revision as number;
    const again = await publishReq(prodId);
    expect(again.status, again.text).toBe(202);
    expect((await waitRun(api, again.body.run.id, ["succeeded", "failed"], 30_000)).status).toBe("succeeded");
    const rb = await api.req("POST", `/systems/${prodId}/rollback`, {
      body: { env: "prod", toRevision: rev },
    });
    expect(rb.status, rb.text).toBe(202);
    expect((await waitRun(api, rb.body.run.id, ["succeeded", "failed"], 30_000)).status).toBe("succeeded");
    expect(await ledgerRows([again.body.run.id, rb.body.run.id])).toBe(0);
    expect((await api.deps.billing.readBalance(api.deps.db, org)).available).toBe(0);
  }, 60_000);
});

describe("exempt dev org", () => {
  test("no prod_systems limit: two systems publish; an invalid bot token fails before prod is touched", async () => {
    const one = await builtSystem(DEFAULT_ORG_ID, "Локальный форум один");
    const two = await builtSystem(DEFAULT_ORG_ID, "Локальный форум два");
    const r1 = await publishReq(one);
    expect(r1.status, r1.text).toBe(202);
    expect((await waitRun(api, r1.body.run.id, ["succeeded", "failed"], 30_000)).status).toBe("succeeded");
    expect(await blockers(two)).not.toContain("PLAN_LIMIT");

    mock.queue.push({ status: 401, body: { ok: false, error_code: 401, description: "Unauthorized" } });
    const bad = await publishReq(two);
    expect(bad.status).toBe(202);
    const failed = await waitRun(api, bad.body.run.id, ["succeeded", "failed"], 30_000);
    expect(failed).toMatchObject({ status: "failed", failure: { code: "GATES_FAILED" } });
    expect(failed.failure.message_ru).toContain("Telegram");
    expect((await sys(two)).prod_revision).toBeNull();

    const r2 = await publishReq(two);
    expect(r2.status, r2.text).toBe(202);
    expect((await waitRun(api, r2.body.run.id, ["succeeded", "failed"], 30_000)).status).toBe("succeeded");
    expect((await sys(two)).prod_revision).not.toBeNull();
  }, 180_000);
});

describe("PHONE_LOGIN_PLAN_REQUIRED (F4)", () => {
  const forum = (): AppSpec =>
    JSON.parse(readFileSync(join(ROOT, "specs/appspec/examples/forum.json"), "utf8")) as AppSpec;

  test("phone_otp in any role's loginMethods blocks Free; Start/Business are not blocked; Russian text", () => {
    const spec = forum();
    expect(specPublishBlockers(spec, "free")).not.toContain("PHONE_LOGIN_PLAN_REQUIRED");
    const role = spec.roles.find((r) => r.name === "participant");
    if (!role) throw new Error("no participant role");
    role.loginMethods = [...(role.loginMethods ?? []), "phone_otp"];
    expect(specPublishBlockers(spec, "free")).toContain("PHONE_LOGIN_PLAN_REQUIRED");
    expect(specPublishBlockers(spec, "start")).not.toContain("PHONE_LOGIN_PLAN_REQUIRED");
    expect(specPublishBlockers(spec, "business")).not.toContain("PHONE_LOGIN_PLAN_REQUIRED");
    expect(BLOCKER_RU.PHONE_LOGIN_PLAN_REQUIRED).toBe("Вход по телефону доступен на тарифах Старт и Бизнес");
    expect(BLOCKER_RU.PLAN_LIMIT).toBe("Лимит опубликованных систем тарифа");
  });
});
