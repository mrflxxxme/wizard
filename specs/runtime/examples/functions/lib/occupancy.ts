import type { Doc, Id, QueryCtx } from "@wizard/sdk";

type Status = Doc<"ticket">["status"];
type Scope = { stream: Id<"stream"> } | { ticket_type: Id<"ticket_type"> };

/** Неоплаченная бронь держит место 30 минут, затем место снова свободно. */
export const HOLD_MINUTES = 30;

/**
 * Занятые места в потоке или типе билета: оплаченные, выданные по квоте и свежие брони.
 * Считает по всем билетам, поэтому нужен systemDb; наружу отдаётся только число.
 */
export async function occupied(ctx: Pick<QueryCtx, "systemDb" | "now">, scope: Scope): Promise<number> {
  const since = new Date(ctx.now.getTime() - HOLD_MINUTES * 60_000).toISOString();
  const count = (status: Status, fresh = false) =>
    ctx.systemDb.ticket.count({ where: fresh ? { ...scope, status, created_at: { gte: since } } : { ...scope, status } });
  return (await count("paid")) + (await count("issued")) + (await count("pending_payment", true));
}
