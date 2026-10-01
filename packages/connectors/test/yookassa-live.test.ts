// M2-02: YooKassa against the local API stub — /api/pay core, verified webhooks, refunds, 54-FZ receipts.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type ConnectorCtx,
  confirmMockPayment,
  effectiveClientIp,
  handleYookassaNotification,
  idempotenceKey,
  invokeAction,
  ipInCidrs,
  startPayment,
  YOOKASSA_IP_ALLOWLIST,
  yookassaConnector,
  yookassaHookToken,
  yookassaSourceAllowed,
  yookassaWebhookUrl,
} from "../src/index.js";
import { createTestCtx, MemoryStore, MemorySystemDb, testPlatform } from "../src/testing.js";
import { type Example, loadSpec } from "./helpers.js";
import { YookassaMock } from "./mocks/index.js";

let mock: YookassaMock;
beforeAll(async () => {
  mock = await new YookassaMock().start();
});
afterAll(() => mock.stop());

interface Opts {
  example?: Example;
  env?: "draft" | "prod";
  secrets?: Record<string, string> | null;
  live?: boolean;
  now?: () => Date;
  testMode?: boolean;
}

function setup(o: Opts = {}) {
  const spec = loadSpec(o.example ?? "forum");
  if (o.testMode) {
    const integ = spec.integrations?.find((i) => i.name === "yookassa");
    (integ?.config as { testMode?: boolean }).testMode = true;
  }
  const db = new MemorySystemDb(spec);
  const now = o.now ?? (() => new Date());
  const ctx = createTestCtx({
    spec,
    integration: "yookassa",
    db,
    env: o.env ?? "draft",
    host: "http://forum--draft.localhost:4100",
    now,
    store: new MemoryStore(now),
    secrets:
      o.secrets === null
        ? {}
        : (o.secrets ?? { yookassa_shop_id: mock.shopId, yookassa_secret_key: mock.secretKey }),
    fetch: (input, init) => fetch(input, init),
    platform: testPlatform({
      yookassa: { live: o.live ?? true, apiBase: mock.apiBase, ipAllowlist: YOOKASSA_IP_ALLOWLIST },
    }),
  });
  return { ctx, db };
}

const email = () => `buyer${Math.random().toString(36).slice(2, 8)}@example.ru`;
async function ticket(db: MemorySystemDb, amount = 3025, status = "pending_payment") {
  return db.insert("ticket", { status, amount, holder_email: email() });
}

async function pay(ctx: ConnectorCtx, db: MemorySystemDb, id: string, binding = "ticket", entity = "ticket") {
  return startPayment(ctx, { binding, id }, await db.get(entity, id));
}

const paymentFor = (recordId: string) =>
  [...mock.payments.values()].filter((p) => p.metadata.recordId === recordId).at(-1)?.id as string;

const notify = (ctx: ConnectorCtx, event: string, id: string, object?: Record<string, unknown>) =>
  handleYookassaNotification(ctx, mock.notification(event, id, object));

describe("startPayment against the API (test shop)", () => {
  test("creates the payment from the record on the server: amount, receipt, metadata, Idempotence-Key", async () => {
    const { ctx, db } = setup();
    const id = await ticket(db);
    const res = await pay(ctx, db, id);
    const pid = paymentFor(id);
    expect(res).toEqual({
      ok: true,
      reused: false,
      confirmationUrl: `${mock.origin}/checkout/payments/${pid}`,
    });
    const call = mock.callsTo("POST", "/v3/payments").at(-1);
    expect(call?.idempotenceKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const record = await db.get("ticket", id);
    expect(call?.body).toEqual({
      amount: { value: "3025.00", currency: "RUB" },
      capture: true,
      confirmation: { type: "redirect", return_url: `http://forum--draft.localhost:4100/ticket/${id}` },
      description: "Билет на форум «Северный ритейл»",
      metadata: { system: "sys_test", env: "draft", binding: "ticket", recordId: id },
      receipt: {
        customer: { email: record?.holder_email },
        items: [
          {
            description: "Билет на форум «Северный ритейл»",
            quantity: "1",
            amount: { value: "3025.00", currency: "RUB" },
            vat_code: 1,
            payment_mode: "full_payment",
            payment_subject: "service",
          },
        ],
      },
    });
    expect(await db.list("payment")).toMatchObject([
      { ticket: id, provider_payment_id: pid, kind: "payment", status: "pending", amount: 3025 },
    ]);
    // Reused while pending, younger than 30 minutes and with the same amount: no second API call.
    const posts = mock.callsTo("POST", "/v3/payments").length;
    expect(await pay(ctx, db, id)).toMatchObject({
      reused: true,
      confirmationUrl: res.ok && res.confirmationUrl,
    });
    expect(mock.callsTo("POST", "/v3/payments")).toHaveLength(posts);
    // A real payment is never confirmed by the draft mock page.
    expect(await confirmMockPayment(ctx, { binding: "ticket", id })).toEqual({ ok: false, status: 404 });
  });

  test("500 → the same Idempotence-Key is repeated; 401 → AUTH_FAILED; 429 → RATE_LIMITED", async () => {
    const { ctx, db } = setup();
    const id = await ticket(db);
    const before = mock.calls.length;
    mock.queue.push({ status: 500 });
    expect(await pay(ctx, db, id)).toMatchObject({ ok: true, reused: false });
    const tries = mock.calls.slice(before).filter((c) => c.path === "/v3/payments");
    expect(tries.map((c) => c.status)).toEqual([500, 200]);
    expect(tries[0]?.idempotenceKey).toBe(tries[1]?.idempotenceKey);

    const bad = setup({ secrets: { yookassa_shop_id: mock.shopId, yookassa_secret_key: "test_wrong" } });
    const id2 = await ticket(bad.db);
    await expect(pay(bad.ctx, bad.db, id2)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      providerStatus: 401,
    });
    for (let i = 0; i < 3; i++) mock.queue.push({ status: 429 });
    await expect(pay(ctx, db, await ticket(db))).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await bad.db.list("payment")).toEqual([]);
  });

  test("draft requires a test shop; prod refuses one unless testMode; draft without keys keeps the mock", async () => {
    const live = setup({ secrets: { yookassa_shop_id: "1", yookassa_secret_key: "live_abc" } });
    await expect(pay(live.ctx, live.db, await ticket(live.db))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "Для черновика нужен тестовый магазин",
    });
    const prod = setup({ env: "prod" });
    await expect(pay(prod.ctx, prod.db, await ticket(prod.db))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    const prodTest = setup({ env: "prod", testMode: true });
    expect(await pay(prodTest.ctx, prodTest.db, await ticket(prodTest.db))).toMatchObject({ ok: true });

    const noKeys = setup({ secrets: null });
    const id = await ticket(noKeys.db);
    expect(await pay(noKeys.ctx, noKeys.db, id)).toMatchObject({
      confirmationUrl: `/_wizard/pay-mock?binding=ticket&id=${id}`,
    });
    const outbox = setup({ live: false, env: "prod" });
    await expect(pay(outbox.ctx, outbox.db, await ticket(outbox.db))).rejects.toMatchObject({
      code: "EGRESS_DISABLED",
    });
  });
});

describe("notifications: the API answer decides", () => {
  test("payment → succeeded → paidStatus; repeated delivery changes nothing", async () => {
    const { ctx, db } = setup();
    const id = await ticket(db);
    await pay(ctx, db, id);
    const pid = paymentFor(id);
    mock.succeed(pid);
    expect(await notify(ctx, "payment.succeeded", pid)).toEqual({ status: 200, result: "applied" });
    expect((await db.get("ticket", id))?.status).toBe("paid");
    expect(await db.list("payment")).toMatchObject([{ status: "succeeded", kind: "payment" }]);
    const gets = mock.callsTo("GET", `/v3/payments/${pid}`).length;
    expect(await notify(ctx, "payment.succeeded", pid)).toEqual({ status: 200, result: "duplicate" });
    expect(mock.callsTo("GET", `/v3/payments/${pid}`)).toHaveLength(gets);
    expect(await db.list("payment")).toHaveLength(1);
  });

  test("forged body: GET still shows pending → nothing changes and the event stays open", async () => {
    const { ctx, db } = setup();
    const id = await ticket(db);
    await pay(ctx, db, id);
    const pid = paymentFor(id);
    expect(
      await notify(ctx, "payment.succeeded", pid, {
        status: "succeeded",
        paid: true,
        amount: { value: "1.00" },
      }),
    ).toEqual({ status: 200, result: "pending" });
    expect((await db.get("ticket", id))?.status).toBe("pending_payment");
    expect(await db.list("payment")).toMatchObject([{ status: "pending" }]);
    // Later the payment really succeeds: the redelivered event is applied.
    mock.succeed(pid);
    expect(await notify(ctx, "payment.succeeded", pid)).toMatchObject({ result: "applied" });
  });

  test("unknown payment, another system's metadata, malformed body", async () => {
    const { ctx, db } = setup();
    expect(await notify(ctx, "payment.succeeded", "00000000-0000-4000-8000-000000000000")).toEqual({
      status: 200,
      result: "ignored",
    });
    const other = setup();
    const id = await ticket(other.db);
    await pay({ ...other.ctx, system: { ...other.ctx.system, id: "sys_other" } }, other.db, id);
    const pid = paymentFor(id);
    mock.succeed(pid);
    expect(await notify(ctx, "payment.succeeded", pid)).toMatchObject({ result: "ignored" });
    expect(await db.list("payment")).toEqual([]);
    expect(await handleYookassaNotification(ctx, { event: "payment.succeeded" })).toEqual({
      status: 400,
      result: "invalid",
    });
    expect(
      await handleYookassaNotification(ctx, {
        type: "notification",
        event: "deal.closed",
        object: { id: "x" },
      }),
    ).toEqual({
      status: 200,
      result: "ignored",
    });
  });

  test("amount changed while pending: new payment; the old one succeeding → needs_review, record not paid", async () => {
    const { ctx, db } = setup();
    const id = await ticket(db);
    await pay(ctx, db, id);
    const oldId = paymentFor(id);
    await db.patch("ticket", id, { amount: 5000 });
    expect(await pay(ctx, db, id)).toMatchObject({ ok: true, reused: false });
    const newId = paymentFor(id);
    expect(newId).not.toBe(oldId);
    expect(mock.payments.get(newId)?.amount.value).toBe("5000.00");
    mock.succeed(oldId);
    expect(await notify(ctx, "payment.succeeded", oldId)).toMatchObject({ result: "needs_review" });
    expect((await db.get("ticket", id))?.status).toBe("pending_payment");
    expect(await db.getBy("payment", "provider_payment_id", oldId)).toMatchObject({ status: "needs_review" });
    expect(ctx.outbox.messages).toMatchObject([
      {
        connector: "yookassa",
        action: "owner_event",
        payload: { event: "payment_needs_review", message_ru: "Оплата требует проверки", recordId: id },
      },
    ]);
    expect(await invokeAction(yookassaConnector, "getPaymentStatus", ctx, { binding: "ticket", id })).toBe(
      "pending",
    );
    mock.succeed(newId);
    expect(await notify(ctx, "payment.succeeded", newId)).toMatchObject({ result: "applied" });
    expect((await db.get("ticket", id))?.status).toBe("paid");
  });

  test("canceled → canceledStatus; waiting_for_capture → the payment is canceled at YooKassa", async () => {
    const { ctx, db } = setup();
    const id = await ticket(db);
    await pay(ctx, db, id);
    const pid = paymentFor(id);
    mock.cancel(pid);
    expect(await notify(ctx, "payment.canceled", pid)).toMatchObject({ result: "applied" });
    expect((await db.get("ticket", id))?.status).toBe("canceled");

    const id2 = await ticket(db);
    await pay(ctx, db, id2);
    const pid2 = paymentFor(id2);
    mock.setStatus(pid2, "waiting_for_capture");
    expect(
      await invokeAction(yookassaConnector, "getPaymentStatus", ctx, { binding: "ticket", id: id2 }),
    ).toBe("waiting_for_capture");
    expect(await notify(ctx, "payment.waiting_for_capture", pid2)).toMatchObject({
      result: "capture_canceled",
    });
    expect(mock.payments.get(pid2)?.status).toBe("canceled");
    expect(mock.callsTo("POST", `/v3/payments/${pid2}/cancel`)).toHaveLength(1);
  });
});

describe("refunds", () => {
  async function paid(o: Opts = {}) {
    const s = setup(o);
    const id = await ticket(s.db);
    await pay(s.ctx, s.db, id);
    const pid = paymentFor(id);
    mock.succeed(pid);
    await notify(s.ctx, "payment.succeeded", pid);
    return { ...s, id, pid };
  }
  const refund = (ctx: ConnectorCtx, key: string, input: Record<string, unknown>) =>
    invokeAction(
      yookassaConnector,
      "refund",
      { ...ctx, idempotencyKey: key },
      { binding: "ticket", ...input },
    );

  test("payment → paid → refund → refundedStatus; refund.succeeded redelivery is a no-op", async () => {
    const { ctx, db, id, pid } = await paid();
    const r = (await refund(ctx, "r1", { id, reason: "Отмена участия" })) as { refundId: string };
    expect(r).toMatchObject({ status: "succeeded" });
    const call = mock.callsTo("POST", "/v3/refunds").at(-1);
    expect(call?.body).toMatchObject({
      payment_id: pid,
      amount: { value: "3025.00", currency: "RUB" },
      description: "Отмена участия",
      receipt: { items: [{ payment_mode: "full_payment", amount: { value: "3025.00" } }] },
    });
    expect((await db.get("ticket", id))?.status).toBe("refunded");
    expect(await notify(ctx, "refund.succeeded", r.refundId)).toMatchObject({ result: "duplicate" });
    expect((await db.list("payment")).map((p) => [p.kind, p.status])).toEqual([
      ["payment", "succeeded"],
      ["refund", "succeeded"],
    ]);
    // Same idempotency key → stored result, no second API call.
    const posts = mock.callsTo("POST", "/v3/refunds").length;
    expect(await refund(ctx, "r1", { id, reason: "Отмена участия" })).toEqual(r);
    expect(mock.callsTo("POST", "/v3/refunds")).toHaveLength(posts);
  });

  test("partial refunds up to the paid amount; pending refund completes by notification", async () => {
    const { ctx, db, id } = await paid();
    expect(await refund(ctx, "p1", { id, amount: 1000 })).toMatchObject({ status: "succeeded" });
    expect((await db.get("ticket", id))?.status).toBe("paid");
    await expect(refund(ctx, "p2", { id, amount: 2500 })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    mock.refundStatus = "pending";
    try {
      const r = (await refund(ctx, "p3", { id })) as { refundId: string; status: string };
      expect(r.status).toBe("pending");
      expect(mock.refunds.get(r.refundId)?.amount.value).toBe("2025.00");
      expect((await db.get("ticket", id))?.status).toBe("paid");
      (mock.refunds.get(r.refundId) as { status: string }).status = "succeeded";
      expect(await notify(ctx, "refund.succeeded", r.refundId)).toMatchObject({ result: "applied" });
      expect((await db.get("ticket", id))?.status).toBe("refunded");
    } finally {
      mock.refundStatus = "succeeded";
    }
    await expect(refund(ctx, "p4", { id })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("refund outside refundWindowDays → INVALID_REQUEST", async () => {
    let now = new Date();
    const { ctx, id } = await paid({ now: () => now });
    now = new Date(now.getTime() + 8 * 24 * 60 * 60_000);
    await expect(refund(ctx, "late", { id })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "Срок возврата истёк: возврат возможен 7 дн. после оплаты",
    });
  });
});

describe("bakery: prepayment receipt settlement (54-FZ)", () => {
  test("final payment → closing receipt with settlements prepayment, once", async () => {
    const { ctx, db } = setup({ example: "bakery" });
    const id = await db.insert("cake_order", {
      number: 42,
      status: "pending_payment",
      prepay_amount: 1500,
      remaining_amount: 1500,
      customer_email: "cake@example.ru",
      customer_phone: "+7 (900) 123-45-67",
    });
    await pay(ctx, db, id, "prepay", "cake_order");
    const prepayId = paymentFor(id);
    expect(mock.callsTo("POST", "/v3/payments").at(-1)?.body).toMatchObject({
      description: "Предоплата 50% по заказу №42",
      receipt: {
        customer: { email: "cake@example.ru", phone: "79001234567" },
        items: [{ payment_mode: "full_prepayment", payment_subject: "commodity" }],
      },
    });
    mock.succeed(prepayId);
    expect(await notify(ctx, "payment.succeeded", prepayId)).toMatchObject({ result: "applied" });
    expect((await db.get("cake_order", id))?.status).toBe("prepaid");
    expect(mock.closingReceipts).toHaveLength(0);

    await db.patch("cake_order", id, { status: "ready" });
    await pay(ctx, db, id, "final", "cake_order");
    const finalId = paymentFor(id);
    mock.succeed(finalId);
    const before = mock.closingReceipts.length;
    expect(await notify(ctx, "payment.succeeded", finalId)).toMatchObject({ result: "applied" });
    expect((await db.get("cake_order", id))?.status).toBe("completed");
    expect(mock.closingReceipts.slice(before)).toEqual([
      {
        type: "payment",
        payment_id: prepayId,
        send: true,
        customer: { email: "cake@example.ru", phone: "79001234567" },
        items: [
          {
            description: "Предоплата 50% по заказу №42",
            quantity: "1",
            amount: { value: "1500.00", currency: "RUB" },
            vat_code: 1,
            payment_mode: "full_payment",
            payment_subject: "commodity",
          },
        ],
        settlements: [{ type: "prepayment", amount: { value: "1500.00", currency: "RUB" } }],
      },
    ]);
    // Forget the processed-event marker: the journal state alone keeps the redelivery idempotent.
    await ctx.store.set(`hook:payment.succeeded:${finalId}`, undefined, -1);
    expect(await notify(ctx, "payment.succeeded", finalId)).toMatchObject({ result: "duplicate" });
    expect(mock.closingReceipts.length - before).toBe(1);
  });
});

describe("webhook source, hook URL and secrets", () => {
  test("allowlist CIDRs (IPv4, IPv6, IPv4-mapped) and the trusted-ingress client IP", () => {
    const { ctx } = setup();
    for (const ip of [
      "185.71.76.0",
      "185.71.76.31",
      "77.75.156.11",
      "77.75.154.200",
      "2a02:5180::1",
      "::ffff:185.71.77.5",
    ]) {
      expect(yookassaSourceAllowed(ctx, ip), ip).toBe(true);
    }
    for (const ip of ["185.71.76.32", "77.75.156.12", "127.0.0.1", "2a02:5181::1", "garbage", null]) {
      expect(yookassaSourceAllowed(ctx, ip), String(ip)).toBe(false);
    }
    expect(ipInCidrs("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipInCidrs("10.1.2.3", ["10.0.0.0/33", "bad"])).toBe(false);
    // Untrusted peer: X-Forwarded-For is ignored.
    expect(effectiveClientIp("203.0.113.9", "185.71.76.1", [])).toBe("203.0.113.9");
    expect(effectiveClientIp("203.0.113.9", "185.71.76.1", ["10.0.0.0/8"])).toBe("203.0.113.9");
    // Trusted ingress: the right-most untrusted hop.
    expect(effectiveClientIp("10.0.0.2", "1.1.1.1, 185.71.76.1", ["10.0.0.0/8"])).toBe("185.71.76.1");
    expect(effectiveClientIp("10.0.0.2", "185.71.76.1, 10.0.0.7", ["10.0.0.0/8"])).toBe("185.71.76.1");
    expect(effectiveClientIp("10.0.0.2", null, ["10.0.0.0/8"])).toBe("10.0.0.2");
  });

  test("hook token is derived from the shop key; webhook URL; idempotence key is stable", async () => {
    const { ctx } = setup();
    const token = await yookassaHookToken(ctx);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(token).not.toContain(mock.secretKey);
    expect(await yookassaWebhookUrl(ctx)).toBe(
      `http://forum--draft.localhost:4100/_wizard/hooks/yookassa/yookassa/${token}`,
    );
    expect(idempotenceKey("a")).toBe(idempotenceKey("a"));
    expect(idempotenceKey("a")).not.toBe(idempotenceKey("b"));
    expect(idempotenceKey("a")).toHaveLength(36);
  });

  test("logs never carry the secret key, the shop id or buyer contacts", async () => {
    const { ctx, db } = setup();
    const id = await ticket(db);
    await pay(ctx, db, id);
    const pid = paymentFor(id);
    mock.succeed(pid);
    await notify(ctx, "payment.succeeded", pid);
    const dump = JSON.stringify(ctx.logs);
    expect(ctx.logs.length).toBeGreaterThan(0);
    expect(dump).not.toContain(mock.secretKey);
    expect(dump).not.toContain(String((await db.get("ticket", id))?.holder_email));
    expect(dump).not.toContain("Basic ");
  });
});
