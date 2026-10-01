// Acceptance M2-07 (billing.yaml#card_binding, #recurring; api.yaml /orgs/{orgId}/billing/*, /webhooks/yookassa)
// against the YooKassa API stub of @wizard/connectors/mocks: prod needs a bound RU card (403 CARD_BINDING_REQUIRED),
// non-RU / no 3-DS / 4th org of a card are rejected, ≤ 3 binding attempts per org a day and ≤ 10 per IP (429),
// subscription first payment, renewals with Idempotence-Key renew:<org>:<period>, retries day 0/+1/+3 → past_due →
// Free, cancel at the period end, topups, idempotent webhooks re-checked via GET, 54-FZ receipts.
import { idempotenceKey, YOOKASSA_IP_ALLOWLIST } from "@wizard/connectors";
import { YookassaMock } from "@wizard/connectors/mocks";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { MailMessage } from "../src/auth/mailer.js";
import { addMonth, ipLimitKey } from "../src/billing/payments.js";
import type { Config } from "../src/config.js";
import { DEFAULT_ORG_ID } from "../src/db/index.js";
import {
  createTestDb,
  fakeExecutors,
  fakeRouterFactory,
  type Res,
  startApi,
  type TestApi,
  waitRun,
} from "./helpers.js";
import { expectContract, MemoryMailer } from "./session.js";

const YK_IP = "185.71.76.5";
const DAY = 24 * 3600_000;

let mock: YookassaMock;
beforeAll(async () => {
  mock = await new YookassaMock().start();
});
afterAll(async () => {
  await mock?.stop();
});
afterEach(() => {
  mock.card = {
    first6: "555555",
    last4: "4444",
    expiry_month: "12",
    expiry_year: "2030",
    card_type: "MasterCard",
    issuer_country: "RU",
  };
  mock.threeDs = true;
  mock.autopayStatus = "succeeded";
  mock.queue.length = 0;
});

interface Fx {
  api: TestApi;
  mailer: MemoryMailer;
  clock: { t: number };
  drop(): Promise<void>;
}

async function fixture(tag: string, over: Partial<Config> = {}, migrator = false): Promise<Fx> {
  const tdb = await createTestDb(tag, { migrator });
  const clock = { t: Date.now() };
  const mailer = new MemoryMailer();
  const api = await startApi(tdb.url, {
    config: {
      billingExemptOrgs: [DEFAULT_ORG_ID],
      runConcurrency: 4,
      platformShop: { shopId: mock.shopId, secretKey: mock.secretKey },
      yookassaApiBase: mock.apiBase,
      cardBindingRequired: true,
      receipt: { vatCode: 1 },
      ...over,
    },
    mailer,
    now: () => new Date(clock.t),
    creditsCronMs: 0,
    executors: fakeExecutors({ spec: "forum" }),
    createRouter: fakeRouterFactory(),
    publish: { smoke: async () => ({ ok: true }), lockRetryDelaysMs: [10, 10, 10] },
  });
  return {
    api,
    mailer,
    clock,
    async drop() {
      await api.dispose();
      await tdb.drop();
    },
  };
}

/** Request with a socket peer address (node-server env), as the webhook and the per-IP limit see it. */
async function reqFrom(
  api: TestApi,
  ip: string,
  method: string,
  path: string,
  body?: unknown,
  user?: string,
): Promise<Res> {
  const headers: Record<string, string> = { host: "localhost:4000" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (user) headers["x-wizard-dev-user"] = user;
  const res = await api.app.fetch(
    new Request(`http://localhost:4000/api/v1${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { incoming: { socket: { remoteAddress: ip } } },
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, text };
}

const hook = (api: TestApi, event: string, id: string, ip = YK_IP, object?: Record<string, unknown>) =>
  reqFrom(api, ip, "POST", "/webhooks/yookassa", mock.notification(event, id, object));

async function newOrg(api: TestApi, name = "Кофейня"): Promise<string> {
  const r = await api.req("POST", "/orgs", { body: { name, regionCode: "77" } });
  expect(r.status, r.text).toBe(201);
  return r.body.id as string;
}

const lastPaymentId = () => [...mock.payments.keys()].at(-1) as string;
let cardSeq = 0;

/** Card binding through the YooKassa page: start, pay (3-DS), notification. Returns the binding response. */
async function bindCard(api: TestApi, orgId: string, ip = "198.51.100.7"): Promise<Res> {
  const r = await reqFrom(api, ip, "POST", `/orgs/${orgId}/billing/card-binding`, {});
  if (r.status !== 200) return r;
  const id = lastPaymentId();
  mock.pay(id);
  const h = await hook(api, "payment.waiting_for_capture", id);
  expect(h.status).toBe(200);
  return r;
}

const billing = async (api: TestApi, orgId: string) => {
  const r = await api.req("GET", `/orgs/${orgId}/billing`);
  expect(r.status, r.text).toBe(200);
  expectContract("getBilling", r);
  return r.body;
};

const ledger = (api: TestApi, orgId: string) =>
  api.deps.db
    .selectFrom("platform.credit_ledger")
    .selectAll()
    .where("org_id", "=", orgId)
    .orderBy("id")
    .execute();

describe("card binding (identification before prod, L3-28)", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("billcard");
  });
  afterAll(async () => {
    await fx?.drop();
  });

  test("RU card: 1 ₽ two-stage payment with 3-DS redirect → payment_methods, payment cancelled, no card data", async () => {
    const { api } = fx;
    const org = await newOrg(api);
    const r = await reqFrom(api, "198.51.100.7", "POST", `/orgs/${org}/billing/card-binding`, {});
    expect(r.status, r.text).toBe(200);
    expectContract("startCardBinding", r);
    const id = lastPaymentId();
    expect(r.body.confirmationUrl).toBe(mock.payments.get(id)?.confirmation?.confirmation_url);
    const create = mock.callsTo("POST", "/v3/payments").at(-1);
    expect(create?.body).toMatchObject({
      amount: { value: "1.00", currency: "RUB" },
      capture: false,
      save_payment_method: true,
      confirmation: {
        type: "redirect",
        return_url: expect.stringMatching(/^http:\/\/localhost:5173\/billing\?payment=/),
      },
      metadata: { orgId: org, kind: "card_binding" },
      receipt: { customer: { email: "dev@wizard.local" } },
    });
    expect((await billing(api, org)).cardBinding).toMatchObject({ status: "pending" });

    mock.pay(id);
    expect((await hook(api, "payment.waiting_for_capture", id)).status).toBe(200);
    expect(mock.payments.get(id)?.status).toBe("canceled");
    const b = await billing(api, org);
    expect(b.card).toMatchObject({ last4: "4444", issuerCountry: "RU" });
    expect(b.cardBinding).toMatchObject({ status: "bound", code: null });
    expect((await api.req("GET", `/orgs/${org}`)).body.cardBound).toBe(true);
    const [pay] = await api.deps
      .pg`select status, settled_at from platform.payments where provider_payment_id = ${id}`;
    expect(pay).toMatchObject({ status: "canceled" });
    // Only last4 and an HMAC fingerprint are kept (no first6, expiry or PAN anywhere).
    const dump = JSON.stringify(
      await api.deps
        .pg`select (select json_agg(m) from platform.payment_methods m) as m, (select json_agg(p) from platform.payments p) as p`,
    );
    // Random ids, hashes and timestamps may contain these digits by chance: drop them before searching.
    const plain = dump
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?/g, "")
      .replace(/[A-Za-z0-9_+/=-]{16,}/g, "");
    expect(plain).not.toContain("555555");
    expect(plain).not.toContain("2030");
    expect(dump).not.toMatch(/"(first6|expiry_month|expiry_year|card_number|pan)"/);

    // A repeated notification changes nothing (one card, one cancel).
    const cancels = mock.callsTo("POST", `/v3/payments/${id}/cancel`).length;
    expect((await hook(api, "payment.waiting_for_capture", id)).status).toBe(200);
    expect(mock.callsTo("POST", `/v3/payments/${id}/cancel`).length).toBe(cancels);
    const [n] = await api.deps
      .pg`select count(*)::int as n from platform.payment_methods where org_id = ${org}`;
    expect(n?.n).toBe(1);
  });

  test("card of a foreign bank → CARD_NOT_RU, payment cancelled, no payment method", async () => {
    const { api } = fx;
    const org = await newOrg(api);
    mock.card = { ...mock.card, issuer_country: "DE", first6: "411111", last4: "1111" };
    await bindCard(api, org);
    expect(mock.payments.get(lastPaymentId())?.status).toBe("canceled");
    const b = await billing(api, org);
    expect(b.card).toBeNull();
    expect(b.cardBinding).toEqual({
      status: "rejected",
      code: "CARD_NOT_RU",
      message_ru: "Нужна карта российского банка",
    });
  });

  test("without 3-D Secure the binding is not accepted", async () => {
    const { api } = fx;
    const org = await newOrg(api);
    mock.threeDs = false;
    await bindCard(api, org);
    const b = await billing(api, org);
    expect(b.card).toBeNull();
    expect(b.cardBinding).toMatchObject({ status: "rejected", code: "CARD_BINDING_REJECTED" });
  });

  test("one card in ≤ 3 orgs: the 4th → CARD_BINDING_REJECTED without the reason", async () => {
    const { api } = fx;
    mock.card = { ...mock.card, first6: "220220", last4: "0042", expiry_year: "2031" };
    const orgs = [await newOrg(api), await newOrg(api), await newOrg(api), await newOrg(api)];
    for (const [i, org] of orgs.entries()) await bindCard(api, org, `203.0.113.${i + 1}`);
    for (const org of orgs.slice(0, 3)) expect((await billing(api, org)).card?.last4).toBe("0042");
    const fourth = await billing(api, orgs[3] as string);
    expect(fourth.card).toBeNull();
    expect(fourth.cardBinding).toMatchObject({ code: "CARD_BINDING_REJECTED" });
    expect(fourth.cardBinding.message_ru).not.toMatch(/организац|3/);
  });

  test("≤ 3 binding attempts per org a day: the 4th → 429; a day later it is allowed again", async () => {
    const { api, clock } = fx;
    const org = await newOrg(api);
    for (let i = 0; i < 3; i++) {
      const r = await reqFrom(api, `192.0.2.${i + 1}`, "POST", `/orgs/${org}/billing/card-binding`, {});
      expect(r.status, r.text).toBe(200);
    }
    const fourth = await reqFrom(api, "192.0.2.9", "POST", `/orgs/${org}/billing/card-binding`, {});
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe("RATE_LIMITED");
    expectContract("startCardBinding", fourth);
    clock.t += DAY + 60_000;
    expect((await reqFrom(api, "192.0.2.9", "POST", `/orgs/${org}/billing/card-binding`, {})).status).toBe(
      200,
    );
  });

  test("≤ 10 attempts per client IP a day (IPv6 by /64)", async () => {
    const { api } = fx;
    const ip = "2001:db8:1:2::10";
    let ok = 0;
    for (let i = 0; i < 4; i++) {
      const org = await newOrg(api);
      for (let k = 0; k < 3; k++) {
        // Other addresses of the same /64 share the limit.
        const r = await reqFrom(
          api,
          `2001:db8:1:2::${i}${k}`,
          "POST",
          `/orgs/${org}/billing/card-binding`,
          {},
        );
        if (r.status === 200) ok++;
        else expect(r.status).toBe(429);
      }
    }
    expect(ok).toBe(10);
    expect(ipLimitKey(ip)).toBe("2001:db8:1:2::/64");
    expect(ipLimitKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
});

describe("prod publication requires a bound RU card", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("billpub", {}, true);
  }, 60_000);
  afterAll(async () => {
    await fx?.drop();
  });

  async function builtSystem(api: TestApi, orgId: string): Promise<string> {
    const created = await api.req("POST", "/systems", { body: { prompt: "Форум ритейла", orgId } });
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
    const put = await api.req("PUT", `/systems/${id}/compliance`, {
      body: {
        expectedVersion: (await api.req("GET", `/systems/${id}`)).body.system.draftRevision,
        operatorName: "ООО «Северный ритейл»",
        operatorContact: "privacy@north-retail.example",
        operatorAddress: "г. Москва, ул. Тверская, д. 1",
      },
    });
    expect(put.status, put.text).toBe(200);
    return id;
  }

  test("no payment_methods → blocker and 403 CARD_BINDING_REQUIRED; after binding — 202", async () => {
    const { api } = fx;
    const org = await newOrg(api, "Ритейл");
    const id = await builtSystem(api, org);
    const get = await api.req("GET", `/systems/${id}`);
    expect(get.body.publishBlockers).toContain("CARD_BINDING_REQUIRED");
    const revision = get.body.system.draftRevision as number;
    const denied = await api.req("POST", `/systems/${id}/publish`, { body: { revision, confirmDiff: true } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("CARD_BINDING_REQUIRED");
    expectContract("publish", denied);

    // A non-RU card does not unlock prod.
    mock.card = { ...mock.card, issuer_country: "KZ", first6: "440043", last4: "7777" };
    await bindCard(api, org);
    expect(
      (await api.req("POST", `/systems/${id}/publish`, { body: { revision, confirmDiff: true } })).status,
    ).toBe(403);
    mock.card = { ...mock.card, issuer_country: "RU", first6: "220070", last4: "1234" };
    await bindCard(api, org);
    expect((await api.req("GET", `/systems/${id}`)).body.publishBlockers).not.toContain(
      "CARD_BINDING_REQUIRED",
    );
    const ok = await api.req("POST", `/systems/${id}/publish`, { body: { revision, confirmDiff: true } });
    expect(ok.status, ok.text).toBe(202);
    await waitRun(api, ok.body.run.id, ["succeeded", "failed"], 30_000);

    // A revoked card blocks again.
    await api.deps.pg`update platform.payment_methods set revoked_at = now() where org_id = ${org}`;
    expect((await api.req("GET", `/systems/${id}`)).body.publishBlockers).toContain("CARD_BINDING_REQUIRED");
  }, 90_000);
});

describe("subscriptions: first payment, renewals, dunning, cancel, plan change", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("billsub");
  });
  afterAll(async () => {
    await fx?.drop();
  });

  /** PUT subscription without a card → YooKassa page → payment.succeeded. */
  async function subscribe(api: TestApi, org: string, plan: "start" | "business") {
    // A distinct card per org (one card binds to ≤ 3 orgs).
    const n = String(++cardSeq).padStart(4, "0");
    mock.card = { ...mock.card, first6: "220200", last4: n };
    const r = await api.req("PUT", `/orgs/${org}/billing/subscription`, { body: { plan } });
    expect(r.status, r.text).toBe(200);
    expectContract("changeSubscription", r);
    const id = lastPaymentId();
    mock.succeed(id);
    expect((await hook(api, "payment.succeeded", id)).status).toBe(200);
    return { res: r, paymentId: id };
  }

  const subRow = async (api: TestApi, org: string) =>
    (await api.deps.pg`select * from platform.subscriptions where org_id = ${org}`)[0];

  test("first payment (save card) → active, plan, 50 credits once; receipt 54-FZ", async () => {
    const { api, clock } = fx;
    const org = await newOrg(api);
    const r = await api.req("PUT", `/orgs/${org}/billing/subscription`, { body: { plan: "start" } });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ plan: "free", status: "none" });
    expect(r.body.confirmationUrl).toMatch(/\/checkout\/payments\//);
    const id = lastPaymentId();
    const create = mock.callsTo("POST", "/v3/payments").at(-1);
    expect(create?.body).toMatchObject({
      amount: { value: "1990.00", currency: "RUB" },
      capture: true,
      save_payment_method: true,
      receipt: {
        customer: { email: "dev@wizard.local" },
        items: [
          {
            description: "Подписка Wizard «Старт», 1 месяц",
            quantity: "1",
            amount: { value: "1990.00", currency: "RUB" },
            vat_code: 1,
            payment_mode: "full_payment",
          },
        ],
      },
    });
    // A forged notification «succeeded» while the API says pending is not trusted.
    expect((await hook(api, "payment.succeeded", id, YK_IP, { status: "succeeded" })).status).toBe(200);
    expect((await billing(api, org)).status).toBe("none");

    mock.succeed(id);
    for (let i = 0; i < 2; i++) expect((await hook(api, "payment.succeeded", id)).status).toBe(200);
    const b = await billing(api, org);
    expect(b).toMatchObject({ plan: "start", status: "active", cancelAtPeriodEnd: false });
    expect(b.periodEnd).toBe(addMonth(new Date(clock.t)).toISOString());
    expect(b.limits).toEqual({ prodSystems: 2, members: 10, monthlyCredits: 50 });
    expect(b.card).toMatchObject({ last4: "4444" });
    const grants = (await ledger(api, org)).filter((x) => x.bucket === "plan_monthly");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ kind: "grant", amount_milli: "50000" });
    const [pay] = await api.deps.pg`select id from platform.payments where provider_payment_id = ${id}`;
    expect(grants[0]?.payment_id).toBe(pay?.id);
  });

  test("renewal: notice 24 h before, autopayment by payment_method_id with renew:<org>:<period>", async () => {
    const { api, clock, mailer } = fx;
    const org = await newOrg(api);
    await subscribe(api, org, "start");
    const end = new Date((await subRow(api, org))?.current_period_end).getTime();
    clock.t = end - DAY + 30 * 60_000;
    await api.deps.payments.sweep();
    const notice = mailer.sent.filter((m: MailMessage) => m.kind === "billing").at(-1);
    expect(notice?.subject).toBe("Wizard: завтра продление подписки");
    expect(notice?.text).toContain("1990 ₽");

    clock.t = end + 60_000;
    const before = mock.callsTo("POST", "/v3/payments").length;
    await api.deps.payments.sweep();
    const calls = mock
      .callsTo("POST", "/v3/payments")
      .slice(before)
      .filter((c) => (c.body?.metadata as { orgId?: string } | undefined)?.orgId === org);
    expect(calls).toHaveLength(1);
    const pmId = (
      await api.deps.pg`select provider_method_id from platform.payment_methods where org_id = ${org}`
    )[0]?.provider_method_id;
    expect(calls[0]?.body).toMatchObject({ payment_method_id: pmId, amount: { value: "1990.00" } });
    expect(calls[0]?.body).not.toHaveProperty("confirmation");
    expect(calls[0]?.idempotenceKey).toBe(idempotenceKey(`renew:${org}:${new Date(end).toISOString()}`));
    const sub = await subRow(api, org);
    expect(new Date(sub?.current_period_start).getTime()).toBe(end);
    expect(new Date(sub?.current_period_end).toISOString()).toBe(addMonth(new Date(end)).toISOString());
    expect(
      (await ledger(api, org)).filter((x) => x.kind === "grant" && x.bucket === "plan_monthly"),
    ).toHaveLength(2);
    // The next sweep in the same hour charges nothing.
    const after = mock.callsTo("POST", "/v3/payments").length;
    await api.deps.payments.sweep();
    expect(mock.callsTo("POST", "/v3/payments").length).toBe(after);
    clock.t = Date.now();
  });

  test("dunning: 3 attempts (day 0, +1, +3) → past_due → Free 7 days later", async () => {
    const { api, clock } = fx;
    clock.t = Date.now();
    const org = await newOrg(api);
    await subscribe(api, org, "business");
    expect((await billing(api, org)).plan).toBe("business");
    const end = new Date((await subRow(api, org))?.current_period_end).getTime();
    const period = new Date(end).toISOString();
    mock.autopayStatus = "canceled";
    const keys: string[] = [];
    for (const [offset, expected] of [
      [0, { failed_attempts: 1, status: "active" }],
      [1, { failed_attempts: 2, status: "active" }],
      [3, { failed_attempts: 3, status: "past_due" }],
    ] as const) {
      clock.t = end + offset * DAY + 60_000;
      const before = mock.callsTo("POST", "/v3/payments").length;
      await api.deps.payments.renew(org);
      const call = mock.callsTo("POST", "/v3/payments").slice(before);
      expect(call).toHaveLength(1);
      keys.push(call[0]?.idempotenceKey as string);
      expect(await subRow(api, org)).toMatchObject(expected);
      expect((await billing(api, org)).plan).toBe("business");
    }
    expect(keys).toEqual([
      idempotenceKey(`renew:${org}:${period}`),
      idempotenceKey(`renew:${org}:${period}:2`),
      idempotenceKey(`renew:${org}:${period}:3`),
    ]);
    expect((await billing(api, org)).status).toBe("past_due");
    clock.t = end + 9 * DAY;
    await api.deps.payments.endDue();
    expect((await billing(api, org)).status).toBe("past_due");
    clock.t = end + 10 * DAY + 60_000;
    await api.deps.payments.endDue();
    expect(await billing(api, org)).toMatchObject({ plan: "free", status: "cancelled", periodEnd: null });
    clock.t = Date.now();
  });

  test("DELETE: autopay off at once, plan until the period end, then Free without a charge", async () => {
    const { api, clock } = fx;
    clock.t = Date.now();
    const org = await newOrg(api);
    await subscribe(api, org, "start");
    const del = await api.req("DELETE", `/orgs/${org}/billing/subscription`);
    expect(del.status).toBe(200);
    expectContract("cancelSubscription", del);
    expect(del.body).toMatchObject({ plan: "start", status: "active", cancelAtPeriodEnd: true });
    const end = new Date((await subRow(api, org))?.current_period_end).getTime();
    clock.t = end + 60_000;
    const before = mock.callsTo("POST", "/v3/payments").length;
    await api.deps.payments.sweep();
    expect(mock.callsTo("POST", "/v3/payments").length).toBe(before);
    expect(await billing(api, org)).toMatchObject({ plan: "free", status: "cancelled" });
    clock.t = Date.now();
  });

  test("plan change: upgrade charges the bound card now; downgrade waits for the next period", async () => {
    const { api, clock } = fx;
    clock.t = Date.now();
    const org = await newOrg(api);
    await subscribe(api, org, "start");
    const up = await api.req("PUT", `/orgs/${org}/billing/subscription`, { body: { plan: "business" } });
    expect(up.status, up.text).toBe(200);
    expect(up.body).toMatchObject({ plan: "business", status: "active", confirmationUrl: null });
    expect(mock.callsTo("POST", "/v3/payments").at(-1)?.body).toMatchObject({
      amount: { value: "6990.00" },
      payment_method_id: expect.any(String),
    });
    const down = await api.req("PUT", `/orgs/${org}/billing/subscription`, { body: { plan: "start" } });
    expect(down.body).toMatchObject({ plan: "business", nextPlan: "start" });
    const end = new Date((await subRow(api, org))?.current_period_end).getTime();
    clock.t = end + 60_000;
    await api.deps.payments.renew(org);
    expect(mock.callsTo("POST", "/v3/payments").at(-1)?.body).toMatchObject({ amount: { value: "1990.00" } });
    expect(await billing(api, org)).toMatchObject({ plan: "start", nextPlan: null });
    clock.t = Date.now();
  });
});

describe("topups and webhook security", () => {
  let fx: Fx;
  beforeAll(async () => {
    fx = await fixture("billtop");
  });
  afterAll(async () => {
    await fx?.drop();
  });

  test("PlatformApi.fetch hands the node-server env on: the webhook sees the peer IP (main.ts serves api.fetch)", async () => {
    const { api } = fx;
    const notify = (ip: string) =>
      api.fetch(
        new Request("http://localhost:4000/api/v1/webhooks/yookassa", {
          method: "POST",
          headers: { host: "localhost:4000", "content-type": "application/json" },
          body: JSON.stringify(mock.notification("payment.succeeded", "unknown-payment")),
        }),
        { incoming: { socket: { remoteAddress: ip } } },
      );
    expect((await notify(YK_IP)).status).toBe(200);
    expect((await notify("198.51.100.7")).status).toBe(401);
  });

  test("without a card: YooKassa page; payment.succeeded (twice) → one grant of 60 × packs for 365 days", async () => {
    const { api, clock } = fx;
    const org = await newOrg(api);
    const r = await api.req("POST", `/orgs/${org}/billing/topups`, { body: { packs: 2 } });
    expect(r.status, r.text).toBe(200);
    expectContract("createTopup", r);
    expect(r.body.confirmationUrl).toMatch(/checkout/);
    const id = lastPaymentId();
    expect(mock.payments.get(id)?.amount).toEqual({ value: "1980.00", currency: "RUB" });
    mock.succeed(id);
    await Promise.all([hook(api, "payment.succeeded", id), hook(api, "payment.succeeded", id)]);
    const rows = (await ledger(api, org)).filter((x) => x.bucket === "topup");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "grant", amount_milli: "120000", payment_id: r.body.paymentId });
    expect(rows[0]?.idempotency_key).toBe(`topup:${r.body.paymentId}`);
    expect(new Date(rows[0]?.bucket_expires_at as Date).getTime()).toBe(clock.t + 365 * DAY);
    const credits = await api.req("GET", `/orgs/${org}/credits`);
    expect(credits.body.buckets).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "topup", remaining: 120 })]),
    );
  });

  test("with a bound card: paid by payment_method_id at once (confirmationUrl null)", async () => {
    const { api } = fx;
    const org = await newOrg(api);
    await bindCard(api, org);
    const r = await api.req("POST", `/orgs/${org}/billing/topups`, { body: { packs: 1 } });
    expect(r.status, r.text).toBe(200);
    expect(r.body.confirmationUrl).toBeNull();
    const rows = (await ledger(api, org)).filter((x) => x.bucket === "topup");
    expect(rows.map((x) => x.amount_milli)).toEqual(["60000"]);
  });

  test("webhook: foreign IP → 401 without an API call; unknown payment → 200 ignored; API down → 500", async () => {
    const { api } = fx;
    const org = await newOrg(api);
    await api.req("POST", `/orgs/${org}/billing/topups`, { body: { packs: 1 } });
    const id = lastPaymentId();
    mock.succeed(id);
    const gets = () => mock.callsTo("GET", "/v3/payments").length;
    const g0 = gets();
    const foreign = await hook(api, "payment.succeeded", id, "203.0.113.50");
    expect(foreign.status).toBe(401);
    expect(gets()).toBe(g0);
    expect((await ledger(api, org)).filter((x) => x.bucket === "topup")).toHaveLength(0);

    const unknown = await reqFrom(api, YK_IP, "POST", "/webhooks/yookassa", {
      type: "notification",
      event: "payment.succeeded",
      object: { id: "2f000000-000f-5000-8000-000000000000", status: "succeeded" },
    });
    expect(unknown.status).toBe(200);

    mock.queue.push({ status: 500 }, { status: 500 }, { status: 500 });
    expect((await hook(api, "payment.succeeded", id)).status).toBe(500);
    expect((await hook(api, "payment.succeeded", id)).status).toBe(200);
    expect((await ledger(api, org)).filter((x) => x.bucket === "topup")).toHaveLength(1);
  });

  test("a payment whose notification was lost is settled by the sweep (GET reconcile)", async () => {
    const { api, clock } = fx;
    const org = await newOrg(api);
    await api.req("POST", `/orgs/${org}/billing/topups`, { body: { packs: 3 } });
    mock.succeed(lastPaymentId());
    clock.t = Date.now() + 15 * 60_000;
    await api.deps.payments.sweep();
    expect((await ledger(api, org)).filter((x) => x.bucket === "topup").map((x) => x.amount_milli)).toEqual([
      "180000",
    ]);
    clock.t = Date.now();
  });
});

describe("receipts with two items, disabled shop", () => {
  test("tax_note split: software right + hosting sum to the amount", async () => {
    const fx = await fixture("billrcpt", {
      receipt: { vatCode: 11, split: { softwareShare: 0.7, softwareVatCode: 1 } },
    });
    try {
      const org = await newOrg(fx.api);
      await fx.api.req("POST", `/orgs/${org}/billing/topups`, { body: { packs: 1 } });
      const receipt = mock.receipts.get(lastPaymentId()) as {
        items: { amount: { value: string }; vat_code: number }[];
      };
      expect(receipt.items.map((i) => [i.amount.value, i.vat_code])).toEqual([
        ["693.00", 1],
        ["297.00", 11],
      ]);
    } finally {
      await fx.drop();
    }
  });

  test("without platform shop keys: billing ops → 500 in Russian, webhook → 404; GET billing works", async () => {
    const fx = await fixture("billoff", { platformShop: null });
    try {
      const org = await newOrg(fx.api);
      const r = await fx.api.req("POST", `/orgs/${org}/billing/card-binding`, { body: {} });
      expect(r.status).toBe(500);
      expect(r.body.message_ru).toMatch(/Оплата/);
      expect((await hook(fx.api, "payment.succeeded", "x")).status).toBe(404);
      expect(await billing(fx.api, org)).toMatchObject({ plan: "free", status: "none", card: null });
    } finally {
      await fx.drop();
    }
  });
});

test("YooKassa allowlist default comes from connectors (yookassa.yaml)", () => {
  expect(YOOKASSA_IP_ALLOWLIST).toContain("185.71.76.0/27");
});
