import { query, v } from "@wizard/sdk";
import { quote } from "./lib/pricing";

// Конфигуратор пересчитывает цену на каждый выбор; неполный выбор — не ошибка, а список missing.
export default query({
  args: {
    productId: v.id("product"),
    optionIds: v.array(v.id("product_option"), { max: 30 }),
  },
  handler: async (ctx, { productId, optionIds }) => {
    const q = await quote(ctx, productId, optionIds);
    return { total: q.total, prepay: q.prepay, remaining: q.remaining, missing: q.missing, lines: q.lines };
  },
});
