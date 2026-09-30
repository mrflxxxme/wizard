import { mutation, v } from "@wizard/sdk";
import { taken } from "./lib/load";
import { missingMessage, quote } from "./lib/pricing";

// SERIALIZABLE-транзакция: две гонки за последний торт дня не пройдут обе, runtime повторит handler.
// У покупателя нет права create на cake_order: сумму и номер ставит только эта функция, запись — через systemDb.
// Оплата предоплаты — отдельно, usePayment("yookassa").pay("prepay", orderId) по биндингу из AppSpec.
export default mutation({
  args: {
    productId: v.id("product"),
    optionIds: v.array(v.id("product_option"), { max: 30 }),
    slotId: v.id("production_slot"),
    fulfillment: v.enum("pickup", "delivery"),
    customerName: v.string({ min: 2, max: 120 }),
    customerPhone: v.phone(),
    customerEmail: v.optional(v.email()),
    address: v.optional(v.string({ max: 300 })),
    inscription: v.optional(v.string({ max: 60 })),
    note: v.optional(v.string({ max: 1000 })),
  },
  handler: async (ctx, a) => {
    const userId = ctx.user.id;
    if (!userId) throw ctx.error("UNAUTHENTICATED", { message: "Войдите, чтобы оформить заказ" });

    const price = await quote(ctx, a.productId, a.optionIds);
    if (price.missing.length > 0) throw ctx.error("OPTION_REQUIRED", { message: missingMessage(price.missing) });
    const address = a.address?.trim() || null;
    if (a.fulfillment === "delivery" && !address) {
      throw ctx.error("ADDRESS_REQUIRED", { message: "Укажите адрес доставки" });
    }

    const slot = await ctx.db.production_slot.get(a.slotId);
    if (!slot) throw ctx.error("NOT_FOUND", { message: "Дата готовности не найдена" });
    if (slot.closed) throw ctx.error("SLOT_CLOSED", { message: "В этот день кондитерская не работает" });
    if ((await taken(ctx, slot.id)) >= slot.capacity) {
      throw ctx.error("SLOT_FULL", { message: "На этот день производство загружено полностью, выберите другую дату" });
    }

    const last = await ctx.systemDb.cake_order.first({ where: { number: { gte: 1 } }, order: "desc" });
    const number = (last?.number ?? 0) + 1;
    const orderId = await ctx.systemDb.cake_order.insert({
      number,
      customer_user: userId,
      product: a.productId,
      options: price.lines.map((l) => ({ id: l.id, group: l.group, title: l.title, price: l.price })),
      inscription: a.inscription?.trim() || null,
      slot: slot.id,
      fulfillment: a.fulfillment,
      customer_name: a.customerName.trim(),
      customer_phone: a.customerPhone,
      customer_email: a.customerEmail ?? null,
      address: a.fulfillment === "delivery" ? address : null,
      total: price.total,
      prepay_amount: price.prepay,
      remaining_amount: price.remaining,
      status: "pending_payment",
      note: a.note?.trim() || null,
    });
    ctx.log.info("order_placed", { number, total: price.total });
    return { orderId, number, total: price.total, prepay: price.prepay, remaining: price.remaining };
  },
});
