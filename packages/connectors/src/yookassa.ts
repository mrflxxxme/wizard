// YooKassa connector: specs/connectors/yookassa.yaml. M0 — config/G0 and the mock payment flow only.
import { randomUUID } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { z } from "zod";
import { defineAction, defineConnector } from "./define.js";
import { ConnectorError } from "./errors.js";
import { outboxMessage, requireTestMode } from "./runtime.js";
import {
  cpText,
  fieldNames,
  Issues,
  ident,
  placeholders,
  requireEntity,
  requireEnumValue,
  requireField,
} from "./spec-util.js";
import type { ConnectorCtx, Row, SpecCheckContext } from "./types.js";

const VAT_CODES = [1, 2, 3, 4, 5, 6, 11, 12] as const;

const receiptSchema = z
  .strictObject({
    customerEmailField: ident.optional(),
    customerPhoneField: ident.optional(),
    paymentSubject: z.enum(["commodity", "service"]),
    paymentMode: z.enum(["full_prepayment", "full_payment"]),
    vatCode: z.union(
      VAT_CODES.map((c) => z.literal(c)),
      {
        error: `Код НДС — одно из значений ${VAT_CODES.join(", ")}`,
      },
    ),
    settlePrepaymentOf: ident.optional(),
  })
  .refine((r) => r.customerEmailField || r.customerPhoneField, {
    error: "Для чека нужен email или телефон покупателя: укажите customerEmailField или customerPhoneField",
  });

const bindingSchema = z.strictObject({
  id: ident,
  entity: ident,
  amountField: ident,
  payableStatus: ident,
  paidStatus: ident,
  canceledStatus: ident,
  refundedStatus: ident,
  statusField: ident.optional(),
  paymentEntity: z.strictObject({ name: ident, refField: ident }),
  description: cpText(1, 128),
  returnRoute: z.string().regex(/^\/[a-z0-9/:_-]*$/, { error: "Маршрут страницы возврата начинается с /" }),
  receipt: receiptSchema,
});

export const yookassaConfigSchema = z
  .strictObject({
    bindings: z.array(bindingSchema).min(1).max(10),
    refundWindowDays: z.int().min(0).max(365),
    testMode: z.boolean().optional(),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    c.bindings.forEach((b, i) => {
      if (seen.has(b.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["bindings", i, "id"],
          message: `Привязка «${b.id}» уже объявлена`,
        });
      }
      seen.add(b.id);
    });
  });
export type YookassaConfig = z.infer<typeof yookassaConfigSchema>;
export type YookassaBinding = YookassaConfig["bindings"][number];

const PAYMENT_FIELDS = {
  provider_payment_id: ["string"],
  kind: ["enum"],
  amount: ["money"],
  status: ["enum"],
} as const;
const PAYMENT_KINDS = ["payment", "refund"];
const PAYMENT_STATUSES = ["pending", "succeeded", "canceled"];

export function validateYookassaSpec(config: YookassaConfig, spec: AppSpec, at: SpecCheckContext) {
  const issues = new Issues(at);
  const ids = config.bindings.map((b) => b.id);
  config.bindings.forEach((b, i) => {
    const rel = (...p: (string | number)[]) => ["bindings", i, ...p];
    const entity = requireEntity(spec, issues, "yookassa.entity", rel("entity"), b.entity);
    if (entity) {
      requireField(entity, issues, "yookassa.amount_field", rel("amountField"), b.amountField, ["money"]);
      const statusName = b.statusField ?? "status";
      const status = requireField(entity, issues, "yookassa.status_field", rel("statusField"), statusName, [
        "enum",
      ]);
      if (status) {
        for (const k of ["payableStatus", "paidStatus", "canceledStatus", "refundedStatus"] as const) {
          requireEnumValue(entity, status, issues, "yookassa.status_value", rel(k), b[k]);
        }
      }
      for (const p of placeholders(b.description)) {
        if (!entity.fields.some((f) => f.name === p)) {
          issues.add(
            "yookassa.description_field",
            rel("description"),
            `В описании платежа поле «${p}» не найдено в «${entity.name}»`,
            fieldNames(entity),
          );
        }
      }
      const r = b.receipt;
      if (r.customerEmailField) {
        requireField(
          entity,
          issues,
          "yookassa.receipt_email",
          rel("receipt", "customerEmailField"),
          r.customerEmailField,
          ["email"],
        );
      }
      if (r.customerPhoneField) {
        requireField(
          entity,
          issues,
          "yookassa.receipt_phone",
          rel("receipt", "customerPhoneField"),
          r.customerPhoneField,
          ["phone"],
        );
      }
      spec.permissions.forEach((p) => {
        if (
          p.entity === b.entity &&
          p.ops.includes("update") &&
          !(p.readonlyFields ?? []).includes(b.amountField)
        ) {
          issues.add(
            "yookassa.amount_writable",
            rel("amountField"),
            `Роль «${p.role}» может менять сумму «${b.entity}.${b.amountField}»: добавьте поле в readonlyFields`,
          );
        }
      });
    }
    const pay = requireEntity(
      spec,
      issues,
      "yookassa.payment_entity",
      rel("paymentEntity", "name"),
      b.paymentEntity.name,
    );
    if (pay) {
      const ref = requireField(
        pay,
        issues,
        "yookassa.payment_ref",
        rel("paymentEntity", "refField"),
        b.paymentEntity.refField,
        ["ref"],
      );
      if (ref && ref.ref?.entity !== b.entity) {
        issues.add(
          "yookassa.payment_ref_target",
          rel("paymentEntity", "refField"),
          `Поле «${pay.name}.${ref.name}» должно ссылаться на «${b.entity}»`,
        );
      }
      for (const [name, types] of Object.entries(PAYMENT_FIELDS)) {
        const f = requireField(
          pay,
          issues,
          "yookassa.payment_field",
          rel("paymentEntity", "name"),
          name,
          types,
        );
        const need = name === "kind" ? PAYMENT_KINDS : name === "status" ? PAYMENT_STATUSES : [];
        for (const v of need)
          if (f) requireEnumValue(pay, f, issues, "yookassa.payment_enum", rel("paymentEntity", "name"), v);
      }
    }
    const settle = b.receipt.settlePrepaymentOf;
    if (settle !== undefined && (settle === b.id || !ids.includes(settle))) {
      issues.add(
        "yookassa.settle_binding",
        rel("receipt", "settlePrepaymentOf"),
        `Привязка предоплаты «${settle}» не найдена`,
        ids.filter((x) => x !== b.id),
      );
    }
  });
  return issues.list;
}

// ---------------------------------------------------------------- payments (runtime /api/pay, mock page, webhook core)

export const PENDING_REUSE_MS = 30 * 60_000;

export interface ProviderPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  amount: { value: string; currency: string };
  metadata: { system: string; env: string; binding: string; recordId: string };
}

interface PaymentMeta {
  binding: string;
  recordId: string;
  amount: number;
  createdAt: string;
  confirmationUrl: string;
}

export type PayResult =
  | { ok: true; confirmationUrl: string; reused: boolean }
  | {
      ok: false;
      status: 404 | 409;
      code: "NOT_FOUND" | "NOT_PAYABLE" | "NOTHING_TO_PAY";
      message_ru: string;
    };

export type PaymentEventResult = "applied" | "needs_review" | "duplicate" | "ignored";

const kop = (v: unknown) => Math.round(Number(v) * 100);
const payMetaKey = (id: string) => `pay:${id}`;
const META_TTL_MS = 400 * 24 * 60 * 60_000;

function cfg(ctx: ConnectorCtx): YookassaConfig {
  return ctx.integration.config as YookassaConfig;
}

function bindingOf(ctx: ConnectorCtx, id: string): YookassaBinding | undefined {
  return cfg(ctx).bindings.find((b) => b.id === id);
}

async function paymentsOf(ctx: ConnectorCtx, b: YookassaBinding, recordId: string) {
  const rows = await ctx.db.list(b.paymentEntity.name, { where: { [b.paymentEntity.refField]: recordId } });
  const out: { row: Row; meta: PaymentMeta }[] = [];
  for (const row of rows) {
    const meta = await ctx.store.get<PaymentMeta>(payMetaKey(String(row.provider_payment_id)));
    if (meta?.binding === b.id) out.push({ row, meta });
  }
  return out.sort((x, y) => y.meta.createdAt.localeCompare(x.meta.createdAt));
}

/**
 * POST /api/pay/:integration {binding, id}. `record` is read by the runtime with the caller's rights
 * (null → 404); the amount always comes from it. M0: confirmation goes to the mock page.
 */
export async function startPayment(
  ctx: ConnectorCtx,
  input: { binding: string; id: string },
  record: Row | null,
): Promise<PayResult> {
  const b = bindingOf(ctx, input.binding);
  if (!b || !record) return { ok: false, status: 404, code: "NOT_FOUND", message_ru: "Заказ не найден" };
  if (record[b.statusField ?? "status"] !== b.payableStatus) {
    return {
      ok: false,
      status: 409,
      code: "NOT_PAYABLE",
      message_ru: "Заказ нельзя оплатить в текущем статусе",
    };
  }
  const amount = Number(record[b.amountField] ?? 0);
  if (!(kop(amount) > 0)) {
    return { ok: false, status: 409, code: "NOTHING_TO_PAY", message_ru: "По заказу нечего оплачивать" };
  }
  const now = ctx.now();
  for (const { row, meta } of await paymentsOf(ctx, b, record.id)) {
    const fresh = now.getTime() - Date.parse(meta.createdAt) < PENDING_REUSE_MS;
    if (row.kind === "payment" && row.status === "pending" && fresh && kop(meta.amount) === kop(amount)) {
      return { ok: true, confirmationUrl: meta.confirmationUrl, reused: true };
    }
  }
  if (ctx.mode !== "test" || ctx.system.env !== "draft") {
    throw new ConnectorError("EGRESS_DISABLED", "Приём платежей ЮKassa появится в следующей версии");
  }
  const providerId = `mock_${randomUUID()}`;
  const confirmationUrl = `/_wizard/pay-mock?binding=${encodeURIComponent(b.id)}&id=${encodeURIComponent(record.id)}`;
  await ctx.db.insert(b.paymentEntity.name, {
    [b.paymentEntity.refField]: record.id,
    provider_payment_id: providerId,
    kind: "payment",
    amount,
    status: "pending",
  });
  const meta: PaymentMeta = {
    binding: b.id,
    recordId: record.id,
    amount,
    createdAt: now.toISOString(),
    confirmationUrl,
  };
  await ctx.store.set(payMetaKey(providerId), meta, META_TTL_MS);
  return { ok: true, confirmationUrl, reused: false };
}

/**
 * payment.succeeded after the provider object was re-read (GET /payments/{id}); yookassa.yaml#webhooks.handling.
 * Idempotent by payment id.
 */
export async function applyPaymentSucceeded(
  ctx: ConnectorCtx,
  payment: ProviderPayment,
): Promise<PaymentEventResult> {
  const b = bindingOf(ctx, payment.metadata.binding);
  if (!b || payment.metadata.system !== ctx.system.id || payment.metadata.env !== ctx.system.env)
    return "ignored";
  if (payment.status !== "succeeded") return "ignored";
  const row = await ctx.db.getBy(b.paymentEntity.name, "provider_payment_id", payment.id);
  if (!row) return "ignored";
  if (row.status !== "pending") return "duplicate";
  const record = await ctx.db.get(b.entity, payment.metadata.recordId);
  const matches =
    record !== null &&
    payment.amount.currency === "RUB" &&
    kop(payment.amount.value) === kop(row.amount) &&
    row[b.paymentEntity.refField] === record.id &&
    kop(record[b.amountField]) === kop(row.amount);
  if (!matches || !record) {
    await ctx.db.patch(b.paymentEntity.name, row.id, { status: "needs_review" });
    ctx.log.log({ action: "payment.succeeded", mode: ctx.mode, status: "needs_review", durationMs: 0 });
    return "needs_review";
  }
  await ctx.db.patch(b.paymentEntity.name, row.id, { status: "succeeded" });
  await ctx.db.patch(b.entity, record.id, { [b.statusField ?? "status"]: b.paidStatus });
  if (b.receipt.settlePrepaymentOf) {
    await ctx.outbox.write(
      outboxMessage(ctx, "yookassa", "create_receipt", {
        binding: b.id,
        recordId: record.id,
        settlePrepaymentOf: b.receipt.settlePrepaymentOf,
      }),
    );
  }
  return "applied";
}

/** payment.canceled: journal → canceled; the record → canceledStatus only while still payable. */
export async function applyPaymentCanceled(
  ctx: ConnectorCtx,
  payment: ProviderPayment,
): Promise<PaymentEventResult> {
  const b = bindingOf(ctx, payment.metadata.binding);
  if (!b || payment.metadata.system !== ctx.system.id || payment.metadata.env !== ctx.system.env)
    return "ignored";
  const row = await ctx.db.getBy(b.paymentEntity.name, "provider_payment_id", payment.id);
  if (!row) return "ignored";
  if (row.status !== "pending") return "duplicate";
  await ctx.db.patch(b.paymentEntity.name, row.id, { status: "canceled" });
  const record = await ctx.db.get(b.entity, payment.metadata.recordId);
  const statusField = b.statusField ?? "status";
  if (record && record[statusField] === b.payableStatus) {
    await ctx.db.patch(b.entity, record.id, { [statusField]: b.canceledStatus });
  }
  return "applied";
}

/**
 * GET/POST /_wizard/pay-mock?binding=&id= (draft only): confirms the latest pending mock payment exactly
 * like a verified payment.succeeded. Returns the page to redirect to.
 */
export async function confirmMockPayment(
  ctx: ConnectorCtx,
  input: { binding: string; id: string },
): Promise<{ ok: true; result: PaymentEventResult; returnUrl: string } | { ok: false; status: 404 }> {
  const b = bindingOf(ctx, input.binding);
  if (!b || ctx.system.env !== "draft") return { ok: false, status: 404 };
  const pending = (await paymentsOf(ctx, b, input.id)).find(
    ({ row }) => row.kind === "payment" && row.status === "pending",
  );
  if (!pending) return { ok: false, status: 404 };
  const result = await applyPaymentSucceeded(ctx, {
    id: String(pending.row.provider_payment_id),
    status: "succeeded",
    amount: { value: (kop(pending.row.amount) / 100).toFixed(2), currency: "RUB" },
    metadata: { system: ctx.system.id, env: ctx.system.env, binding: b.id, recordId: input.id },
  });
  return { ok: true, result, returnUrl: b.returnRoute.replace(":id", encodeURIComponent(input.id)) };
}

// ---------------------------------------------------------------- actions (M0: test-mode stubs)

const refundInput = z.strictObject({
  binding: ident,
  id: z.string().min(1),
  amount: z.number().positive().optional(),
  reason: z.string().max(250).optional(),
  idempotencyKey: z.string().optional(),
});
const statusInput = z.strictObject({ binding: ident, id: z.string().min(1) });

async function refundStub(ctx: ConnectorCtx, input: z.infer<typeof refundInput>) {
  requireTestMode(ctx);
  const b = bindingOf(ctx, input.binding);
  if (!b) throw new ConnectorError("INVALID_REQUEST", `Привязка оплаты «${input.binding}» не найдена`);
  const paid = (await paymentsOf(ctx, b, input.id)).find(
    ({ row }) => row.kind === "payment" && row.status === "succeeded",
  );
  if (!paid) throw new ConnectorError("NOT_FOUND", "Оплаченный платёж не найден");
  const amount = input.amount ?? Number(paid.row.amount);
  if (kop(amount) > kop(paid.row.amount)) {
    throw new ConnectorError("INVALID_REQUEST", "Сумма возврата больше оплаченной");
  }
  const refundId = `mock_refund_${randomUUID()}`;
  await ctx.outbox.write(
    outboxMessage(ctx, "yookassa", "refund", { refundId, binding: b.id, recordId: input.id, amount }),
  );
  return { refundId, status: "pending" as const };
}

async function paymentStatus(ctx: ConnectorCtx, input: z.infer<typeof statusInput>) {
  const b = bindingOf(ctx, input.binding);
  if (!b) throw new ConnectorError("INVALID_REQUEST", `Привязка оплаты «${input.binding}» не найдена`);
  const last = (await paymentsOf(ctx, b, input.id)).find(({ row }) => row.kind === "payment");
  const s = last?.row.status;
  return s === "pending" || s === "succeeded" || s === "canceled" ? s : ("none" as const);
}

export const yookassaConnector = defineConnector({
  id: "yookassa",
  milestone: "M2",
  configSchema: yookassaConfigSchema,
  secrets: [
    { name: "yookassa_shop_id", required: true, label: "shopId магазина" },
    { name: "yookassa_secret_key", required: true, label: "Секретный ключ (test_… для тестового магазина)" },
  ],
  validateSpec: validateYookassaSpec,
  actions: {
    refund: defineAction({
      input: refundInput,
      output: z.object({ refundId: z.string(), status: z.enum(["pending", "succeeded", "canceled"]) }),
      effect: true,
      retry: { attempts: 3, baseMs: 500 },
      handler: refundStub,
    }),
    getPaymentStatus: defineAction({
      input: statusInput,
      output: z.enum(["none", "pending", "waiting_for_capture", "succeeded", "canceled"]),
      effect: false,
      retry: { attempts: 3, baseMs: 500 },
      handler: paymentStatus,
    }),
  },
  testMode: (env, config) => (env === "draft" || config.testMode === true ? "test" : "live"),
  piiFields: ["receipt.customer.email", "receipt.customer.phone"],
});
