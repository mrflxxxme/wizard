import { query } from "@wizard/sdk";
import { occupied } from "./lib/occupancy";

// Публичная витрина билетов: цена и остаток мест, без данных владельцев.
export default query({
  args: {},
  handler: async (ctx) => {
    const types = await ctx.db.ticket_type.list({ where: { active: true }, limit: 20 });
    return Promise.all(
      types.map(async (t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        price: t.price,
        description: t.description,
        left: Math.max(t.capacity - (await occupied(ctx, { ticket_type: t.id })), 0),
      })),
    );
  },
});
