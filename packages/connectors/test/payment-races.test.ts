// V3-18 (shop audit H, G, S3, S4, S7): one payment applied once when the notice and the return check meet, a declined
// card keeps the record payable until its deadline, G0 of the binding: no amount/status a role may set, no personal
// data in the payment description.
import type { AppSpec } from "@wizard/appspec";
import { describe, expect, test } from "vitest";
import {
  applyPaymentCanceled,
  applyPaymentSucceeded,
  claimOnce,
  type ProviderPayment,
  startPayment,
  validateIntegrations,
} from "../src/index.js";
import { createTestCtx, MemoryStore, MemorySystemDb } from "../src/testing.js";
import { loadSpec } from "./helpers.js";

/** The first ЮKassa binding of a spec (mutable). */
function bindingOf(spec: AppSpec): Record<string, unknown> {
  const yk = spec.integrations?.find((i) => i.connector === "yookassa");
  const b = (yk?.config as { bindings?: Record<string, unknown>[] } | undefined)?.bindings?.[0];
  if (!b) throw new Error("no yookassa binding");
  return b;
}

/** The forum spec with a deadline and a note on the ticket, and the binding using them. */
function retrySpec(): AppSpec {
  const spec = structuredClone(loadSpec("forum")) as AppSpec;
  const ticket = spec.entities.find((e) => e.name === "ticket");
  ticket?.fields.push(
    { name: "pay_until", label: "Оплатить до", type: "datetime" },
    { name: "note", label: "Заметка", type: "string", maxLength: 300 },
  );
  const b = bindingOf(spec);
  b.retryUntilField = "pay_until";
  b.noteField = "note";
  return spec;
}

function setup(spec: AppSpec, now = () => new Date("2026-10-01T10:00:00Z")) {
  const db = new MemorySystemDb(spec);
  const ctx = createTestCtx({ spec, integration: "yookassa", db, env: "draft", now });
  return { ctx, db };
}

async function pendingTicket(
  ctx: ReturnType<typeof setup>["ctx"],
  db: MemorySystemDb,
  extra: Record<string, unknown> = {},
) {
  const id = await db.insert("ticket", {
    status: "pending_payment",
    amount: 3025,
    holder_email: "ivan@example.ru",
    ...extra,
  });
  await startPayment(ctx, { binding: "ticket", id }, await db.get("ticket", id));
  const [row] = await db.list("payment");
  const event: ProviderPayment = {
    id: String(row?.provider_payment_id),
    status: "succeeded",
    amount: { value: "3025.00", currency: "RUB" },
    metadata: { system: ctx.system.id, env: "draft", binding: "ticket", recordId: id },
  };
  return { id, event };
}

describe("H: the notice and the return check meet on one payment", () => {
  test("two concurrent applications: one applies, the record is patched once", async () => {
    const { ctx, db } = setup(loadSpec("forum"));
    const { id, event } = await pendingTicket(ctx, db);
    const patches: string[] = [];
    const patch = db.patch.bind(db);
    db.patch = async (entity, rid, p) => {
      patches.push(`${entity}:${Object.keys(p).join(",")}`);
      return patch(entity, rid, p);
    };
    const results = await Promise.all([applyPaymentSucceeded(ctx, event), applyPaymentSucceeded(ctx, event)]);
    expect(results.filter((r) => r === "applied")).toHaveLength(1);
    expect(results.filter((r) => r !== "applied").every((r) => r === "busy" || r === "duplicate")).toBe(true);
    expect(patches.filter((p) => p === "ticket:status")).toHaveLength(1);
    expect((await db.get("ticket", id))?.status).toBe("paid");
    // After the winner finished, a late delivery is a duplicate.
    expect(await applyPaymentSucceeded(ctx, event)).toBe("duplicate");
  });

  test("a failed winner frees the transition for the redelivery", async () => {
    const { ctx, db } = setup(loadSpec("forum"));
    const { id, event } = await pendingTicket(ctx, db);
    const patch = db.patch.bind(db);
    let fail = true;
    db.patch = async (entity, rid, p) => {
      if (fail && entity === "ticket") throw new Error("db down");
      return patch(entity, rid, p);
    };
    await expect(applyPaymentSucceeded(ctx, event)).rejects.toThrow("db down");
    fail = false;
    expect(await applyPaymentSucceeded(ctx, event)).toBe("applied");
    expect((await db.get("ticket", id))?.status).toBe("paid");
  });

  test("claimOnce: atomic in the store, get-then-set without setIfAbsent", async () => {
    const { ctx } = setup(loadSpec("forum"));
    const both = await Promise.all([claimOnce(ctx, "k", 60_000), claimOnce(ctx, "k", 60_000)]);
    expect(both.sort()).toEqual([false, true]);
    const store = new MemoryStore();
    const plain = { get: store.get.bind(store), set: store.set.bind(store) };
    const legacy = { ...ctx, store: plain };
    expect(await claimOnce(legacy, "x", 60_000)).toBe(true);
    expect(await claimOnce(legacy, "x", 60_000)).toBe(false);
  });
});

describe("money after the record stopped waiting for it", () => {
  test("a payment that succeeds after the order was cancelled by its deadline goes to the owner's check, not paid", async () => {
    const { ctx, db } = setup(loadSpec("forum"));
    const { id, event } = await pendingTicket(ctx, db);
    await db.patch("ticket", id, { status: "canceled" });
    expect(await applyPaymentSucceeded(ctx, event)).toBe("needs_review");
    expect((await db.get("ticket", id))?.status).toBe("canceled");
    const [row] = await db.list("payment");
    expect(row?.status).toBe("needs_review");
  });
});

describe("G: a declined card keeps the order payable until its deadline", () => {
  test("before pay_until: still payable, the reason in the note; after it: canceled", async () => {
    const spec = retrySpec();
    const { ctx, db } = setup(spec);
    const early = await pendingTicket(ctx, db, { pay_until: "2026-10-01T11:00:00Z" });
    const declined = (e: ProviderPayment): ProviderPayment => ({
      ...e,
      status: "canceled",
      cancellation_details: { party: "issuer", reason: "insufficient_funds" },
    });
    expect(await applyPaymentCanceled(ctx, declined(early.event))).toBe("applied");
    const kept = await db.get("ticket", early.id);
    expect(kept?.status).toBe("pending_payment");
    expect(String(kept?.note)).toContain("недостаточно средств");
    // The buyer pays again: a new payment is created.
    expect(await startPayment(ctx, { binding: "ticket", id: early.id }, kept)).toMatchObject({
      reused: false,
    });

    const late = setup(spec);
    const t = await pendingTicket(late.ctx, late.db, { pay_until: "2026-10-01T09:00:00Z" });
    expect(await applyPaymentCanceled(late.ctx, declined(t.event))).toBe("applied");
    expect((await late.db.get("ticket", t.id))?.status).toBe("canceled");
  });
});

describe("G0 of the payment binding", () => {
  const rules = (spec: AppSpec) => validateIntegrations(spec).map((i) => i.rule);

  test("S3: a role creating the records must not set the amount or the status", () => {
    const spec = structuredClone(loadSpec("forum")) as AppSpec;
    spec.permissions.push({ role: "organizer", entity: "ticket", ops: ["create"] } as never);
    const r = rules(spec);
    expect(r).toContain("yookassa.amount_writable");
    expect(r).toContain("yookassa.status_writable");
    const p = spec.permissions[spec.permissions.length - 1] as { readonlyFields?: string[] };
    p.readonlyFields = ["amount", "status"];
    expect(rules(spec)).not.toContain("yookassa.status_writable");
    expect(rules(spec)).not.toContain("yookassa.amount_writable");
  });

  test("S7: no personal data in the payment description", () => {
    const spec = structuredClone(loadSpec("forum")) as AppSpec;
    const b = bindingOf(spec);
    b.description = "Билет для {{holder_email}}";
    expect(rules(spec)).toContain("yookassa.description_pii");
  });
});
