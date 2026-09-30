// AC3 (M0-28): M0 mock payment moves the record to paidStatus exactly like payment.succeeded (L1-23).
import { describe, expect, test } from "vitest";
import {
  applyPaymentCanceled,
  applyPaymentSucceeded,
  confirmMockPayment,
  invokeAction,
  type ProviderPayment,
  startPayment,
  yookassaConnector,
} from "../src/index.js";
import { createTestCtx, MemorySystemDb } from "../src/testing.js";
import { type Example, loadSpec } from "./helpers.js";

const forum = loadSpec("forum");
const bakery = loadSpec("bakery");

function ctxFor(example: Example = "forum", env: "draft" | "prod" = "draft", now?: () => Date) {
  const spec = example === "forum" ? forum : bakery;
  const db = new MemorySystemDb(spec);
  const ctx = createTestCtx({ spec, integration: "yookassa", db, env, ...(now ? { now } : {}) });
  return { ctx, db };
}

async function ticket(db: MemorySystemDb, status = "pending_payment", amount = 3025) {
  return db.insert("ticket", { status, amount, holder_email: "ivan@example.ru" });
}

/** Tables without generated ids, for comparing two flows. */
async function snapshot(db: MemorySystemDb) {
  const t = (await db.list("ticket")).map(({ id: _, ...r }) => r);
  const p = (await db.list("payment")).map(({ id: _, ticket: __, provider_payment_id: ___, ...r }) => r);
  return { t, p };
}

describe("startPayment (/api/pay M0)", () => {
  test("returns the mock confirmation URL and records a pending payment", async () => {
    const { ctx, db } = ctxFor();
    const id = await ticket(db);
    const res = await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    expect(res).toEqual({
      ok: true,
      reused: false,
      confirmationUrl: `/_wizard/pay-mock?binding=ticket&id=${id}`,
    });
    expect(await db.list("payment")).toMatchObject([
      { ticket: id, kind: "payment", status: "pending", amount: 3025 },
    ]);
  });

  test("a pending payment with the same amount is reused; a changed amount creates a new one", async () => {
    const { ctx, db } = ctxFor();
    const id = await ticket(db);
    await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    const again = await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    expect(again).toMatchObject({ ok: true, reused: true });
    expect(await db.list("payment")).toHaveLength(1);
    await db.patch("ticket", id, { amount: 5000 });
    expect(await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id))).toMatchObject({
      reused: false,
    });
    expect(await db.list("payment")).toHaveLength(2);
  });

  test("pending older than 30 minutes is not reused", async () => {
    let now = new Date("2026-10-01T10:00:00Z");
    const { ctx, db } = ctxFor("forum", "draft", () => now);
    const id = await ticket(db);
    await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    now = new Date("2026-10-01T10:31:00Z");
    expect(await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id))).toMatchObject({
      reused: false,
    });
  });

  test("409 NOT_PAYABLE, 409 NOTHING_TO_PAY, 404 for unknown binding or unreadable record", async () => {
    const { ctx, db } = ctxFor();
    const paid = await ticket(db, "paid");
    const free = await ticket(db, "pending_payment", 0);
    expect(
      await startPayment(ctx, { binding: "ticket", id: paid }, await db.get("ticket", paid)),
    ).toMatchObject({
      ok: false,
      status: 409,
      code: "NOT_PAYABLE",
    });
    expect(
      await startPayment(ctx, { binding: "ticket", id: free }, await db.get("ticket", free)),
    ).toMatchObject({
      code: "NOTHING_TO_PAY",
    });
    expect(
      await startPayment(ctx, { binding: "nope", id: free }, await db.get("ticket", free)),
    ).toMatchObject({
      status: 404,
    });
    expect(await startPayment(ctx, { binding: "ticket", id: "x" }, null)).toMatchObject({ status: 404 });
  });
});

describe("mock confirmation ≡ payment.succeeded", () => {
  test("pay-mock moves the record to paidStatus and the payment to succeeded", async () => {
    const { ctx, db } = ctxFor();
    const id = await ticket(db);
    await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    const res = await confirmMockPayment(ctx, { binding: "ticket", id });
    expect(res).toEqual({ ok: true, result: "applied", returnUrl: `/ticket/${id}` });
    expect((await db.get("ticket", id))?.status).toBe("paid");
    expect(await db.list("payment")).toMatchObject([{ status: "succeeded" }]);
  });

  test("same end state as a verified payment.succeeded event", async () => {
    const a = ctxFor();
    const idA = await ticket(a.db);
    await startPayment(a.ctx, { binding: "ticket", id: idA }, await a.db.get("ticket", idA));
    await confirmMockPayment(a.ctx, { binding: "ticket", id: idA });

    const b = ctxFor();
    const idB = await ticket(b.db);
    await startPayment(b.ctx, { binding: "ticket", id: idB }, await b.db.get("ticket", idB));
    const [row] = await b.db.list("payment");
    const event: ProviderPayment = {
      id: String(row?.provider_payment_id),
      status: "succeeded",
      amount: { value: "3025.00", currency: "RUB" },
      metadata: { system: b.ctx.system.id, env: "draft", binding: "ticket", recordId: idB },
    };
    expect(await applyPaymentSucceeded(b.ctx, event)).toBe("applied");
    expect(await snapshot(b.db)).toEqual(await snapshot(a.db));
    // Repeated delivery changes nothing.
    expect(await applyPaymentSucceeded(b.ctx, event)).toBe("duplicate");
    expect(await confirmMockPayment(b.ctx, { binding: "ticket", id: idB })).toEqual({
      ok: false,
      status: 404,
    });
    expect(await b.db.list("payment")).toHaveLength(1);
  });

  test("record amount changed while pending → needs_review, record stays unpaid", async () => {
    const { ctx, db } = ctxFor();
    const id = await ticket(db);
    await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    await db.patch("ticket", id, { amount: 1 });
    expect(await confirmMockPayment(ctx, { binding: "ticket", id })).toMatchObject({
      result: "needs_review",
    });
    expect((await db.get("ticket", id))?.status).toBe("pending_payment");
    expect(await db.list("payment")).toMatchObject([{ status: "needs_review" }]);
  });

  test("event for another system, env or currency is not applied", async () => {
    const { ctx, db } = ctxFor();
    const id = await ticket(db);
    await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    const [row] = await db.list("payment");
    const base: ProviderPayment = {
      id: String(row?.provider_payment_id),
      status: "succeeded",
      amount: { value: "3025.00", currency: "RUB" },
      metadata: { system: ctx.system.id, env: "draft", binding: "ticket", recordId: id },
    };
    expect(await applyPaymentSucceeded(ctx, { ...base, metadata: { ...base.metadata, system: "x" } })).toBe(
      "ignored",
    );
    expect(await applyPaymentSucceeded(ctx, { ...base, metadata: { ...base.metadata, env: "prod" } })).toBe(
      "ignored",
    );
    expect(await applyPaymentSucceeded(ctx, { ...base, amount: { value: "3025.00", currency: "USD" } })).toBe(
      "needs_review",
    );
    expect((await db.get("ticket", id))?.status).toBe("pending_payment");
  });

  test("pay-mock is draft-only", async () => {
    const { ctx, db } = ctxFor("forum", "prod");
    const id = await ticket(db);
    expect(await confirmMockPayment(ctx, { binding: "ticket", id })).toEqual({ ok: false, status: 404 });
    await expect(
      startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id)),
    ).rejects.toMatchObject({
      code: "EGRESS_DISABLED",
    });
  });

  test("bakery: final payment settles the prepayment receipt (outbox stub)", async () => {
    const { ctx, db } = ctxFor("bakery");
    const id = await db.insert("cake_order", {
      status: "ready",
      remaining_amount: 1500,
      prepay_amount: 1500,
    });
    await startPayment(ctx, { binding: "final", id }, await db.get("cake_order", id));
    expect(await confirmMockPayment(ctx, { binding: "final", id })).toMatchObject({ result: "applied" });
    expect((await db.get("cake_order", id))?.status).toBe("completed");
    expect(ctx.outbox.messages).toMatchObject([
      { connector: "yookassa", action: "create_receipt", payload: { settlePrepaymentOf: "prepay" } },
    ]);
  });

  test("payment.canceled → canceledStatus while payable", async () => {
    const { ctx, db } = ctxFor();
    const id = await ticket(db);
    await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    const [row] = await db.list("payment");
    const res = await applyPaymentCanceled(ctx, {
      id: String(row?.provider_payment_id),
      status: "canceled",
      amount: { value: "3025.00", currency: "RUB" },
      metadata: { system: ctx.system.id, env: "draft", binding: "ticket", recordId: id },
    });
    expect(res).toBe("applied");
    expect((await db.get("ticket", id))?.status).toBe("canceled");
  });
});

describe("yookassa actions (test-mode stubs)", () => {
  test("getPaymentStatus follows the journal; refund goes to the outbox", async () => {
    const { ctx, db } = ctxFor();
    const id = await ticket(db);
    expect(await invokeAction(yookassaConnector, "getPaymentStatus", ctx, { binding: "ticket", id })).toBe(
      "none",
    );
    await expect(
      invokeAction(yookassaConnector, "refund", ctx, { binding: "ticket", id }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
    expect(await invokeAction(yookassaConnector, "getPaymentStatus", ctx, { binding: "ticket", id })).toBe(
      "pending",
    );
    await confirmMockPayment(ctx, { binding: "ticket", id });
    expect(await invokeAction(yookassaConnector, "getPaymentStatus", ctx, { binding: "ticket", id })).toBe(
      "succeeded",
    );
    await expect(
      invokeAction(yookassaConnector, "refund", ctx, { binding: "ticket", id, amount: 9999 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const r = await invokeAction(yookassaConnector, "refund", ctx, { binding: "ticket", id });
    expect(r).toMatchObject({ status: "pending" });
    expect(ctx.outbox.messages.filter((m) => m.action === "refund")).toHaveLength(1);
  });

  test("testMode: draft → test; prod → live unless config.testMode", () => {
    const cfg = { bindings: [], refundWindowDays: 0 };
    const s = { get: async () => "" };
    expect(yookassaConnector.testMode("draft", cfg as never, s)).toBe("test");
    expect(yookassaConnector.testMode("prod", cfg as never, s)).toBe("live");
    expect(yookassaConnector.testMode("prod", { ...cfg, testMode: true } as never, s)).toBe("test");
  });
});
