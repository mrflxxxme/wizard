import type { Doc, Id, QueryCtx } from "@wizard/sdk";

type Status = Doc<"cake_order">["status"];

/** Неоплаченный заказ держит место в производственном дне 30 минут — столько живёт платёж ЮKassa. */
export const HOLD_MINUTES = 30;
/** Заказы, которые занимают производство; отменённые и возвращённые место освобождают. */
const BUSY: readonly Status[] = ["prepaid", "in_production", "ready", "completed"];

/**
 * Сколько тортов уже стоит на производственный день. Считает по всем заказам, поэтому нужен
 * systemDb (покупатель видит только свои); наружу отдаётся только число, без ПДн.
 */
export async function taken(ctx: Pick<QueryCtx, "systemDb" | "now">, slot: Id<"production_slot">): Promise<number> {
  let n = 0;
  for (const status of BUSY) n += await ctx.systemDb.cake_order.count({ where: { slot, status } });
  const since = new Date(ctx.now.getTime() - HOLD_MINUTES * 60_000).toISOString();
  const pending = await ctx.systemDb.cake_order.list({ where: { slot, status: "pending_payment" }, limit: 1000 });
  return n + pending.filter((o) => o.created_at >= since).length;
}

/** Дата YYYY-MM-DD по Москве: производственный день кондитерской. */
export function moscowDate(d: Date, plusDays = 0): string {
  const shifted = new Date(d.getTime() + plusDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(shifted);
}
