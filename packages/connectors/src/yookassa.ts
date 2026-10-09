// YooKassa connector: specs/connectors/yookassa.yaml — G0, /api/pay (API or the draft mock), webhooks, refunds,
// 54-FZ receipts. Money goes straight to the client's shop.
import { randomUUID } from "node:crypto";
import type { AppSpec } from "@wizard/appspec";
import { z } from "zod";
import { defineAction, defineConnector } from "./define.js";
import { ConnectorError, isConnectorError, UniqueViolation } from "./errors.js";
import { ipInCidrs } from "./net.js";
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
import { secretMatches } from "./telegram.js";
import { derivedToken } from "./telegram-api.js";
import { renderTemplate } from "./templates.js";
import type { ConnectorCtx, Row, SpecCheckContext } from "./types.js";
import {
  type ApiRefund,
  cancelPayment,
  createPayment,
  createReceipt,
  createRefund,
  getPayment,
  getRefund,
  kop,
  rub,
  withRetries,
  yookassaPlatform,
} from "./yookassa-api.js";

const VAT_CODES = [1, 2, 3, 4, 5, 6, 11, 12] as const;

/**
 * V3-23: the items of a 54-FZ receipt from the rows of a line entity (an order's goods): name, quantity and the line's
 * sum; the record's delivery price (deliveryField) is one more item, a service. Without it — one item per payment.
 */
const receiptLinesSchema = z.strictObject({
  entity: ident,
  /** Ref field of a line to the binding's entity. */
  refField: ident,
  nameField: ident,
  quantityField: ident,
  /** Sum of the line (price × quantity), money. */
  amountField: ident,
});

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
    lines: receiptLinesSchema.optional(),
    /** Money field of the binding's entity: the delivery, a separate service item of the receipt. */
    deliveryField: ident.optional(),
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
  /**
   * V3-23: a string field of the record with its buyer's secret (an order of a visitor without login): POST /api/pay
   * with this value in `token` starts the payment of a record the caller cannot read. The field is hidden from every
   * role; the record's data never leaves through the payment.
   */
  accessField: ident.optional(),
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
const PAYMENT_STATUSES = ["pending", "succeeded", "canceled", "needs_review"];

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
    const lines = b.receipt.lines;
    if (lines) {
      const at = (k: string) => rel("receipt", "lines", k);
      const le = requireEntity(spec, issues, "yookassa.receipt_lines", at("entity"), lines.entity);
      if (le) {
        const ref = requireField(le, issues, "yookassa.receipt_lines_ref", at("refField"), lines.refField, [
          "ref",
        ]);
        if (ref && ref.ref?.entity !== b.entity)
          issues.add(
            "yookassa.receipt_lines_ref_target",
            at("refField"),
            `Поле «${le.name}.${ref.name}» должно ссылаться на «${b.entity}»`,
          );
        requireField(le, issues, "yookassa.receipt_lines_name", at("nameField"), lines.nameField, [
          "string",
          "text",
        ]);
        requireField(
          le,
          issues,
          "yookassa.receipt_lines_quantity",
          at("quantityField"),
          lines.quantityField,
          ["int", "decimal"],
        );
        requireField(le, issues, "yookassa.receipt_lines_amount", at("amountField"), lines.amountField, [
          "money",
        ]);
      }
    }
    if (entity && b.receipt.deliveryField)
      requireField(
        entity,
        issues,
        "yookassa.receipt_delivery",
        rel("receipt", "deliveryField"),
        b.receipt.deliveryField,
        ["money"],
      );
    if (entity && b.accessField) {
      const f = requireField(entity, issues, "yookassa.access_field", rel("accessField"), b.accessField, [
        "string",
      ]);
      if (f)
        spec.permissions.forEach((p) => {
          if (p.entity === b.entity && p.ops.includes("read") && !(p.hiddenFields ?? []).includes(f.name))
            issues.add(
              "yookassa.access_visible",
              rel("accessField"),
              `Роль «${p.role}» видит ключ доступа «${b.entity}.${f.name}»: добавьте поле в hiddenFields`,
            );
        });
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

// ---------------------------------------------------------------- payments (runtime /api/pay, mock page, webhooks)

export const PENDING_REUSE_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const META_TTL_MS = 400 * DAY_MS;
const HOOK_TTL_MS = 7 * DAY_MS;
const MOCK_PREFIX = "mock_";

export interface ProviderPayment {
  id: string;
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  amount: { value: string; currency: string };
  metadata: { system: string; env: string; binding: string; recordId: string };
  captured_at?: string;
}

/** Per provider object (`pay:<provider id>` in ctx.store): which binding and record it belongs to. */
interface PaymentMeta {
  /** Absent in M0 rows: a payment. */
  kind?: "payment" | "refund";
  binding: string;
  recordId: string;
  amount: number;
  createdAt: string;
  confirmationUrl?: string;
  paidAt?: string;
  /** Refunds: the refunded payment. */
  paymentId?: string;
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

const payMetaKey = (id: string) => `pay:${id}`;
const isMock = (providerId: unknown) => String(providerId).startsWith(MOCK_PREFIX);

function cfg(ctx: ConnectorCtx): YookassaConfig {
  return ctx.integration.config as YookassaConfig;
}

function bindingOf(ctx: ConnectorCtx, id: unknown): YookassaBinding | undefined {
  return cfg(ctx).bindings.find((b) => b.id === id);
}

const statusOf = (b: YookassaBinding) => b.statusField ?? "status";

async function paymentsOf(ctx: ConnectorCtx, b: YookassaBinding, recordId: string) {
  const rows = await ctx.db.list(b.paymentEntity.name, { where: { [b.paymentEntity.refField]: recordId } });
  const out: { row: Row; meta: PaymentMeta }[] = [];
  for (const row of rows) {
    const meta = await ctx.store.get<PaymentMeta>(payMetaKey(String(row.provider_payment_id)));
    if (meta?.binding === b.id) out.push({ row, meta });
  }
  return out.sort((x, y) => y.meta.createdAt.localeCompare(x.meta.createdAt));
}

/** Real API calls: WIZARD_CONNECTORS=live; a draft without shop keys keeps the mock flow (M0). */
async function useApi(ctx: ConnectorCtx): Promise<boolean> {
  if (!yookassaPlatform(ctx).live) return false;
  if (ctx.system.env !== "draft") return true;
  try {
    await ctx.secrets.get("yookassa_shop_id");
    await ctx.secrets.get("yookassa_secret_key");
    return true;
  } catch (e) {
    if (isConnectorError(e) && e.code === "SECRET_MISSING") return false;
    throw e;
  }
}

function originOf(host: string): string {
  return new URL(/^https?:\/\//.test(host) ? host : `https://${host}`).origin;
}

/** Binding description with {{field}} from the record (pii=none fields, G2), ≤ 128 code points. */
function describe(b: YookassaBinding, record: Row): string {
  const values: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === "string" || typeof v === "number") values[k] = v;
  }
  const text = renderTemplate(b.description, values).replace(/\s+/g, " ").trim();
  return [...text].slice(0, 128).join("") || "Оплата";
}

/** Item of a 54-FZ receipt (YooKassa: `amount` is the price of one unit). */
interface ReceiptItem {
  description: string;
  quantity: string | number;
  amount: { value: string; currency: string };
  vat_code: number;
  payment_mode: "full_prepayment" | "full_payment";
  payment_subject: "commodity" | "service";
}

/** The delivery item of a receipt with lines (a service). */
export const RECEIPT_DELIVERY_ITEM = "Доставка";

/**
 * V3-23: the receipt items of a record's lines (+ the delivery as a service) when they add up to `amount` exactly;
 * null — no lines configured, none found, or the sum differs (a partial refund): the receipt keeps one item.
 */
async function lineItems(
  ctx: ConnectorCtx,
  b: YookassaBinding,
  record: Row,
  amount: number,
  paymentMode: "full_prepayment" | "full_payment",
): Promise<ReceiptItem[] | null> {
  const l = b.receipt.lines;
  if (!l) return null;
  const rows = await ctx.db.list(l.entity, { where: { [l.refField]: record.id } });
  const items: ReceiptItem[] = [];
  let total = 0;
  for (const row of rows) {
    const qty = Number(row[l.quantityField] ?? 0);
    const sum = kop(row[l.amountField]);
    if (!(qty > 0) || !(sum > 0)) continue;
    const name = [
      ...String(row[l.nameField] ?? "")
        .replace(/\s+/g, " ")
        .trim(),
    ]
      .slice(0, 128)
      .join("");
    // A unit price in whole kopecks keeps the quantity; otherwise the line is one item of its sum.
    const whole = Number.isInteger(qty) && sum % qty === 0;
    items.push({
      description: name || "Товар",
      quantity: whole ? qty : 1,
      amount: rub((whole ? sum / qty : sum) / 100),
      vat_code: b.receipt.vatCode,
      payment_mode: paymentMode,
      payment_subject: b.receipt.paymentSubject,
    });
    total += sum;
  }
  const delivery = b.receipt.deliveryField ? kop(record[b.receipt.deliveryField]) : 0;
  if (delivery > 0) {
    items.push({
      description: RECEIPT_DELIVERY_ITEM,
      quantity: 1,
      amount: rub(delivery / 100),
      vat_code: b.receipt.vatCode,
      payment_mode: paymentMode,
      payment_subject: "service",
    });
    total += delivery;
  }
  return items.length > 0 && items.length <= 100 && total === kop(amount) ? items : null;
}

/**
 * 54-FZ receipt: customer contact from the record on the server; the record's lines when the binding names them and
 * they add up to the amount, else one item (yookassa.yaml#runtime_endpoint.receipt).
 */
async function receiptFor(
  ctx: ConnectorCtx,
  b: YookassaBinding,
  record: Row,
  amount: number,
  paymentMode: "full_prepayment" | "full_payment",
  description: string,
) {
  const customer: Record<string, string> = {};
  const r = b.receipt;
  const email = r.customerEmailField ? record[r.customerEmailField] : undefined;
  if (typeof email === "string" && email.trim()) customer.email = email.trim();
  const phone = r.customerPhoneField ? record[r.customerPhoneField] : undefined;
  const digits = typeof phone === "string" ? phone.replace(/\D/g, "") : "";
  if (digits) customer.phone = digits;
  if (!customer.email && !customer.phone) {
    throw new ConnectorError("INVALID_REQUEST", "Для чека нужен email или телефон покупателя в заказе");
  }
  const single: ReceiptItem = {
    description,
    quantity: "1",
    amount: rub(amount),
    vat_code: r.vatCode,
    payment_mode: paymentMode,
    payment_subject: r.paymentSubject,
  };
  return { customer, items: (await lineItems(ctx, b, record, amount, paymentMode)) ?? [single] };
}

/**
 * V3-23: the buyer's secret (`token` of POST /api/pay) matches the record's accessField of the binding, in constant
 * time; false when the binding has no accessField or the record no secret.
 */
export function yookassaAccessMatches(
  config: YookassaConfig,
  binding: string,
  record: Row,
  token: string,
): boolean {
  const b = config.bindings.find((x) => x.id === binding);
  const expected = b?.accessField ? record[b.accessField] : undefined;
  return (
    typeof expected === "string" && expected.length >= 16 && token !== "" && secretMatches(token, expected)
  );
}

async function ownerEvent(
  ctx: ConnectorCtx,
  event: string,
  message_ru: string,
  payload: Record<string, unknown>,
) {
  await ctx.outbox.write(outboxMessage(ctx, "yookassa", "owner_event", { event, message_ru, ...payload }));
}

/**
 * POST /api/pay/:integration {binding, id}. `record` is read by the runtime with the caller's rights (null → 404);
 * status, amount and receipt contacts come from the system's copy of the record, never from the request.
 */
export async function startPayment(
  ctx: ConnectorCtx,
  input: { binding: string; id: string },
  record: Row | null,
): Promise<PayResult> {
  const b = bindingOf(ctx, input.binding);
  if (!b || !record) return { ok: false, status: 404, code: "NOT_FOUND", message_ru: "Заказ не найден" };
  const row = (await ctx.db.get(b.entity, record.id)) ?? record;
  if (row[statusOf(b)] !== b.payableStatus) {
    return {
      ok: false,
      status: 409,
      code: "NOT_PAYABLE",
      message_ru: "Заказ нельзя оплатить в текущем статусе",
    };
  }
  const amount = Number(row[b.amountField] ?? 0);
  if (!(kop(amount) > 0)) {
    return { ok: false, status: 409, code: "NOTHING_TO_PAY", message_ru: "По заказу нечего оплачивать" };
  }
  const now = ctx.now();
  const payments = await paymentsOf(ctx, b, row.id);
  for (const { row: p, meta } of payments) {
    const fresh = now.getTime() - Date.parse(meta.createdAt) < PENDING_REUSE_MS;
    if (
      p.kind === "payment" &&
      p.status === "pending" &&
      fresh &&
      kop(meta.amount) === kop(amount) &&
      meta.confirmationUrl
    ) {
      return { ok: true, confirmationUrl: meta.confirmationUrl, reused: true };
    }
  }
  const api = await useApi(ctx);
  if (!api && (ctx.mode !== "test" || ctx.system.env !== "draft")) {
    throw new ConnectorError("EGRESS_DISABLED", "Приём платежей ЮKassa в этом окружении отключён");
  }
  let providerId: string;
  let confirmationUrl: string;
  if (api) {
    // One key per (record, binding, attempt, amount): concurrent clicks get the same YooKassa payment.
    const attempt = payments.filter((p) => p.row.kind === "payment").length;
    const key = `pay:${ctx.system.id}:${ctx.system.env}:${ctx.integration.name}:${b.id}:${row.id}:${attempt}:${kop(amount)}`;
    const description = describe(b, row);
    const body = {
      amount: rub(amount),
      capture: true,
      confirmation: {
        type: "redirect",
        return_url: `${originOf(ctx.system.host)}${b.returnRoute.replace(":id", encodeURIComponent(row.id))}`,
      },
      description,
      metadata: { system: ctx.system.id, env: ctx.system.env, binding: b.id, recordId: row.id },
      receipt: await receiptFor(ctx, b, row, amount, b.receipt.paymentMode, description),
    };
    const p = await withRetries(() => createPayment(ctx, body, key));
    const url = p.confirmation?.confirmation_url;
    if (typeof p.id !== "string" || typeof url !== "string" || !/^https?:\/\//.test(url)) {
      throw new ConnectorError("UPSTREAM_UNAVAILABLE", "ЮKassa вернула неожиданный ответ");
    }
    providerId = p.id;
    confirmationUrl = url;
  } else {
    providerId = `${MOCK_PREFIX}${randomUUID()}`;
    confirmationUrl = `/_wizard/pay-mock?binding=${encodeURIComponent(b.id)}&id=${encodeURIComponent(row.id)}`;
  }
  try {
    await ctx.db.insert(b.paymentEntity.name, {
      [b.paymentEntity.refField]: row.id,
      provider_payment_id: providerId,
      kind: "payment",
      amount,
      status: "pending",
    });
  } catch (e) {
    // A concurrent request created the same YooKassa payment (same Idempotence-Key): reuse it.
    if (!(e instanceof UniqueViolation)) throw e;
    return { ok: true, confirmationUrl, reused: true };
  }
  const meta: PaymentMeta = {
    kind: "payment",
    binding: b.id,
    recordId: row.id,
    amount,
    createdAt: now.toISOString(),
    confirmationUrl,
  };
  await ctx.store.set(payMetaKey(providerId), meta, META_TTL_MS);
  ctx.log.log({ action: "create_payment", mode: ctx.mode, status: api ? "ok" : "mock", durationMs: 0 });
  return { ok: true, confirmationUrl, reused: false };
}

/**
 * payment.succeeded after the provider object was re-read (GET /payments/{id}); yookassa.yaml#webhooks.handling.
 * Idempotent by payment id. Mismatch of amount, currency, record or the record's current amount → needs_review.
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
  if (row?.kind !== "payment") return "ignored";
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
    await ownerEvent(ctx, "payment_needs_review", "Оплата требует проверки", {
      binding: b.id,
      recordId: String(row[b.paymentEntity.refField] ?? ""),
      paymentId: payment.id,
    });
    return "needs_review";
  }
  await ctx.db.patch(b.paymentEntity.name, row.id, { status: "succeeded" });
  await ctx.db.patch(b.entity, record.id, { [statusOf(b)]: b.paidStatus });
  const meta = await ctx.store.get<PaymentMeta>(payMetaKey(payment.id));
  if (meta) {
    const paidAt = payment.captured_at && !Number.isNaN(Date.parse(payment.captured_at));
    await ctx.store.set(
      payMetaKey(payment.id),
      { ...meta, paidAt: paidAt ? payment.captured_at : ctx.now().toISOString() },
      META_TTL_MS,
    );
  }
  if (b.receipt.settlePrepaymentOf && isMock(payment.id)) {
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
  if (row?.kind !== "payment") return "ignored";
  if (row.status !== "pending") return "duplicate";
  await ctx.db.patch(b.paymentEntity.name, row.id, { status: "canceled" });
  const record = await ctx.db.get(b.entity, payment.metadata.recordId);
  if (record && record[statusOf(b)] === b.payableStatus) {
    await ctx.db.patch(b.entity, record.id, { [statusOf(b)]: b.canceledStatus });
  }
  return "applied";
}

/** Record → refundedStatus once succeeded refunds of `paymentId` cover the paid amount. */
async function settleFullRefund(ctx: ConnectorCtx, b: YookassaBinding, recordId: string, paymentId: string) {
  const all = await paymentsOf(ctx, b, recordId);
  const paid = all.find(({ row }) => row.provider_payment_id === paymentId);
  if (!paid) return;
  const refunded = all
    .filter(
      ({ row, meta }) => row.kind === "refund" && row.status === "succeeded" && meta.paymentId === paymentId,
    )
    .reduce((s, { row }) => s + kop(row.amount), 0);
  if (refunded >= kop(paid.row.amount)) {
    await ctx.db.patch(b.entity, recordId, { [statusOf(b)]: b.refundedStatus });
  }
}

/** refund.succeeded after GET /refunds/{id}: journal row {kind: refund, status: succeeded}; full → refundedStatus. */
export async function applyRefundSucceeded(
  ctx: ConnectorCtx,
  refund: ApiRefund,
): Promise<PaymentEventResult> {
  if (refund.status !== "succeeded" || refund.amount?.currency !== "RUB") return "ignored";
  const payMeta = await ctx.store.get<PaymentMeta>(payMetaKey(refund.payment_id));
  const b =
    payMeta && (payMeta.kind ?? "payment") === "payment" ? bindingOf(ctx, payMeta.binding) : undefined;
  if (!payMeta || !b) return "ignored";
  const existing = await ctx.db.getBy(b.paymentEntity.name, "provider_payment_id", refund.id);
  if (existing?.status === "succeeded") return "duplicate";
  const amount = kop(refund.amount.value) / 100;
  if (existing) {
    await ctx.db.patch(b.paymentEntity.name, existing.id, { status: "succeeded" });
  } else {
    try {
      await ctx.db.insert(b.paymentEntity.name, {
        [b.paymentEntity.refField]: payMeta.recordId,
        provider_payment_id: refund.id,
        kind: "refund",
        amount,
        status: "succeeded",
      });
    } catch (e) {
      if (e instanceof UniqueViolation) return "duplicate";
      throw e;
    }
  }
  if (!(await ctx.store.get(payMetaKey(refund.id)))) {
    const meta: PaymentMeta = {
      kind: "refund",
      binding: b.id,
      recordId: payMeta.recordId,
      amount,
      createdAt: ctx.now().toISOString(),
      paymentId: refund.payment_id,
    };
    await ctx.store.set(payMetaKey(refund.id), meta, META_TTL_MS);
  }
  await settleFullRefund(ctx, b, payMeta.recordId, refund.payment_id);
  return "applied";
}

/**
 * Closing receipt for the prepayment once the final payment succeeded (yookassa.yaml#api.calls.create_receipt,
 * #receipts_54fz.prepayment_flow). Done once per final payment; failures surface so the notification is redelivered.
 */
async function ensureSettlementReceipt(
  ctx: ConnectorCtx,
  b: YookassaBinding,
  recordId: string,
  finalId: string,
) {
  const flag = `receipt:${finalId}`;
  if (await ctx.store.get(flag)) return;
  const finalRow = await ctx.db.getBy(b.paymentEntity.name, "provider_payment_id", finalId);
  const prepayBinding = bindingOf(ctx, b.receipt.settlePrepaymentOf);
  if (finalRow?.status !== "succeeded" || !prepayBinding) return;
  const prepay = (await paymentsOf(ctx, prepayBinding, recordId)).find(
    ({ row }) => row.kind === "payment" && row.status === "succeeded" && !isMock(row.provider_payment_id),
  );
  const record = await ctx.db.get(b.entity, recordId);
  if (!prepay || !record) {
    ctx.log.log({ action: "create_receipt", mode: ctx.mode, status: "skipped", durationMs: 0 });
    await ctx.store.set(flag, { skipped: true }, META_TTL_MS);
    return;
  }
  const amount = Number(prepay.row.amount);
  const r = await receiptFor(
    ctx,
    prepayBinding,
    record,
    amount,
    "full_payment",
    describe(prepayBinding, record),
  );
  const body = {
    type: "payment",
    payment_id: String(prepay.row.provider_payment_id),
    send: true,
    customer: r.customer,
    items: r.items,
    settlements: [{ type: "prepayment", amount: rub(amount) }],
  };
  const receipt = await withRetries(() => createReceipt(ctx, body, `receipt:${ctx.system.id}:${finalId}`));
  await ctx.store.set(flag, { receiptId: receipt.id }, META_TTL_MS);
  ctx.log.log({ action: "create_receipt", mode: ctx.mode, status: "ok", durationMs: 0 });
}

/**
 * GET/POST /_wizard/pay-mock?binding=&id= (draft only): confirms the latest pending mock payment exactly
 * like a verified payment.succeeded. Real YooKassa payments are never confirmed here. Returns the page to redirect to.
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
  if (!pending || !isMock(pending.row.provider_payment_id)) return { ok: false, status: 404 };
  const result = await applyPaymentSucceeded(ctx, {
    id: String(pending.row.provider_payment_id),
    status: "succeeded",
    amount: rub(pending.row.amount),
    metadata: { system: ctx.system.id, env: ctx.system.env, binding: b.id, recordId: input.id },
  });
  return { ok: true, result, returnUrl: b.returnRoute.replace(":id", encodeURIComponent(input.id)) };
}

// ---------------------------------------------------------------- webhooks (yookassa.yaml#webhooks)

export const YOOKASSA_EVENTS = [
  "payment.succeeded",
  "payment.canceled",
  "payment.waiting_for_capture",
  "refund.succeeded",
] as const;

export type NotificationResult = PaymentEventResult | "pending" | "capture_canceled" | "invalid";

/** <hookToken> of /_wizard/hooks/yookassa/<integration>/<hookToken>: derived from the shop's secret key. */
export async function yookassaHookToken(ctx: ConnectorCtx): Promise<string> {
  return derivedToken(await ctx.secrets.get("yookassa_secret_key"), `yookassa-hook:${ctx.integration.name}`);
}

/** URL the client pastes into the YooKassa dashboard (Интеграция → HTTP-уведомления). */
export async function yookassaWebhookUrl(ctx: ConnectorCtx): Promise<string> {
  const name = encodeURIComponent(ctx.integration.name);
  return `${originOf(ctx.system.host)}/_wizard/hooks/yookassa/${name}/${await yookassaHookToken(ctx)}`;
}

/** Source address check of a notification (the caller passes the trusted-ingress client IP). */
export function yookassaSourceAllowed(ctx: Pick<ConnectorCtx, "platform">, ip: string | null): boolean {
  return ip !== null && ipInCidrs(ip, yookassaPlatform(ctx).ipAllowlist);
}

/** Only {event, object.id} of the body are used: the object itself is re-read from the API. */
export function parseYookassaNotification(body: unknown): { event: string; objectId: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as { type?: unknown; event?: unknown; object?: { id?: unknown } };
  if (b.type !== "notification" || typeof b.event !== "string" || b.event.length > 64) return null;
  const id = b.object?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { event: b.event, objectId: id };
}

async function onPayment(ctx: ConnectorCtx, id: string): Promise<NotificationResult> {
  const p = await withRetries(() => getPayment(ctx, id));
  const md = p.metadata ?? {};
  const b = bindingOf(ctx, md.binding);
  if (
    p.id !== id ||
    !b ||
    md.system !== ctx.system.id ||
    md.env !== ctx.system.env ||
    typeof md.recordId !== "string"
  ) {
    return "ignored";
  }
  const payment: ProviderPayment = {
    id: p.id,
    status: p.status,
    amount: p.amount,
    metadata: { system: md.system, env: md.env, binding: b.id, recordId: md.recordId },
    ...(p.captured_at ? { captured_at: p.captured_at } : {}),
  };
  switch (p.status) {
    case "succeeded": {
      const r = await applyPaymentSucceeded(ctx, payment);
      if ((r === "applied" || r === "duplicate") && b.receipt.settlePrepaymentOf) {
        await ensureSettlementReceipt(ctx, b, md.recordId, p.id);
      }
      return r;
    }
    case "canceled":
      return applyPaymentCanceled(ctx, payment);
    case "waiting_for_capture":
      // capture:true is always sent, so this is unexpected: release the money (yookassa.yaml#webhooks.handling).
      await withRetries(() => cancelPayment(ctx, p.id, `cancel:${ctx.system.id}:${p.id}`));
      ctx.log.log({
        action: "payment.waiting_for_capture",
        mode: ctx.mode,
        status: "canceled",
        durationMs: 0,
      });
      return "capture_canceled";
    default:
      return "pending";
  }
}

async function onRefund(ctx: ConnectorCtx, id: string): Promise<NotificationResult> {
  const rf = await withRetries(() => getRefund(ctx, id));
  if (rf.id !== id) return "ignored";
  if (rf.status === "succeeded") return applyRefundSucceeded(ctx, rf);
  if (rf.status === "canceled") {
    const meta = await ctx.store.get<PaymentMeta>(payMetaKey(rf.id));
    const b = meta ? bindingOf(ctx, meta.binding) : undefined;
    const row = b ? await ctx.db.getBy(b.paymentEntity.name, "provider_payment_id", rf.id) : null;
    if (!b || !row) return "ignored";
    if (row.status !== "pending") return "duplicate";
    await ctx.db.patch(b.paymentEntity.name, row.id, { status: "canceled" });
    return "applied";
  }
  return "pending";
}

/**
 * Verified notification (source IP and hookToken already checked by the runtime): the object is re-read with the
 * shop's keys and only the API answer decides. Idempotent by event + object id. Throws on API failures (→ 500,
 * YooKassa redelivers for 24 h).
 */
export async function handleYookassaNotification(
  ctx: ConnectorCtx,
  body: unknown,
): Promise<{ status: number; result: NotificationResult }> {
  const n = parseYookassaNotification(body);
  if (!n) return { status: 400, result: "invalid" };
  if (!(YOOKASSA_EVENTS as readonly string[]).includes(n.event)) return { status: 200, result: "ignored" };
  const doneKey = `hook:${n.event}:${n.objectId}`;
  if (await ctx.store.get(doneKey)) return { status: 200, result: "duplicate" };
  let result: NotificationResult;
  try {
    result = n.event.startsWith("refund.")
      ? await onRefund(ctx, n.objectId)
      : await onPayment(ctx, n.objectId);
  } catch (e) {
    // Not in this shop: a forged or foreign notification.
    if (!isConnectorError(e) || e.code !== "NOT_FOUND") throw e;
    result = "ignored";
  }
  if (result !== "pending") await ctx.store.set(doneKey, { result }, HOOK_TTL_MS);
  ctx.log.log({ action: n.event, mode: ctx.mode, status: result, durationMs: 0 });
  return { status: 200, result };
}

/** How often one record's payment may be re-read on the buyer's return (yookassa.yaml#return_check). */
export const RETURN_CHECK_MS = 10_000;
export type ReturnCheckResult = NotificationResult | "none" | "throttled";

/**
 * Return check (V3-23, yookassa.yaml#return_check): the buyer is back from the payment page and the notice of ЮKassa
 * may be late or never come (the shop's HTTP-notification URL not set). The record's latest pending payment is re-read
 * with the shop's keys and applied exactly as a verified notification would (onPayment: the API answer alone decides,
 * metadata and amount checked); idempotent, at most once per RETURN_CHECK_MS for a record. Mock payments and draft
 * shops are left to /_wizard/pay-mock.
 */
export async function checkPaymentOnReturn(
  ctx: ConnectorCtx,
  input: { binding: string; id: string },
): Promise<ReturnCheckResult> {
  const b = bindingOf(ctx, input.binding);
  if (!b) return "none";
  const last = (await paymentsOf(ctx, b, input.id)).find(({ row }) => row.kind === "payment");
  if (!last || last.row.status !== "pending") return "none";
  const providerId = String(last.row.provider_payment_id ?? "");
  if (!providerId || isMock(providerId) || !(await useApi(ctx))) return "none";
  const gate = `return-check:${b.id}:${input.id}`;
  if (await ctx.store.get(gate)) return "throttled";
  await ctx.store.set(gate, { at: Date.now() }, RETURN_CHECK_MS);
  let result: ReturnCheckResult;
  try {
    result = await onPayment(ctx, providerId);
  } catch (e) {
    if (!isConnectorError(e) || e.code !== "NOT_FOUND") throw e;
    result = "ignored";
  }
  ctx.log.log({ action: "return_check", mode: ctx.mode, status: result, durationMs: 0 });
  return result;
}

// ---------------------------------------------------------------- actions

const refundInput = z.strictObject({
  binding: ident,
  id: z.string().min(1),
  amount: z.number().positive().optional(),
  reason: z.string().max(250).optional(),
  idempotencyKey: z.string().optional(),
});
const statusInput = z.strictObject({ binding: ident, id: z.string().min(1) });

/** refund(): within refundWindowDays of the payment, partial ≤ what is left (yookassa.yaml#actions.refund). */
async function refund(ctx: ConnectorCtx, input: z.infer<typeof refundInput>) {
  const b = bindingOf(ctx, input.binding);
  if (!b) throw new ConnectorError("INVALID_REQUEST", `Привязка оплаты «${input.binding}» не найдена`);
  const all = await paymentsOf(ctx, b, input.id);
  const paid = all.find(({ row }) => row.kind === "payment" && row.status === "succeeded");
  if (!paid) throw new ConnectorError("NOT_FOUND", "Оплаченный платёж не найден");
  const days = cfg(ctx).refundWindowDays;
  const paidAt = Date.parse(paid.meta.paidAt ?? paid.meta.createdAt);
  if (ctx.now().getTime() - paidAt > days * DAY_MS) {
    throw new ConnectorError(
      "INVALID_REQUEST",
      `Срок возврата истёк: возврат возможен ${days} дн. после оплаты`,
    );
  }
  const paymentId = String(paid.row.provider_payment_id);
  const taken = all
    .filter(
      ({ row, meta }) =>
        row.kind === "refund" &&
        meta.paymentId === paymentId &&
        (row.status === "pending" || row.status === "succeeded"),
    )
    .reduce((s, { row }) => s + kop(row.amount), 0);
  const left = kop(paid.row.amount) - taken;
  if (left <= 0) throw new ConnectorError("INVALID_REQUEST", "Платёж уже полностью возвращён");
  const amount = input.amount ?? left / 100;
  if (kop(amount) > left) throw new ConnectorError("INVALID_REQUEST", "Сумма возврата больше оплаченной");

  let refundId: string;
  let status: "pending" | "succeeded" | "canceled";
  if (isMock(paymentId)) {
    requireTestMode(ctx);
    refundId = `${MOCK_PREFIX}refund_${randomUUID()}`;
    status = "succeeded";
    await ctx.outbox.write(
      outboxMessage(ctx, "yookassa", "refund", { refundId, binding: b.id, recordId: input.id, amount }),
    );
  } else {
    if (!yookassaPlatform(ctx).live) {
      throw new ConnectorError("EGRESS_DISABLED", "Возвраты ЮKassa в этом окружении отключены");
    }
    const record = await ctx.db.get(b.entity, input.id);
    if (!record) throw new ConnectorError("NOT_FOUND", "Заказ не найден");
    const body: Record<string, unknown> = {
      payment_id: paymentId,
      amount: rub(amount),
      receipt: await receiptFor(ctx, b, record, amount, b.receipt.paymentMode, describe(b, record)),
    };
    if (input.reason) body.description = input.reason;
    const rf = await createRefund(ctx, body, `refund:${ctx.system.id}:${ctx.idempotencyKey}`);
    refundId = rf.id;
    status = rf.status;
  }
  const existing = await ctx.db.getBy(b.paymentEntity.name, "provider_payment_id", refundId);
  if (existing) {
    await ctx.db.patch(b.paymentEntity.name, existing.id, { status });
  } else {
    await ctx.db.insert(b.paymentEntity.name, {
      [b.paymentEntity.refField]: input.id,
      provider_payment_id: refundId,
      kind: "refund",
      amount: kop(amount) / 100,
      status,
    });
  }
  const meta: PaymentMeta = {
    kind: "refund",
    binding: b.id,
    recordId: input.id,
    amount: kop(amount) / 100,
    createdAt: ctx.now().toISOString(),
    paymentId,
  };
  await ctx.store.set(payMetaKey(refundId), meta, META_TTL_MS);
  if (status === "succeeded") await settleFullRefund(ctx, b, input.id, paymentId);
  return { refundId, status };
}

async function paymentStatus(ctx: ConnectorCtx, input: z.infer<typeof statusInput>) {
  const b = bindingOf(ctx, input.binding);
  if (!b) throw new ConnectorError("INVALID_REQUEST", `Привязка оплаты «${input.binding}» не найдена`);
  const last = (await paymentsOf(ctx, b, input.id)).find(({ row }) => row.kind === "payment");
  const s = last?.row.status;
  if (s === "pending" && last && !isMock(last.row.provider_payment_id) && yookassaPlatform(ctx).live) {
    return (await getPayment(ctx, String(last.row.provider_payment_id))).status;
  }
  // needs_review: the shop has the money, the order is not accepted as paid yet.
  if (s === "needs_review") return "pending" as const;
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
      handler: refund,
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
