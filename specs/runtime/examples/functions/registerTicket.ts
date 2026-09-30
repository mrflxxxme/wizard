import { mutation, v } from "@wizard/sdk";
import { occupied } from "./lib/occupancy";

const EVENT_STARTS_AT = "2026-11-14T06:30:00.000Z"; // 14 ноября, 09:30 по Москве

// SERIALIZABLE-транзакция: при гонке runtime повторит handler, лимит не будет превышен.
// Участник не имеет права create на ticket, поэтому обойти лимит через data API нельзя;
// запись идёт через systemDb только после всех проверок.
export default mutation({
  args: {
    ticketTypeId: v.id("ticket_type"),
    streamId: v.id("stream"),
    holderName: v.string({ min: 2, max: 200 }),
    holderEmail: v.email(),
    holderPhone: v.optional(v.phone()),
    promoCode: v.optional(v.string({ max: 40 })),
  },
  handler: async (ctx, a) => {
    const userId = ctx.user.id;
    if (!userId) throw ctx.error("UNAUTHENTICATED", { message: "Войдите, чтобы оформить билет" });
    const type = await ctx.db.ticket_type.get(a.ticketTypeId);
    const stream = await ctx.db.stream.get(a.streamId);
    if (!type?.active || !stream) throw ctx.error("NOT_FOUND", { message: "Билет или поток не найден" });

    if ((await occupied(ctx, { stream: stream.id })) >= stream.capacity) {
      throw ctx.error("STREAM_FULL", { message: `В потоке «${stream.name}» не осталось мест` });
    }
    if ((await occupied(ctx, { ticket_type: type.id })) >= type.capacity) {
      throw ctx.error("SOLD_OUT", { message: `Билеты «${type.name}» закончились` });
    }

    let free = false;
    if (a.promoCode) {
      const quota = await ctx.systemDb.partner_quota.getBy("promo_code", a.promoCode.trim().toUpperCase());
      if (!quota || quota.ticket_type !== type.id) throw ctx.error("PROMO_INVALID", { message: "Промокод не подходит к этому билету" });
      if (quota.used >= quota.total) throw ctx.error("QUOTA_EXHAUSTED", { message: "Квота партнёра исчерпана" });
      await ctx.systemDb.partner_quota.patch(quota.id, { used: quota.used + 1 });
      free = true;
    } else if (type.kind === "partner") {
      throw ctx.error("PROMO_REQUIRED", { message: "Для партнёрского билета нужен промокод" });
    }

    const ticketId = await ctx.systemDb.ticket.insert({
      ticket_type: type.id,
      stream: stream.id,
      holder_user: userId,
      holder_name: a.holderName.trim(),
      holder_email: a.holderEmail,
      holder_phone: a.holderPhone ?? null,
      status: free ? "issued" : "pending_payment",
      amount: free ? 0 : type.price,
      promo_code: a.promoCode ?? null,
      event_starts_at: EVENT_STARTS_AT,
    });
    return { ticketId, needsPayment: !free };
  },
});
