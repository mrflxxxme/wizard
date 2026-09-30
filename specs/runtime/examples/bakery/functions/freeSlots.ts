import { query, v } from "@wizard/sdk";
import { moscowDate, taken } from "./lib/load";

// Производственные дни с сегодняшнего (по Москве) на `days` вперёд: ёмкость, занято, свободно.
// Нужна и конфигуратору (выбор даты), и доске производства (загрузка).
export default query({
  args: { days: v.optional(v.int({ min: 1, max: 60 })) },
  handler: async (ctx, { days = 30 }) => {
    const slots = await ctx.db.production_slot.list({
      where: { slot_date: { gte: moscowDate(ctx.now), lte: moscowDate(ctx.now, days - 1) } },
      limit: 100,
    });
    return Promise.all(
      slots.map(async (s) => {
        const busy = await taken(ctx, s.id);
        const closed = s.closed === true;
        return {
          id: s.id,
          date: s.slot_date,
          capacity: s.capacity,
          taken: busy,
          closed,
          free: closed ? 0 : Math.max(s.capacity - busy, 0),
        };
      }),
    );
  },
});
